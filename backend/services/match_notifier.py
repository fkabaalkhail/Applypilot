"""High-match job alert notifier.

Decides when to email a user about jobs that strongly match their resume, and
dedupes so a user is never alerted twice about the same job. Used both by the
resume-upload background task (immediate alerts for the jobs scored at upload)
and by the recurring cron sweep.
"""

import datetime
import hashlib
import logging
import os
import time
from typing import Optional

from sqlalchemy import exists, func, or_
from sqlalchemy.orm import Session

from backend.db.models import (
    JobMatchNotification,
    JobMatchScore,
    ScrapedJob,
    User,
    UserSettings,
)
from backend.services.alert_unsubscribe import unsubscribe_url
from backend.services.email_service import clean_company_name, email_service
from backend.services.listing_freshness import LISTING_ACTIVE, LISTING_STALE
from backend.services.local_match import scoring_mode
from backend.services.logo_cache import LOGO_PATH_PREFIX, logo_quality

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 80
# Free-tier guard rails (Resend free plan = 100 emails/day, 3,000/month).
# A user gets at most one digest per cooldown window, and we never send more
# than the daily budget across all users, leaving headroom for verification
# emails. Both are env-overridable.
DEFAULT_COOLDOWN_HOURS = 24
DEFAULT_DAILY_BUDGET = 80
# Wall-clock box (seconds) for the sweep's LLM scoring; see sweep_match_alerts.
DEFAULT_SCORING_BUDGET_S = 120

# Every value scraped_jobs.country takes: services/country_filter.py files each
# ingested row under US or CA, or drops it.
_ALERT_COUNTRIES = frozenset({"US", "CA"})
# Sorts a never-scored account ahead of every scored one.
_NEVER_SCORED = datetime.datetime(1970, 1, 1)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def get_threshold() -> int:
    """Minimum match score (0-100) that triggers an alert. Env-overridable."""
    return _env_int("MATCH_NOTIFY_THRESHOLD", DEFAULT_THRESHOLD)


def get_cooldown_hours() -> int:
    """Min hours between alert emails to the same user (0 disables)."""
    return _env_int("MATCH_NOTIFY_COOLDOWN_HOURS", DEFAULT_COOLDOWN_HOURS)


def get_daily_budget() -> int:
    """Max alert emails to send across all users per UTC day (0 disables sending)."""
    return _env_int("MATCH_NOTIFY_DAILY_BUDGET", DEFAULT_DAILY_BUDGET)


def alerts_enabled() -> bool:
    """Master switch for the recurring sweep.

    The sweep runs on the scrape cron and spends LLM budget whether or not a
    single person opens the app, so it needs an off-switch that costs nothing
    but an env var.
    """
    return _env_flag("MATCH_ALERTS_ENABLED", True)


def _now() -> float:
    """Monotonic clock for the sweep's scoring budget (a seam for tests: the
    event loop reads time.monotonic too, so that must never be patched)."""
    return time.monotonic()


def _alert_regions(raw: Optional[str]) -> list[str]:
    """The countries a user's alerts are limited to, from user_settings.regions.

    Onboarding stores the country the user picked ("CA"), the same value that
    seeds the feed's first-load country filter, so alerts honour it the way the
    feed does: before this, 33 of the 85 alerts (39%) sent to Canada-only users
    were US jobs. Empty, or only values no job carries, means no limit: an
    unrecognized setting must never silence a user.
    """
    picked = {r.strip().upper() for r in (raw or "").split(",") if r.strip()}
    return sorted(picked & _ALERT_COUNTRIES)


def _alert_prefs(db: Session, user_id: int) -> tuple[bool, list[str]]:
    """(alerts on?, region limit) for one user. Columns only. No settings row,
    or a NULL flag, is opted in: that has been everyone's default."""
    row = (
        db.query(UserSettings.match_alerts_enabled, UserSettings.regions)
        .filter(UserSettings.user_id == user_id)
        .first()
    )
    if row is None:
        return True, []
    return row[0] is not False, _alert_regions(row[1])


