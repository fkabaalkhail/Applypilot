"""
Settings endpoints, clients configure everything from the UI.

GET   /settings, return current user's settings (password masked)
PUT   /settings, update settings
POST  /settings/resume, upload resume file
POST  /settings/cookies, upload LinkedIn session cookies (skip password login)
GET   /settings/unsubscribe-alerts, confirm page for turning off match alerts (token, no login)
POST  /settings/unsubscribe-alerts, turn them off (the page's button, and RFC 8058 one-click)
"""

import html
import os
import logging
from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import User, UserSettings
from backend.auth.dependencies import get_verified_user_id
from backend.schemas.settings import SettingsUpdate, SettingsOut
from backend.services.alert_unsubscribe import UNSUBSCRIBE_PATH, make_token, verify_token
from backend.services.crypto import encrypt, decrypt
from backend.services.profile_version import bump_profile_version

logger = logging.getLogger(__name__)
router = APIRouter()

RESUME_DIR = Path("data/resumes")


def _get_or_create_settings(db: Session, user_id: int) -> UserSettings:
    """Get the user's settings row, or create it if it doesn't exist."""
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if not settings:
        settings = UserSettings(user_id=user_id)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def _settings_to_out(s: UserSettings) -> SettingsOut:
    """Convert DB model to response schema."""
    return SettingsOut(
        linkedin_email=s.linkedin_email or "",
        linkedin_password_set=bool(s.linkedin_password_encrypted),
        linkedin_cookies_set=bool(s.linkedin_cookies),
        first_name=s.first_name or "",
        last_name=s.last_name or "",
        email=s.email or "",
        phone=s.phone or "",
        city=s.city or "",
        linkedin_url=s.linkedin_url or "",
        website=s.website or "",
        resume_uploaded=bool(s.resume_file_path and Path(s.resume_file_path).exists()),
        resume_file_name=Path(s.resume_file_path).name if s.resume_file_path else "",
        job_title=s.job_title or "",
        location=s.location or "",
        remote_only=bool(s.remote_only),
        max_applications_per_run=s.max_applications_per_run or 25,
        experience_levels=[x for x in (s.experience_levels or "").split(",") if x],
        work_type=s.work_type or "",
        regions=[x for x in (s.regions or "").split(",") if x],
        prefilled_answers=s.prefilled_answers or {},
        # Smart filter settings
        company_blacklist=s.company_blacklist or [],
        keyword_blacklist=s.keyword_blacklist or [],
        min_salary=s.min_salary,
        max_salary=s.max_salary,
        min_experience_years=s.min_experience_years,
        max_experience_years=s.max_experience_years,
        # Autopilot settings
        autopilot_enabled=bool(s.autopilot_enabled),
        daily_apply_limit=s.daily_apply_limit or 50,
        weekly_apply_limit=s.weekly_apply_limit or 200,
        apply_delay_min=s.apply_delay_min or 30.0,
        apply_delay_max=s.apply_delay_max or 120.0,
        # UX toggles
        pause_before_submit=bool(s.pause_before_submit),
        follow_companies=bool(s.follow_companies),
        smooth_scrolling=bool(s.smooth_scrolling),
        # HR outreach
        hr_outreach_enabled=bool(s.hr_outreach_enabled),
        hr_daily_connect_limit=s.hr_daily_connect_limit or 10,
        # AI features
        resume_tailoring_enabled=bool(s.resume_tailoring_enabled),
        # Opt-out: only an explicit FALSE is off.
        match_alerts_enabled=s.match_alerts_enabled is not False,
    )


