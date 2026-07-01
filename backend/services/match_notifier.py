"""High-match job alert notifier.

Decides when to email a user about jobs that strongly match their resume, and
dedupes so a user is never alerted twice about the same job. Used both by the
resume-upload background task (immediate alerts for the jobs scored at upload)
and by the recurring cron sweep.
"""

import datetime
import logging
import os
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.db.models import JobMatchNotification, ScrapedJob, User
from backend.services.email_service import email_service

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 80
# Free-tier guard rails (Resend free plan = 100 emails/day, 3,000/month).
# A user gets at most one digest per cooldown window, and we never send more
# than the daily budget across all users — leaving headroom for verification
# emails. Both are env-overridable.
DEFAULT_COOLDOWN_HOURS = 24
DEFAULT_DAILY_BUDGET = 80


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def get_threshold() -> int:
    """Minimum match score (0-100) that triggers an alert. Env-overridable."""
    return _env_int("MATCH_NOTIFY_THRESHOLD", DEFAULT_THRESHOLD)


def get_cooldown_hours() -> int:
    """Min hours between alert emails to the same user (0 disables)."""
    return _env_int("MATCH_NOTIFY_COOLDOWN_HOURS", DEFAULT_COOLDOWN_HOURS)


def get_daily_budget() -> int:
    """Max alert emails to send across all users per UTC day (0 disables sending)."""
    return _env_int("MATCH_NOTIFY_DAILY_BUDGET", DEFAULT_DAILY_BUDGET)


def _recently_notified(db: Session, user_id: int, hours: int) -> bool:
    """True if this user was alerted within the cooldown window."""
    if hours <= 0:
        return False
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    row = (
        db.query(JobMatchNotification.id)
        .filter(
            JobMatchNotification.user_id == user_id,
            JobMatchNotification.sent_at >= cutoff,
        )
        .first()
    )
    return row is not None


def _emails_sent_today(db: Session) -> int:
    """Distinct users alerted since UTC midnight.

    With the per-user cooldown (>=24h) each user receives at most one digest a
    day, so distinct-users-today equals emails-sent-today — a cheap, reliable
    proxy for the daily budget without a separate counter table.
    """
    start = datetime.datetime.utcnow().replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return (
        db.query(func.count(func.distinct(JobMatchNotification.user_id)))
        .filter(JobMatchNotification.sent_at >= start)
        .scalar()
        or 0
    )


def _frontend_base() -> str:
    return (os.getenv("FRONTEND_URL") or "").rstrip("/")


def _relative_time(when: Optional[datetime.datetime]) -> str:
    """Render a coarse 'N minutes/hours/days ago' string, or '' if unknown."""
    if not when:
        return ""
    try:
        delta = datetime.datetime.utcnow() - when
    except TypeError:
        return ""
    seconds = int(delta.total_seconds())
    if seconds < 0:
        return ""
    minutes = seconds // 60
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    days = hours // 24
    return f"{days} day{'s' if days != 1 else ''} ago"


def _resolve_logo_url(job: ScrapedJob) -> str:
    """Best company logo URL for the email (mirrors frontend resolveLogoUrl).

    Priority: a real stored logo > backend-resolved domain > website URL / name
    heuristic. Returns "" when nothing resolves so the email falls back to a
    letter avatar.
    """
    from backend.services.logo_resolver import logo_url_for_domain, resolve_domain

    stored = (job.company_logo or "").strip()
    generated_markers = ("clearbit", "icon.horse", "google.com/s2", "apistemic", "hunter.io")
    if stored.startswith("http") and not any(m in stored for m in generated_markers):
        return stored

    domain = (job.company_domain or "").strip()
    if not domain:
        domain = resolve_domain(job.company, job.company_url) or ""
    return logo_url_for_domain(domain) if domain else ""


def _job_to_alert_dict(job: ScrapedJob, score: int) -> dict:
    """Shape a ScrapedJob into the dict the email template expects.

    The 'APPLY NOW' button deep-links into the Tailrd dashboard so users tailor
    and apply with our tools; falls back to the raw job URL if FRONTEND_URL is
    unset.
    """
    base = _frontend_base()
    apply_url = f"{base}/app?job={job.id}" if base else (job.url or "#")
    return {
        "title": job.title or "",
        "company": job.company or "",
        "match_score": int(score or 0),
        "location": job.location or "",
        "salary": job.salary_range or "",
        "posted": _relative_time(job.posted_date),
        "apply_url": apply_url,
        "logo_url": _resolve_logo_url(job),
    }