def _alertable() -> tuple:
    """SQL filters for rows worth an alert: exactly what the feed shows. A
    hidden cross-source duplicate or a closed listing would deep-link the
    user to a job they can't apply to (26 of the first 91 alerts pointed at
    rows since hidden as duplicates)."""
    return (
        ScrapedJob.duplicate_of.is_(None),
        or_(
            ScrapedJob.listing_status.is_(None),
            ScrapedJob.listing_status.in_((LISTING_ACTIVE, LISTING_STALE)),
        ),
        func.trim(func.coalesce(ScrapedJob.company, "")) != "",
        ScrapedJob.company != "Unknown",
    )


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
    day, so distinct-users-today equals emails-sent-today, a cheap, reliable
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


def _resume_fingerprint(raw_text: str) -> str:
    """Identify which resume a score was computed from.

    A cached score is only reusable while the resume it was computed from is
    unchanged; fingerprinting the text means an edit invalidates the score
    instead of serving a stale match forever.
    """
    return hashlib.sha256(raw_text.encode("utf-8", "replace")).hexdigest()


def _remember_score(
    db: Session, user_id: int, job_id: int, score: int, fingerprint: str
) -> None:
    """Bank a score the moment it is bought, so no later run pays for it again.

    Committed per score rather than once at the end of the sweep: the cron runs
    under a wall-clock limit, and a run that dies halfway through must not throw
    away the calls it already paid for.
    """
    row = (
        db.query(JobMatchScore)
        .filter(JobMatchScore.user_id == user_id, JobMatchScore.job_id == job_id)
        .first()
    )
    if row is None:
        db.add(
            JobMatchScore(
                user_id=user_id,
                job_id=job_id,
                score=score,
                resume_fingerprint=fingerprint,
            )
        )
    else:
        row.score = score
        row.resume_fingerprint = fingerprint
        row.scored_at = datetime.datetime.utcnow()
    db.commit()


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
    """Best company logo URL for the email.

    Priority: our self-hosted logo > a real stored hotlink > the favicon of
    the backend-resolved domain (website URL / name heuristic). Returns ""
    when nothing resolves so the email falls back to a letter avatar.

    A self-hosted logo is a relative '/jobs/logo/<sha>.png' path, served by
    the API behind the app's own origin (the /jobs/* rewrite), so an email
    gets it as an absolute FRONTEND_URL link. SVG ones fall through to the
    favicon: Gmail and Outlook don't render SVG images.
    """
    from backend.services.logo_resolver import logo_url_for_domain, resolve_domain

    stored = (job.company_logo or "").strip()
    if stored.startswith(LOGO_PATH_PREFIX):
        base = _frontend_base()
        if base and stored.lower().endswith(".png"):
            return f"{base}{stored}"
    elif logo_quality(stored) > 0:
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
        "company": clean_company_name(job.company),
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

    # The recipient's own choices. Checked here as well as in the sweep's user
    # query because the resume-upload path calls this directly, and a user can
    # unsubscribe while a sweep is running.
    enabled, regions = _alert_prefs(db, user_id)
    if not enabled:
        logger.info("Skipping match alert for user %s (opted out).", user_id)
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

    # Only rows the feed still shows (the upload path hands over whatever it
    # scored, hidden or closed rows included), in the user's region if they
    # picked one. Ids only, never whole rows.
    job_ids = [job.id for job, _ in candidates]
    region_filter = [ScrapedJob.country.in_(regions)] if regions else []
    alertable = {
        row.id
        for row in db.query(ScrapedJob.id)
        .filter(ScrapedJob.id.in_(job_ids), *_alertable(), *region_filter)
        .all()
    }
    candidates = [(job, score) for job, score in candidates if job.id in alertable]
    if not candidates:
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
    # CASL: every alert carries a working opt-out. It can only be missing where
    # FRONTEND_URL is unset (local dev); prod needs it for the verification
    # email and the APPLY links anyway.
    opt_out = unsubscribe_url(user_id)
    if not opt_out:
        logger.warning(
            "Match alert for user %s has no unsubscribe link: FRONTEND_URL is unset.",
            user_id,
        )

    sent = email_service.send_job_match_alert(
        user.email, payload, recipient_name, unsubscribe_url=opt_out
    )
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