@router.get("", response_model=SettingsOut)
def get_settings(
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Return current user's settings. Password is never sent, only whether it's set."""
    return _settings_to_out(_get_or_create_settings(db, user_id))


@router.put("", response_model=SettingsOut)
def update_settings(
    update: SettingsUpdate,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Update settings. Only provided fields are changed."""
    s = _get_or_create_settings(db, user_id)

    if update.linkedin_email is not None:
        s.linkedin_email = update.linkedin_email
    if update.linkedin_password is not None:
        s.linkedin_password_encrypted = encrypt(update.linkedin_password)
    if update.linkedin_cookie is not None:
        s.linkedin_cookies = encrypt(update.linkedin_cookie)
    if update.first_name is not None:
        s.first_name = update.first_name
    if update.last_name is not None:
        s.last_name = update.last_name
    if update.email is not None:
        s.email = update.email
    if update.phone is not None:
        s.phone = update.phone
    if update.city is not None:
        s.city = update.city
    if update.linkedin_url is not None:
        s.linkedin_url = update.linkedin_url
    if update.website is not None:
        s.website = update.website
    if update.job_title is not None:
        s.job_title = update.job_title
    if update.location is not None:
        s.location = update.location
    if update.remote_only is not None:
        s.remote_only = 1 if update.remote_only else 0
    if update.max_applications_per_run is not None:
        s.max_applications_per_run = update.max_applications_per_run
    if update.experience_levels is not None:
        s.experience_levels = ",".join(update.experience_levels)
    if update.work_type is not None:
        s.work_type = update.work_type
    if update.regions is not None:
        s.regions = ",".join(update.regions)
    if update.prefilled_answers is not None:
        # Merge, never replace. This map is user-owned data, the Profile card
        # stores the work-authorization/sponsorship/salary answers the extension
        # autofills into real applications. A wholesale overwrite by any client
        # sending only its own keys (SetupWizard sends job_types/work_authorization)
        # would silently destroy them. Reassign so SQLAlchemy sees the JSON change.
        merged = dict(s.prefilled_answers or {})
        merged.update(update.prefilled_answers)
        s.prefilled_answers = merged
    # Smart filter settings
    if update.company_blacklist is not None:
        s.company_blacklist = update.company_blacklist
    if update.keyword_blacklist is not None:
        s.keyword_blacklist = update.keyword_blacklist
    if update.min_salary is not None:
        s.min_salary = update.min_salary
    if update.max_salary is not None:
        s.max_salary = update.max_salary
    if update.min_experience_years is not None:
        s.min_experience_years = update.min_experience_years
    if update.max_experience_years is not None:
        s.max_experience_years = update.max_experience_years
    # Autopilot settings
    if update.autopilot_enabled is not None:
        s.autopilot_enabled = 1 if update.autopilot_enabled else 0
    if update.daily_apply_limit is not None:
        s.daily_apply_limit = update.daily_apply_limit
    if update.weekly_apply_limit is not None:
        s.weekly_apply_limit = update.weekly_apply_limit
    if update.apply_delay_min is not None:
        s.apply_delay_min = update.apply_delay_min
    if update.apply_delay_max is not None:
        s.apply_delay_max = update.apply_delay_max
    # UX toggles
    if update.pause_before_submit is not None:
        s.pause_before_submit = 1 if update.pause_before_submit else 0
    if update.follow_companies is not None:
        s.follow_companies = 1 if update.follow_companies else 0
    if update.smooth_scrolling is not None:
        s.smooth_scrolling = 1 if update.smooth_scrolling else 0
    # HR outreach
    if update.hr_outreach_enabled is not None:
        s.hr_outreach_enabled = 1 if update.hr_outreach_enabled else 0
    if update.hr_daily_connect_limit is not None:
        s.hr_daily_connect_limit = update.hr_daily_connect_limit
    # AI features
    if update.resume_tailoring_enabled is not None:
        s.resume_tailoring_enabled = 1 if update.resume_tailoring_enabled else 0
    # Match-alert emails
    if update.match_alerts_enabled is not None:
        s.match_alerts_enabled = bool(update.match_alerts_enabled)

    db.commit()
    db.refresh(s)

    # Settings are a sync target, bump so the extension picks up the change.
    bump_profile_version(db, user_id)
    return _settings_to_out(s)


@router.post("/resume", response_model=SettingsOut)
async def upload_resume(
    file: UploadFile = File(...),
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Upload a resume file (PDF/DOCX) to be used by the bot during applications."""
    # Validate by both MIME type and file extension for robustness
    allowed_mimes = {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    allowed_extensions = {".pdf", ".docx"}
    ext = os.path.splitext(file.filename or "")[1].lower()
    if file.content_type not in allowed_mimes and ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail="Only PDF and DOCX files are accepted.",
        )

    RESUME_DIR.mkdir(parents=True, exist_ok=True)
    filename = file.filename or "resume.pdf"
    save_path = RESUME_DIR / filename

    # File size limit: 10 MB
    MAX_FILE_SIZE = 10 * 1024 * 1024
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 10 MB.")
    save_path.write_bytes(content)

    s = _get_or_create_settings(db, user_id)
    s.resume_file_path = str(save_path)
    db.commit()
    db.refresh(s)

    bump_profile_version(db, user_id)
    logger.info("Resume uploaded: %s (%d bytes)", save_path, len(content))
    return _settings_to_out(s)


@router.post("/cookies", response_model=SettingsOut)
async def upload_cookies(
    cookies: str,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """
    Store LinkedIn session cookies to skip password login entirely.

    The client exports cookies from their browser (e.g. via EditThisCookie extension)
    and pastes the JSON string here. The bot will inject these cookies
    instead of going through the login flow.
    """
    s = _get_or_create_settings(db, user_id)
    s.linkedin_cookies = encrypt(cookies)
    db.commit()
    db.refresh(s)

    logger.info("LinkedIn cookies saved")
    return _settings_to_out(s)


# ─── Match-alert unsubscribe ─────────────────────────────────────────────────

# The unsubscribe pages are the only HTML this API serves outside the docs.
# They need inline styles and one same-origin form (the confirm button), and
# nothing else: no scripts, no images. main.py's security middleware leaves a
# CSP set here alone for this path.
_UNSUBSCRIBE_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)

_FONT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
_BUTTON_STYLE = (
    "display: inline-block; padding: 10px 22px; border: 0; border-radius: 9999px; "
    "background-color: #533afd; color: #ffffff; font-family: inherit; "
    "font-size: 14px; text-decoration: none; cursor: pointer;"
)


def _unsubscribe_page(
    title: str, message: str, status_code: int, confirm_token: str = ""
) -> HTMLResponse:
    """A small, self-contained page in the alert email's style.

    With confirm_token it asks instead of telling: one button that POSTs the
    token back to this same path.
    """
    if confirm_token:
        action = html.escape(f"{UNSUBSCRIBE_PATH}?{urlencode({'token': confirm_token})}", quote=True)
        cta = (
            f'<form method="post" action="{action}" style="margin: 0;">'
            f'<button type="submit" style="{_BUTTON_STYLE}">Unsubscribe</button>'
            "</form>"
        )
    else:
        cta = f'<a href="/app" style="{_BUTTON_STYLE}">Open Tailrd</a>'
    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{html.escape(title)} | Tailrd</title>
</head>
<body style="margin: 0; padding: 48px 16px; background-color: #f6f9fc; font-family: {_FONT}; color: #0d253d;">
<main style="max-width: 440px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e3e8ee; border-radius: 16px; padding: 28px 24px;">
<h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 400; line-height: 1.25;">{html.escape(title)}</h1>
<p style="margin: 0 0 22px; font-size: 15px; font-weight: 300; line-height: 1.5; color: #64748d;">{html.escape(message)}</p>
{cta}
</main>
</body>
</html>"""
    return HTMLResponse(
        body,
        status_code=status_code,
        headers={"Content-Security-Policy": _UNSUBSCRIBE_CSP, "Cache-Control": "no-store"},
    )


@router.api_route("/unsubscribe-alerts", methods=["GET", "POST"], include_in_schema=False)
def unsubscribe_alerts(request: Request, token: str = "", db: Session = Depends(get_db)):
    """Turn off match-alert emails for the account the token names.

    Unauthenticated on purpose: the token is the credential (see
    services/alert_unsubscribe). POST unsubscribes. It is what a mail client's
    own "Unsubscribe" button (Gmail, Yahoo) sends to the List-Unsubscribe URL
    (RFC 8058 one-click: body "List-Unsubscribe=One-Click", no cookies), and
    what the button on the GET page sends. Idempotent.

    GET, the footer link, only asks. Mail security scanners (Microsoft Defender
    Safe Links, Proofpoint, Mimecast: what most university inboxes run) open
    every link in a message to vet it, with no person involved. If GET
    unsubscribed, those scanners would quietly switch alerts off for whole
    schools on delivery. A person reads the page and presses the button; a
    scanner doesn't. This is the split RFC 8058 describes for the same reason.
    """
    user_id = verify_token(token)
    if user_id is None:
        return _unsubscribe_page(
            "This link doesn't work",
            "This unsubscribe link is invalid. You can turn match alerts off any "
            "time in Tailrd, under Settings.",
            400,
        )

    # A deleted account has nothing left to email; don't create a row for it.
    account = db.query(User.id).filter(User.id == user_id).first() is not None
    settings = (
        db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
        if account else None
    )
    already_off = not account or (
        settings is not None and settings.match_alerts_enabled is False
    )

    if request.method == "GET" and not already_off:
        return _unsubscribe_page(
            "Unsubscribe from match alerts?",
            "You'll stop getting emails about new jobs that strongly match your "
            "résumé. You can turn them back on any time in Tailrd, under Settings.",
            200,
            confirm_token=make_token(user_id),
        )

    if not already_off:
        s = settings or _get_or_create_settings(db, user_id)
        s.match_alerts_enabled = False
        db.commit()
        logger.info("Match alerts turned off for user %s via unsubscribe link.", user_id)

    return _unsubscribe_page(
        "You're unsubscribed",
        "You won't get any more match alert emails from Tailrd. Changed your "
        "mind? Turn match alerts back on in Tailrd, under Settings.",
        200,
    )