def notify_high_matches(
    db: Session, user_id: int, scored: list[tuple[ScrapedJob, int]]
) -> int:
    """Email a user about their high-scoring matches, deduping prior alerts.

    Args:
        db: Active DB session.
        user_id: Recipient user id.
        scored: List of (ScrapedJob, score) pairs the caller just computed for
            this user's resume.

    Returns:
        Number of jobs included in the sent alert (0 if nothing was sent).
    """
    threshold = get_threshold()
    candidates = [(job, int(score or 0)) for job, score in scored if int(score or 0) >= threshold]
    if not candidates:
        return 0

    # Only email verified accounts with a real address.
    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.email or not user.email_verified:
        logger.info(
            "Skipping match alert for user %s (missing/unverified email).", user_id
        )
        return 0

    # Free-tier guard: at most one digest per user per cooldown window. Matches
    # found in the meantime stay un-recorded and roll into the next eligible run.
    cooldown = get_cooldown_hours()
    if _recently_notified(db, user_id, cooldown):
        logger.info(
            "Skipping match alert for user %s (within %dh cooldown).",
            user_id, cooldown,
        )
        return 0

    # Free-tier guard: stop once the daily send budget is exhausted.
    budget = get_daily_budget()
    if _emails_sent_today(db) >= budget:
        logger.info(
            "Daily match-alert budget (%d) reached; skipping user %s.",
            budget, user_id,
        )
        return 0

    # Drop jobs this user was already alerted about.
    job_ids = [job.id for job, _ in candidates]
    already = {
        row.job_id
        for row in db.query(JobMatchNotification.job_id)
        .filter(
            JobMatchNotification.user_id == user_id,
            JobMatchNotification.job_id.in_(job_ids),
        )
        .all()
    }
    fresh = [(job, score) for job, score in candidates if job.id not in already]
    if not fresh:
        return 0

    fresh.sort(key=lambda pair: pair[1], reverse=True)
    payload = [_job_to_alert_dict(job, score) for job, score in fresh]
    recipient_name = (user.first_name or "").strip() or None

    sent = email_service.send_job_match_alert(user.email, payload, recipient_name)
    if not sent:
        # Leave un-recorded so the next sweep retries (e.g. transient Resend
        # error or email not yet configured).
        return 0

    for job, score in fresh:
        db.add(
            JobMatchNotification(user_id=user_id, job_id=job.id, match_score=score)
        )
    db.commit()
    logger.info("Recorded %d match notifications for user %s.", len(fresh), user_id)
    return len(fresh)


async def sweep_match_alerts(
    db: Session,
    max_users: Optional[int] = None,
    jobs_per_user: Optional[int] = None,
) -> dict:
    """Scan recent jobs for each verified user and email their new strong matches.

    Shared by the standalone cron endpoint and the github-sources cron-poll run
    (so the whole product fits inside Vercel's 2-cron Hobby limit). Skips users
    in cooldown *before* scoring to save LLM cost, and stops the whole sweep once
    the daily email budget is spent.

    Work is capped per run (env CRON_MATCH_MAX_USERS / CRON_MATCH_JOBS_PER_USER);
    any truncation is logged. Returns a summary dict.
    """
    from backend.db.models import ResumeProfileDB
    from backend.services.match_engine import MatchEngine

    if max_users is None:
        max_users = _env_int("CRON_MATCH_MAX_USERS", 25)
    if jobs_per_user is None:
        jobs_per_user = _env_int("CRON_MATCH_JOBS_PER_USER", 15)

    threshold = get_threshold()
    budget = get_daily_budget()
    cooldown = get_cooldown_hours()
    engine = MatchEngine(db)

    users = (
        db.query(User)
        .filter(User.email_verified == True)  # noqa: E712
        .order_by(User.id.asc())
        .limit(max_users)
        .all()
    )
    total_verified = (
        db.query(func.count(User.id)).filter(User.email_verified == True).scalar()  # noqa: E712
    )
    if total_verified and total_verified > max_users:
        logger.info(
            "match-alert sweep: processing %d of %d verified users this run (capped).",
            max_users, total_verified,
        )

    users_scanned = 0
    users_notified = 0
    jobs_notified = 0

    for user in users:
        # Stop spending LLM calls once the day's email budget is gone.
        if _emails_sent_today(db) >= budget:
            logger.info(
                "Daily match-alert budget (%d) reached; ending sweep early.", budget
            )
            break

        profile = (
            db.query(ResumeProfileDB)
            .filter(
                ResumeProfileDB.user_id == user.id,
                ResumeProfileDB.raw_text != None,  # noqa: E711
                ResumeProfileDB.raw_text != "",
            )
            .order_by(ResumeProfileDB.created_at.desc())
            .first()
        )
        if not profile or not profile.raw_text:
            continue

        # Skip cooldown users before doing any LLM scoring.
        if _recently_notified(db, user.id, cooldown):
            continue

        users_scanned += 1

        notified_subq = (
            db.query(JobMatchNotification.job_id)
            .filter(JobMatchNotification.user_id == user.id)
            .subquery()
        )
        jobs = (
            db.query(ScrapedJob)
            .filter(
                ScrapedJob.description != "",
                ScrapedJob.description != None,  # noqa: E711
                func.length(ScrapedJob.description) > 50,
                ~ScrapedJob.id.in_(db.query(notified_subq.c.job_id)),
            )
            .order_by(ScrapedJob.id.desc())
            .limit(jobs_per_user)
            .all()
        )

        scored: list[tuple[ScrapedJob, int]] = []
        for job in jobs:
            try:
                breakdown = await engine.compute_breakdown(profile.raw_text, job.description)
                scored.append((job, breakdown.overall_score))
            except Exception:
                continue

        sent = notify_high_matches(db, user.id, scored)
        if sent:
            users_notified += 1
            jobs_notified += sent

    return {
        "status": "completed",
        "threshold": threshold,
        "users_scanned": users_scanned,
        "users_notified": users_notified,
        "jobs_notified": jobs_notified,
    }