def ai_confirmations_per_day() -> int:
    """LLM confirmations per user per UTC day in local mode (0 = never call
    the LLM: matching is then entirely free). Default 3 = at most ~$0.0015 per
    user per day at gpt-4o-mini prices."""
    return max(0, _env_int("MATCH_AI_DAILY_PER_USER", 3))


def ai_confirm_min_score() -> int:
    """Local score a job needs before it is worth an LLM confirmation."""
    return _env_int("MATCH_AI_CONFIRM_MIN", 70)


async def _score_user_local(
    db: Session,
    engine,
    user_id: int,
    profile,
    window,
    threshold: int,
    started: float,
    scoring_budget_s: int,
    llm_blocked: bool,
) -> dict:
    """Local-mode sweep for one user.

    1. Score every window job locally (free; already-current scores skipped).
    2. Spend at most ai_confirmations_per_day() LLM calls today confirming the
       best local candidates, best first. A confirmed score overwrites the
       local one for that (user, job).
    3. Return what may be emailed: LLM-confirmed scores at or above the
       threshold, or, when confirmation is off or the LLM is unreachable,
       local scores at or above it.
    """
    from backend.services.local_match import ai_fingerprint, bank_local_scores, local_fingerprint
    from backend.services.openai_service import LLMAccountError

    out = {"local_scored": 0, "ai_confirmed": 0, "errors": 0,
           "llm_unavailable": None, "budget_spent": False, "sendable": []}
    window_ids = [row[0] for row in db.query(window.c.id).all()]
    if not window_ids:
        return out
    out["local_scored"] = len(bank_local_scores(db, user_id, profile, window_ids))

    ai_fp = ai_fingerprint(profile.raw_text)
    local_fp = local_fingerprint(profile.raw_text)
    per_day = ai_confirmations_per_day()
    day_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    used_today = (
        db.query(func.count(JobMatchScore.id))
        .filter(
            JobMatchScore.user_id == user_id,
            JobMatchScore.resume_fingerprint == ai_fp,
            JobMatchScore.scored_at >= day_start,
        )
        .scalar()
    ) or 0
    allowance = max(0, per_day - used_today)

    if allowance and not llm_blocked:
        candidates = (
            db.query(JobMatchScore.job_id)
            .filter(
                JobMatchScore.user_id == user_id,
                JobMatchScore.job_id.in_(window_ids),
                JobMatchScore.resume_fingerprint == local_fp,
                JobMatchScore.score >= ai_confirm_min_score(),
            )
            .order_by(JobMatchScore.score.desc(), JobMatchScore.job_id.desc())
            .limit(allowance)
            .all()
        )
        ids = [row[0] for row in candidates]
        descriptions = dict(
            db.query(ScrapedJob.id, ScrapedJob.description).filter(ScrapedJob.id.in_(ids)).all()
        ) if ids else {}
        for job_id in ids:
            if scoring_budget_s > 0 and _now() - started >= scoring_budget_s:
                out["budget_spent"] = True
                break
            try:
                breakdown = await engine.compute_breakdown(profile.raw_text, descriptions.get(job_id) or "")
            except LLMAccountError as exc:
                out["llm_unavailable"] = str(exc)[:200]
                logger.error("match-alert sweep: OpenAI refused the account, local scores only: %s", exc)
                break
            except Exception as exc:
                out["errors"] += 1
                logger.warning("match-alert sweep: confirming job %s for user %s failed: %s: %s",
                               job_id, user_id, type(exc).__name__, exc)
                continue
            _remember_score(db, user_id, job_id, breakdown.overall_score, ai_fp)
            out["ai_confirmed"] += 1

    # Local scores may be emailed only when nothing will confirm them.
    trust_local = per_day == 0 or llm_blocked or out["llm_unavailable"] is not None
    fps = [ai_fp, local_fp] if trust_local else [ai_fp]
    rows = (
        db.query(ScrapedJob, JobMatchScore.score)
        .join(JobMatchScore, JobMatchScore.job_id == ScrapedJob.id)
        .filter(
            JobMatchScore.user_id == user_id,
            JobMatchScore.job_id.in_(window_ids),
            JobMatchScore.resume_fingerprint.in_(fps),
            JobMatchScore.score >= threshold,
        )
        .all()
    )
    out["sendable"] = [(job, sc) for job, sc in rows]
    return out


