"""
Application profile endpoint for the Chrome extension.

GET /api/user/application-profile — the canonical, ready-to-fill profile the
extension autofills from. It merges the three places a user's data can live:

    1. ResumeProfileDB  — data parsed from the uploaded resume (what the web
                          app's Profile page shows). This is the primary source.
    2. UserSettings     — manually-entered form-filling fields + screening answers.
    3. User             — account name/email as a final fallback.

The response uses camelCase keys so it maps 1:1 onto the extension's
`UserApplicationProfile` type (see chrome-extension/src/shared/types.ts). Before
this endpoint existed the extension fell back to GET /settings, which a resume
upload never populates — so signed-in users saw an empty profile.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import CoverLetter, ResumeProfileDB, User, UserSettings
from backend.auth.dependencies import get_verified_user
from backend.services.profile_version import bump_profile_version, get_profile_version

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Response schema (camelCase to match the extension) ──────────────────────

class EducationEntry(BaseModel):
    school: str = ""
    degree: str = ""
    graduationYear: str = ""


class ExperienceEntry(BaseModel):
    company: str = ""
    title: str = ""
    startDate: str = ""
    endDate: str = ""
    description: str = ""


class ApplicationProfileOut(BaseModel):
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    currentCompany: str = ""
    currentTitle: str = ""
    workAuthorization: str = ""
    requiresSponsorship: str = ""
    education: list[EducationEntry] = []
    experience: list[ExperienceEntry] = []
    skills: list[str] = []
    coverLetter: str = ""
    # Sync + resume metadata for the extension.
    version: int = 1
    resumeId: int | None = None
    resumeFileName: str = ""
    hasResumeFile: bool = False


class ApplicationProfileIn(BaseModel):
    """Editable autofill fields the extension (or web app) can write back.

    Only contact + screening fields are user-editable; resume-derived sections
    (experience, education, skills) come from the parsed resume. Any provided
    field overrides the stored value; omitted fields are left untouched.
    """
    firstName: str | None = None
    lastName: str | None = None
    email: str | None = None
    phone: str | None = None
    location: str | None = None
    linkedin: str | None = None
    portfolio: str | None = None
    currentTitle: str | None = None
    workAuthorization: str | None = None
    requiresSponsorship: str | None = None
    salaryExpectation: str | None = None


class ProfileVersionOut(BaseModel):
    version: int = 1
    updated_at: str | None = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _first_non_empty(*values: object) -> str:
    """First value that is a non-blank string, else ""."""
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _split_name(full_name: str) -> tuple[str, str]:
    """'Wissam Elmasry' -> ('Wissam', 'Elmasry'); single token -> (token, '')."""
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _mine_screening(prefilled: dict | None) -> tuple[str, str]:
    """
    Pull work-authorization and sponsorship answers out of the free-form
    prefilled_answers question→answer map. Mirrors the client-side logic that
    used to live in chrome-extension/src/api/client.ts (mapSettingsToProfile).
    """
    work_authorization = ""
    requires_sponsorship = ""
    for question, answer in (prefilled or {}).items():
        if not isinstance(answer, str):
            continue
        q = question.lower()
        if not requires_sponsorship and "sponsor" in q:
            requires_sponsorship = answer
        elif not work_authorization and ("authoriz" in q or "eligible" in q):
            work_authorization = answer
    return work_authorization, requires_sponsorship


def _flatten_skills(skills: object, technologies: object) -> list[str]:
    """Combine the flat skills list with the categorized technologies, deduped."""
    out: list[str] = []
    seen: set[str] = set()

    def add(item: object) -> None:
        if isinstance(item, str):
            s = item.strip()
            key = s.lower()
            if s and key not in seen:
                seen.add(key)
                out.append(s)

    if isinstance(skills, list):
        for s in skills:
            add(s)
    if isinstance(technologies, dict):
        for values in technologies.values():
            if isinstance(values, list):
                for s in values:
                    add(s)
    return out


def _map_experience(raw: object) -> list[ExperienceEntry]:
    items: list[ExperienceEntry] = []
    if not isinstance(raw, list):
        return items
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        bullets = entry.get("bullets") or []
        description = "\n".join(b for b in bullets if isinstance(b, str)) if isinstance(bullets, list) else ""
        items.append(
            ExperienceEntry(
                company=_first_non_empty(entry.get("company")),
                title=_first_non_empty(entry.get("title")),
                startDate=_first_non_empty(entry.get("start_date")),
                endDate=_first_non_empty(entry.get("end_date")),
                description=description,
            )
        )
    return items


def _map_education(raw: object) -> list[EducationEntry]:
    items: list[EducationEntry] = []
    if not isinstance(raw, list):
        return items
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        items.append(
            EducationEntry(
                school=_first_non_empty(entry.get("school")),
                degree=_first_non_empty(entry.get("degree")),
                # The extension models a single "graduation year"; the resume
                # stores a free-form end date, which is the closest fit.
                graduationYear=_first_non_empty(entry.get("end_date")),
            )
        )
    return items


# ─── Endpoint ────────────────────────────────────────────────────────────────

@router.get("/user/application-profile", response_model=ApplicationProfileOut)
def get_application_profile(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """
    Return the current user's ready-to-fill application profile, merged from
    their resume, settings, and account. 404 only when none of those exist.
    """
    resume = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.user_id == user.id)
        .order_by(ResumeProfileDB.is_primary.desc(), ResumeProfileDB.created_at.desc())
        .first()
    )
    settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()

    if resume is None and settings is None:
        raise HTTPException(
            status_code=404,
            detail="No application profile yet. Upload a resume or fill in your settings first.",
        )

    # Name: prefer a manual settings override, then the resume's parsed name,
    # then the account. (Settings-first so edits made in the app/extension win.)
    resume_first, resume_last = _split_name(resume.profile_name if resume else "")
    first_name = _first_non_empty(
        settings.first_name if settings else "",
        resume_first,
        user.first_name,
    )
    last_name = _first_non_empty(
        settings.last_name if settings else "",
        resume_last,
        user.last_name,
    )

    experience = _map_experience(resume.experience if resume else None)
    education = _map_education(resume.education if resume else None)
    skills = _flatten_skills(
        resume.skills if resume else None,
        resume.technologies if resume else None,
    )

    current_company = experience[0].company if experience else ""
    current_title = _first_non_empty(
        settings.job_title if settings else "",
        experience[0].title if experience else "",
    )

    work_authorization, requires_sponsorship = _mine_screening(
        settings.prefilled_answers if settings else None
    )

    # Active cover letter (synced to the extension's cover-letter fields).
    cover = (
        db.query(CoverLetter)
        .filter(CoverLetter.user_id == user.id, CoverLetter.is_active == 1)
        .order_by(CoverLetter.updated_at.desc())
        .first()
    )

    version = settings.data_version if settings and settings.data_version else 1

    return ApplicationProfileOut(
        firstName=first_name,
        lastName=last_name,
        email=_first_non_empty(
            settings.email if settings else "",
            resume.email if resume else "",
            user.email,
        ),
        phone=_first_non_empty(
            settings.phone if settings else "",
            resume.phone if resume else "",
        ),
        location=_first_non_empty(
            settings.city if settings else "",
            settings.location if settings else "",
            resume.location if resume else "",
        ),
        linkedin=_first_non_empty(
            settings.linkedin_url if settings else "",
            resume.linkedin_url if resume else "",
        ),
        github=_first_non_empty(resume.github_url if resume else ""),
        portfolio=_first_non_empty(
            settings.website if settings else "",
            resume.other_link if resume else "",
        ),
        currentCompany=current_company,
        currentTitle=current_title,
        workAuthorization=work_authorization,
        requiresSponsorship=requires_sponsorship,
        education=education,
        experience=experience,
        skills=skills,
        coverLetter=(cover.text if cover else "") or "",
        version=version,
        resumeId=resume.id if resume else None,
        resumeFileName=(resume.file_name if resume else "") or "",
        hasResumeFile=bool(resume.file_blob_url) if resume else False,
    )


@router.put("/user/application-profile", response_model=ProfileVersionOut)
def update_application_profile(
    body: ApplicationProfileIn,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Write editable autofill fields back to settings and bump the sync version
    so the change reflects across both the web app and the extension."""
    settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()
    if settings is None:
        settings = UserSettings(user_id=user.id)
        db.add(settings)

    field_map = {
        "firstName": "first_name",
        "lastName": "last_name",
        "email": "email",
        "phone": "phone",
        "location": "city",
        "linkedin": "linkedin_url",
        "portfolio": "website",
        "currentTitle": "job_title",
    }
    for in_field, col in field_map.items():
        val = getattr(body, in_field)
        if val is not None:
            setattr(settings, col, val)

    # Screening answers + salary live in the free-form prefilled_answers map.
    # Reassign (don't mutate in place) so SQLAlchemy detects the JSON change.
    answers = dict(settings.prefilled_answers or {})
    if body.workAuthorization is not None:
        answers["Are you authorized to work in this country?"] = body.workAuthorization
    if body.requiresSponsorship is not None:
        answers["Do you now or in the future require sponsorship?"] = body.requiresSponsorship
    if body.salaryExpectation is not None:
        answers["Salary expectation"] = body.salaryExpectation
    settings.prefilled_answers = answers

    db.commit()

    version = bump_profile_version(db, user.id)
    _, updated_at = get_profile_version(db, user.id)
    return ProfileVersionOut(
        version=version, updated_at=updated_at.isoformat() if updated_at else None
    )


@router.get("/user/profile-version", response_model=ProfileVersionOut)
def read_profile_version(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Cheap staleness check for the extension — returns the current sync
    version so it only re-downloads the full profile when something changed."""
    version, updated_at = get_profile_version(db, user.id)
    return ProfileVersionOut(
        version=version, updated_at=updated_at.isoformat() if updated_at else None
    )