async def sweep_match_alerts(
    db: Session,
    max_users: Optional[int] = None,
    jobs_per_user: Optional[int] = None,
) -> dict:
    """Scan recent jobs for each verified user and email their new strong matches.

    Shared by the standalone cron endpoint and the github-sources cron-poll run
    (so the whole product fits inside Vercel's 2-cron Hobby limit). Skips users
    in cooldown or opted out *before* scoring to save LLM cost, and stops the
    whole sweep once the daily email budget is spent.

    Work is capped per run (env CRON_MATCH_MAX_USERS / CRON_MATCH_JOBS_PER_USER);
    any truncation is logged. Returns a summary dict whose status is
    "llm_unavailable" (plus "error") when OpenAI refused the account, so a run
    that scored nothing no longer looks like one that found no strong matches.
    """
    from backend.db.models import ResumeProfileDB
    from backend.services.match_engine import MatchEngine
    from backend.services.openai_service import LLMAccountError

    if not alerts_enabled():
        logger.info("Match-alert sweep disabled (MATCH_ALERTS_ENABLED); skipping.")
        return {
            "status": "disabled",
            "users_scanned": 0,
            "users_notified": 0,
            "jobs_notified": 0,
            "jobs_scored": 0,
            "scoring_errors": 0,
        }

    if max_users is None:
        max_users = _env_int("CRON_MATCH_MAX_USERS", 25)
    local_mode = scoring_mode() == "local"
    if jobs_per_user is None:
        # Local scoring is free, so its window can be wide; the LLM window
        # stays small because every job in it is a paid call.
        # 2,000 covers the whole live catalogue (~5k visible, newest first) in
        # a few runs; steady state is only the new arrivals, since current
        # scores are skipped and each job's terms are computed once, ever.
        jobs_per_user = _env_int("CRON_MATCH_JOBS_PER_USER", 2000 if local_mode else 15)
    # Wall-clock box for LLM scoring. cron-poll runs this sweep last, after
    # polling and enrichment, under Vercel's 300 s ceiling, and one call during
    # a transient OpenAI incident can sit through 45 s of 429 backoff (5xx:
    # 75 s): that is how the 2026-08-12 22:07Z to 00:02Z runs all hit 300 s.
    # Checked before each call, so the sweep overruns it by at most one call.
    # Unscored jobs are simply scored next run. 0 disables the box.
    scoring_budget_s = _env_int("CRON_MATCH_BUDGET_S", DEFAULT_SCORING_BUDGET_S)
    started = _now()

    threshold = get_threshold()
    budget = get_daily_budget()
    cooldown = get_cooldown_hours()
    engine = MatchEngine(db)

    # Everyone the sweep can do anything for, filtered in SQL BEFORE the cap:
    # verified, holding a resume, not opted out, not in cooldown. The cap used
    # to take the first 25 verified users by id and drop the resume-less ones
    # afterwards, so they held slots, and with no rotation account 26 onward
    # would never have been swept at all.
    cooldown_filter = []
    if cooldown > 0:
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=cooldown)
        cooldown_filter.append(
            ~exists().where(
                JobMatchNotification.user_id == User.id,
                JobMatchNotification.sent_at >= cutoff,
            )
        )
    eligible = (
        User.email_verified == True,  # noqa: E712
        exists().where(
            ResumeProfileDB.user_id == User.id,
            ResumeProfileDB.raw_text != None,  # noqa: E711
            ResumeProfileDB.raw_text != "",
        ),
        # Outer-joined below: no settings row, or a NULL flag, is opted in.
        or_(
            UserSettings.match_alerts_enabled == None,  # noqa: E711
            UserSettings.match_alerts_enabled == True,  # noqa: E712
        ),
        *cooldown_filter,
    )
    # Fair rotation under the cap: least recently scored first (never-scored
    # accounts ahead of everyone), id as the tiebreak. A run that buys a user a
    # score sends them to the back of the next run's queue. One whose window
    # held nothing new keeps its place, at no LLM cost, until a job lands in
    # it. (Prod on 2026-09-29: 5 eligible users, cap 25.)
    last_scored = (
        db.query(func.max(JobMatchScore.scored_at))
        .filter(JobMatchScore.user_id == User.id)
        .correlate(User)
        .scalar_subquery()
    )
    users = (
        db.query(User, UserSettings.regions)
        .outerjoin(UserSettings, UserSettings.user_id == User.id)
        .filter(*eligible)
        .order_by(func.coalesce(last_scored, _NEVER_SCORED).asc(), User.id.asc())
        .limit(max_users)
        .all()
    )
    if max_users and len(users) >= max_users:
        total_eligible = (
            db.query(func.count(User.id))
            .outerjoin(UserSettings, UserSettings.user_id == User.id)
            .filter(*eligible)
            .scalar()
        ) or 0
        if total_eligible > max_users:
            logger.info(
                "match-alert sweep: processing %d of %d eligible users this run "
                "(capped; least recently scored first).",
                max_users, total_eligible,
            )

    users_scanned = 0
    ai_confirmed = 0
    users_notified = 0
    jobs_notified = 0
    jobs_scored = 0
    scoring_errors = 0
    # Set when OpenAI refuses the ACCOUNT (billing, quota, key). From then on
    # the sweep makes no more LLM calls this run, but cached strong matches are
    # still emailed: sending needs no model.
    llm_unavailable: Optional[str] = None
    budget_spent = False

    for user, regions_raw in users:
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

        # Cooldown and opt-out were applied in the users query, before any
        # LLM scoring.
        users_scanned += 1
        regions = _alert_regions(regions_raw)

        notified_subq = (
            db.query(JobMatchNotification.job_id)
            .filter(JobMatchNotification.user_id == user.id)
            .subquery()
        )
        # The scoring window: the newest N jobs the feed shows that this user
        # hasn't been alerted about, in their region if they picked one.
        # Selected as ids first so the window stays anchored to "newest N":
        # filtering by cache state before the LIMIT would make each run dig
        # further into the backlog, growing the bill instead of capping it. The
        # region is a content filter like _alertable(), not a cache-state one,
        # and it only ever narrows what gets paid for.
        region_filter = [ScrapedJob.country.in_(regions)] if regions else []
        window = (
            db.query(ScrapedJob.id)
            .filter(
                *_alertable(),
                *region_filter,
                ScrapedJob.description != "",
                ScrapedJob.description != None,  # noqa: E711
                func.length(ScrapedJob.description) > 50,
                ~ScrapedJob.id.in_(db.query(notified_subq.c.job_id)),
            )
            .order_by(ScrapedJob.id.desc())
            .limit(jobs_per_user)
            .subquery()
        )
        if local_mode:
            outcome = await _score_user_local(
                db, engine, user.id, profile, window, threshold,
                started, scoring_budget_s, llm_unavailable or budget_spent,
            )
            jobs_scored += outcome["local_scored"]
            ai_confirmed += outcome["ai_confirmed"]
            scoring_errors += outcome["errors"]
            if outcome["llm_unavailable"]:
                llm_unavailable = outcome["llm_unavailable"]
            if outcome["budget_spent"]:
                budget_spent = True
            sent = notify_high_matches(db, user.id, outcome["sendable"])
            if sent:
                users_notified += 1
                jobs_notified += sent
            continue

        # Fetch full rows only for window jobs this run can actually use:
        # unscored ones (they go to the LLM) and cached strong matches (they
        # may be emailed). A job already scored below threshold for this same
        # resume can be neither scored nor sent, so its row, description and
        # all, stays in the database instead of crossing the wire every run.
        fingerprint = _resume_fingerprint(profile.raw_text)
        jobs = (
            db.query(ScrapedJob)
            .outerjoin(
                JobMatchScore,
                (JobMatchScore.job_id == ScrapedJob.id)
                & (JobMatchScore.user_id == user.id),
            )
            .filter(ScrapedJob.id.in_(db.query(window.c.id)))
            .filter(
                (JobMatchScore.id == None)  # noqa: E711
                | (JobMatchScore.resume_fingerprint != fingerprint)
                | (JobMatchScore.score >= threshold)
            )
            .order_by(ScrapedJob.id.desc())
            .all()
        )

        # Reuse anything we already paid to learn. Columns only, never whole
        # rows, so the lookup stays cheap on the wire.
        cached: dict[int, int] = {}
        if jobs:
            cached = dict(
                db.query(JobMatchScore.job_id, JobMatchScore.score)
                .filter(
                    JobMatchScore.user_id == user.id,
                    JobMatchScore.job_id.in_([j.id for j in jobs]),
                    JobMatchScore.resume_fingerprint == fingerprint,
                )
                .all()
            )

        # Snapshot what we score on while these rows are still loaded. Banking a
        # score commits, and a commit expires every ORM object in the session,
        # so reading job.description later in the loop would drag each whole row
        # back over the wire, which is the very cost this table exists to avoid.
        candidates = [(job, job.id, job.description) for job in jobs]

        scored: list[tuple[ScrapedJob, int]] = []
        for job, job_id, description in candidates:
            if job_id in cached:
                scored.append((job, cached[job_id]))
                continue
            # Nothing unscored is banked, so whatever is skipped here is simply
            # scored on a later run.
            if llm_unavailable or budget_spent:
                continue
            if scoring_budget_s > 0 and _now() - started >= scoring_budget_s:
                budget_spent = True
                logger.warning(
                    "match-alert sweep: %ds scoring budget spent; no more LLM "
                    "calls this run.", scoring_budget_s,
                )
                continue
            try:
                breakdown = await engine.compute_breakdown(profile.raw_text, description)
            except LLMAccountError as exc:
                # Billing, quota or key: every further call would be refused
                # the same way (75 refused calls a run from 2026-08-12 on).
                llm_unavailable = str(exc)[:200]
                logger.error(
                    "match-alert sweep: OpenAI refused the account, no more "
                    "scoring this run: %s", exc,
                )
                continue
            except Exception as exc:
                # Transient (timeout, 5xx after retries, an unparsable reply).
                # Not banked, so the pair is retried next run; counted and
                # logged so a sweep that scores nothing is visibly different
                # from one that found no strong matches.
                scoring_errors += 1
                logger.warning(
                    "match-alert sweep: scoring job %s for user %s failed: %s: %s",
                    job_id, user.id, type(exc).__name__, exc,
                )
                continue
            _remember_score(db, user.id, job_id, breakdown.overall_score, fingerprint)
            jobs_scored += 1
            scored.append((job, breakdown.overall_score))

        sent = notify_high_matches(db, user.id, scored)
        if sent:
            users_notified += 1
            jobs_notified += sent

    summary = {
        "status": "llm_unavailable" if llm_unavailable else "completed",
        "threshold": threshold,
        "users_scanned": users_scanned,
        "users_notified": users_notified,
        "jobs_notified": jobs_notified,
        "jobs_scored": jobs_scored,
        "scoring_errors": scoring_errors,
        "scoring_budget_spent": budget_spent,
        "scoring_mode": "local" if local_mode else "ai",
        "ai_confirmed": ai_confirmed,
    }
    if llm_unavailable:
        summary["error"] = llm_unavailable
    logger.info("match-alert sweep: %s", summary)
    return summary
