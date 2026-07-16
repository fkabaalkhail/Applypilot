"""
Listing freshness: the lifecycle layer that keeps the catalogue honest.

Aggregator competitors' known weakness is ghost/expired listings — jobs that
died on the employer's board weeks ago but keep ranking. This module makes the
catalogue self-correcting:

  - every board crawl RECONCILES its own rows: still-listed rows get
    ``last_seen_at`` bumped (and revived if previously removed), vanished rows
    are marked ``removed`` the same hour — not on some future full sweep
  - rows a board stopped vouching for (partial crawls, broken boards) go
    ``stale`` after STALE_AFTER_HOURS, and a small per-run budget of stale
    rows gets URL-verified (an honest 404 → removed immediately)
  - aggregator rows (LinkedIn/Indeed/GitHub lists), which no board will ever
    re-confirm, EXPIRE by age
  - active rows carry a ``ghost_risk_score`` heuristic — surfaced as data,
    never silently filtered, so the product decides hide vs badge

All states are soft: rows are never deleted (saved-job and application records
reference them), and the row's user-facing ``status`` workflow is untouched.
Everything here is column-query based — descriptions are only read for the
one-time evergreen check — because a whole-row sweep over the catalogue is
exactly the egress mistake that melted the Neon budget once already.
"""

from __future__ import annotations

import datetime
import logging
import re
from urllib.parse import urlparse

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from backend.db.models import ScrapedJob
from backend.services.structured_extraction import (
    compute_raw_hash,
    detect_employment_type,
    detect_visa_sponsorship,
    extract_skills,
    looks_evergreen,
    parse_salary,
)

logger = logging.getLogger(__name__)

LISTING_ACTIVE = "active"
LISTING_STALE = "stale"
LISTING_REMOVED = "removed"
LISTING_EXPIRED = "expired"

# Listing statuses hidden from the default catalogue view. ``stale`` stays
# visible: it usually means the board crawl is behind, not that the job died.
HIDDEN_LISTING_STATUSES = (LISTING_REMOVED, LISTING_EXPIRED)

# A direct-board row not re-confirmed for this long means its board stopped
# vouching for it (partial Workday crawls, a board that 500s). The full
# registry re-crawls every shard_count (~2-3) hours, so 72h is many misses.
STALE_AFTER_HOURS = 72

# Aggregator rows are never re-confirmed by anyone; past this age they are
# presumed dead. LinkedIn/Indeed postings churn far faster than the curated
# GitHub lists (which re-publish), so they age out sooner.
AGGREGATOR_MAX_AGE_DAYS = 30
AGGREGATOR_FAST_MAX_AGE_DAYS = 21
_FAST_AGGREGATOR_SOURCES = ("linkedin", "indeed")

GHOST_DAYS_OPEN = 45
CHANGE_LOG_CAP = 20

_IN_CHUNK = 400  # keep IN () lists comfortably under driver parameter limits


def _utcnow() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _chunks(items: list, size: int = _IN_CHUNK):
    for i in range(0, len(items), size):
        yield items[i:i + size]


# ─── New-row field construction ──────────────────────────────────────────────

def build_new_row_fields(job, board_key: str, source_trust: str = "high") -> dict:
    """Structured-extraction + freshness fields for a brand-new direct-board
    row. The caller merges these into its ScrapedJob(...) constructor kwargs.
    ``job`` is an ats_scraper.ATSJob."""
    now = _utcnow()
    description = job.description or ""
    salary_text = job.salary_text or ""

    salary = parse_salary(salary_text) or parse_salary(description)
    salary_min, salary_max, salary_currency, salary_period = salary if salary else (None, None, "", "")

    fields = {
        "listing_status": LISTING_ACTIVE,
        "first_seen_at": now,
        "last_seen_at": now,
        "board_key": board_key,
        "external_id": f"{board_key}:{job.external_id}" if job.external_id else "",
        "raw_hash": compute_raw_hash(job.title, job.location, description, salary_text),
        "source_trust": source_trust,
        "salary_min": salary_min,
        "salary_max": salary_max,
        "salary_currency": salary_currency,
        "salary_period": salary_period,
        "employment_type": detect_employment_type(job.title, description, job.employment_type or ""),
        "visa_sponsorship": detect_visa_sponsorship(description),
        "skills": extract_skills(job.title, description) or None,
    }
    return fields


# ─── Board reconciliation ────────────────────────────────────────────────────

def reconcile_board(db: Session, board_key: str, live_urls: set[str],
                    now: datetime.datetime | None = None) -> dict:
    """Sync this board's rows against the URLs the board just listed.

    - rows whose URL is still listed: ``last_seen_at`` = now, and removed/stale
      rows come back to ``active`` (reposted or crawl recovered)
    - rows whose URL vanished: ``removed``, effective immediately

    Only call with a COMPLETE snapshot — a partial crawl's absence is not
    evidence of removal. Commits. Returns counts.
    """
    now = now or _utcnow()
    stats = {"confirmed": 0, "revived": 0, "removed": 0}

    rows = (
        db.query(ScrapedJob.id, ScrapedJob.url, ScrapedJob.listing_status)
        .filter(ScrapedJob.board_key == board_key)
        .all()
    )
    if not rows:
        return stats

    live_ids: list[int] = []
    revive_ids: list[int] = []
    gone_ids: list[int] = []
    for row_id, url, listing_status in rows:
        if url in live_urls:
            live_ids.append(row_id)
            if listing_status in (LISTING_REMOVED, LISTING_STALE, LISTING_EXPIRED):
                revive_ids.append(row_id)
        elif listing_status in (LISTING_ACTIVE, LISTING_STALE):
            gone_ids.append(row_id)

    # A complete-but-empty response on a board that had many live rows is more
    # often an API hiccup than a real mass takedown; degrade to the stale
    # sweep instead of declaring everything removed.
    if not live_urls and len(gone_ids) > 10:
        logger.warning("reconcile %s: empty board with %d active rows — leaving to stale sweep",
                       board_key, len(gone_ids))
        return stats

    for chunk in _chunks(live_ids):
        db.query(ScrapedJob).filter(ScrapedJob.id.in_(chunk)).update(
            {"last_seen_at": now}, synchronize_session=False,
        )
    for chunk in _chunks(revive_ids):
        db.query(ScrapedJob).filter(ScrapedJob.id.in_(chunk)).update(
            {"listing_status": LISTING_ACTIVE, "listing_status_changed_at": now},
            synchronize_session=False,
        )
    for chunk in _chunks(gone_ids):
        db.query(ScrapedJob).filter(ScrapedJob.id.in_(chunk)).update(
            {"listing_status": LISTING_REMOVED, "listing_status_changed_at": now},
            synchronize_session=False,
        )

    db.commit()
    stats.update(confirmed=len(live_ids), revived=len(revive_ids), removed=len(gone_ids))
    return stats


def refresh_known_listings(db: Session, board_key: str, jobs: list,
                           now: datetime.datetime | None = None) -> tuple[list, dict]:
    """Split a board's filtered jobs into (new, stats) and refresh the ones
    already stored: detect edits (title/location/salary/description) into
    ``change_log``, update the structured fields, adopt legacy rows into
    ``board_key``. ``jobs`` are ats_scraper.ATSJob. Commits.

    Change detection is explicit column compares plus a description hash —
    a re-crawl that didn't carry the description (SmartRecruiters/Workday
    list payloads) must not read "description became empty" as an edit.
    """
    now = now or _utcnow()
    stats = {"refreshed": 0, "edited": 0, "salary_removed": 0}
    if not jobs:
        return [], stats

    by_url = {job.url: job for job in jobs if job.url}
    existing: dict[str, tuple] = {}
    urls = list(by_url.keys())
    for chunk in _chunks(urls):
        found = (
            db.query(
                ScrapedJob.id, ScrapedJob.url, ScrapedJob.title,
                ScrapedJob.location, ScrapedJob.salary_min, ScrapedJob.raw_hash,
                ScrapedJob.edit_count, ScrapedJob.change_log,
                ScrapedJob.board_key, ScrapedJob.external_id,
            )
            .filter(ScrapedJob.url.in_(chunk))
            .all()
        )
        for row in found:
            existing[row[1]] = row

    new_jobs = [job for url, job in by_url.items() if url not in existing]

    for url, row in existing.items():
        (row_id, _url, old_title, old_location, old_salary_min, old_hash,
         edit_count, change_log, old_board_key, old_external_id) = row
        job = by_url[url]

        updates: dict = {"last_seen_at": now}
        if not old_board_key:
            updates["board_key"] = board_key
        if job.external_id and not old_external_id:
            updates["external_id"] = f"{board_key}:{job.external_id}"

        changes: list[str] = []
        if job.title and job.title != old_title:
            changes.append("title")
            updates["title"] = job.title
        if job.location and job.location != old_location:
            changes.append("location")
            updates["location"] = job.location

        salary_source = job.salary_text or job.description or ""
        if salary_source:
            parsed = parse_salary(salary_source)
            if parsed:
                salary_min, salary_max, currency, period = parsed
                if old_salary_min and salary_min != old_salary_min:
                    changes.append("salary")
                updates.update(salary_min=salary_min, salary_max=salary_max,
                               salary_currency=currency, salary_period=period)
            elif old_salary_min and job.salary_text == "" and job.description:
                # The source used to state pay and the fresh full content no
                # longer does — the bait-and-switch edit worth flagging.
                changes.append("salary_removed")
                stats["salary_removed"] += 1

        if job.description:
            new_hash = compute_raw_hash(job.title, job.location,
                                        job.description, job.salary_text or "")
            if old_hash and new_hash != old_hash:
                if not changes:
                    changes.append("description")
                updates["description"] = job.description
                updates["description_sections"] = None
                updates["visa_sponsorship"] = detect_visa_sponsorship(job.description)
                updates["skills"] = extract_skills(job.title, job.description) or None
            updates["raw_hash"] = new_hash

        if changes:
            log = list(change_log or [])
            log.append({"at": now.isoformat(), "changed": changes})
            updates["change_log"] = log[-CHANGE_LOG_CAP:]
            updates["edit_count"] = (edit_count or 0) + 1
            stats["edited"] += 1

        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
            updates, synchronize_session=False,
        )
        stats["refreshed"] += 1

    db.commit()
    return new_jobs, stats


# ─── Scheduled sweeps ────────────────────────────────────────────────────────

def sweep_stale(db: Session, now: datetime.datetime | None = None,
                ttl_hours: int = STALE_AFTER_HOURS) -> int:
    """Direct-board rows not re-confirmed within the TTL go ``stale``."""
    now = now or _utcnow()
    cutoff = now - datetime.timedelta(hours=ttl_hours)
    count = (
        db.query(ScrapedJob)
        .filter(
            ScrapedJob.listing_status == LISTING_ACTIVE,
            or_(ScrapedJob.source_platform == "ats", ScrapedJob.board_key != ""),
            ScrapedJob.last_seen_at.isnot(None),
            ScrapedJob.last_seen_at < cutoff,
        )
        .update({"listing_status": LISTING_STALE, "listing_status_changed_at": now},
                synchronize_session=False)
    )
    db.commit()
    return count


def sweep_aggregator_expiry(db: Session, now: datetime.datetime | None = None,
                            max_age_days: int = AGGREGATOR_MAX_AGE_DAYS,
                            fast_max_age_days: int = AGGREGATOR_FAST_MAX_AGE_DAYS) -> int:
    """Age out aggregator rows nothing will ever re-confirm.

    LinkedIn/Indeed postings churn fast and can't be board-reconciled, so they
    expire at ``fast_max_age_days``; the curated GitHub lists (which re-publish
    still-open roles) keep the longer ``max_age_days``.
    """
    now = now or _utcnow()
    effective_date = func.coalesce(ScrapedJob.posted_date, ScrapedJob.scraped_at)
    total = 0
    # (source filter, cutoff days, whether the filter is a NOT-IN)
    for sources, days, negate in (
        (_FAST_AGGREGATOR_SOURCES, fast_max_age_days, False),
        (("ats",) + _FAST_AGGREGATOR_SOURCES, max_age_days, True),
    ):
        cutoff = now - datetime.timedelta(days=days)
        src_filter = (
            ScrapedJob.source_platform.notin_(sources) if negate
            else ScrapedJob.source_platform.in_(sources)
        )
        total += (
            db.query(ScrapedJob)
            .filter(
                ScrapedJob.listing_status == LISTING_ACTIVE,
                ScrapedJob.board_key == "",
                src_filter,
                effective_date < cutoff,
            )
            .update({"listing_status": LISTING_EXPIRED, "listing_status_changed_at": now},
                    synchronize_session=False)
        )
    db.commit()
    return total


# ─── Ghost-risk scoring ──────────────────────────────────────────────────────

def _ghost_score(days_open: int, evergreen: bool, repost_count: int,
                 company_long_open_ratio: float, company_active: int) -> tuple[int, dict]:
    score = 0
    factors: dict = {}
    if days_open > GHOST_DAYS_OPEN:
        bump = 25 if days_open <= 90 else 40
        score += bump
        factors["days_open"] = days_open
    if evergreen:
        score += 25
        factors["evergreen"] = True
    if repost_count > 0:
        score += 20
        factors["reposts"] = repost_count
    if company_active >= 5 and company_long_open_ratio > 0.5:
        score += 15
        factors["company_long_open_ratio"] = round(company_long_open_ratio, 2)
    return min(score, 100), factors


def score_ghost_risk(db: Session, now: datetime.datetime | None = None,
                     batch_size: int = 500) -> dict:
    """Score/rescore ghost risk for active rows.

    Two passes per run:
      1. never-scored rows (factors NULL) — the only pass that reads
         descriptions, to cache the evergreen flag into the factors JSON
      2. previously scored rows old enough that age-driven factors move —
         column-only, evergreen reused from the cached factors

    Commits. Returns counts.
    """
    now = now or _utcnow()
    stats = {"scored_new": 0, "rescored": 0}

    # Company-level context, one aggregate query: active count + long-open count.
    long_open_cutoff = now - datetime.timedelta(days=GHOST_DAYS_OPEN)
    company_rows = (
        db.query(
            ScrapedJob.company,
            func.count(ScrapedJob.id),
            # SQLite lacks FILTER; a CASE sum works on both engines.
            func.sum(case((ScrapedJob.first_seen_at < long_open_cutoff, 1), else_=0)),
        )
        .filter(ScrapedJob.listing_status == LISTING_ACTIVE,
                ScrapedJob.duplicate_of.is_(None))
        .group_by(ScrapedJob.company)
        .all()
    )
    company_ctx = {
        (name or ""): (int(active or 0), int(long_open or 0))
        for name, active, long_open in company_rows
    }

    def _company_ratio(company: str) -> tuple[float, int]:
        active, long_open = company_ctx.get(company or "", (0, 0))
        return (long_open / active if active else 0.0), active

    def _repost_counts(pairs: list[tuple[str, str]]) -> dict[tuple[str, str], int]:
        """(company, title_norm) → count of removed twins (repost signal)."""
        if not pairs:
            return {}
        norms = list({norm for _c, norm in pairs if norm})
        counts: dict[tuple[str, str], int] = {}
        for chunk in _chunks(norms):
            rows = (
                db.query(ScrapedJob.company, ScrapedJob.title_norm, func.count(ScrapedJob.id))
                .filter(ScrapedJob.listing_status == LISTING_REMOVED,
                        ScrapedJob.title_norm.in_(chunk))
                .group_by(ScrapedJob.company, ScrapedJob.title_norm)
                .all()
            )
            for company, norm, n in rows:
                counts[(company or "", norm or "")] = int(n or 0)
        return counts

    # Pass 1 — never scored. Reads the description once to cache `evergreen`.
    fresh = (
        db.query(ScrapedJob.id, ScrapedJob.company, ScrapedJob.title_norm,
                 ScrapedJob.first_seen_at, ScrapedJob.description)
        .filter(ScrapedJob.listing_status == LISTING_ACTIVE,
                ScrapedJob.duplicate_of.is_(None),
                ScrapedJob.ghost_risk_factors.is_(None))
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )
    reposts = _repost_counts([(c or "", n or "") for _i, c, n, _f, _d in fresh])
    for row_id, company, title_norm, first_seen_at, description in fresh:
        days_open = (now - first_seen_at).days if first_seen_at else 0
        evergreen = looks_evergreen(description or "")
        ratio, active_n = _company_ratio(company or "")
        score, factors = _ghost_score(
            days_open, evergreen,
            reposts.get((company or "", title_norm or ""), 0),
            ratio, active_n,
        )
        factors["evergreen"] = evergreen  # cache even when False
        factors["scored_at"] = now.isoformat()
        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
            {"ghost_risk_score": score, "ghost_risk_factors": factors},
            synchronize_session=False,
        )
        stats["scored_new"] += 1

    # Pass 2 — aging rows whose age factor may have moved. Column-only.
    aging_cutoff = now - datetime.timedelta(days=GHOST_DAYS_OPEN - 5)
    aging = (
        db.query(ScrapedJob.id, ScrapedJob.company, ScrapedJob.title_norm,
                 ScrapedJob.first_seen_at, ScrapedJob.ghost_risk_factors)
        .filter(ScrapedJob.listing_status == LISTING_ACTIVE,
                ScrapedJob.duplicate_of.is_(None),
                ScrapedJob.ghost_risk_factors.isnot(None),
                ScrapedJob.first_seen_at < aging_cutoff)
        .order_by(ScrapedJob.first_seen_at.asc())
        .limit(batch_size)
        .all()
    )
    reposts = _repost_counts([(c or "", n or "") for _i, c, n, _f, _g in aging])
    for row_id, company, title_norm, first_seen_at, old_factors in aging:
        days_open = (now - first_seen_at).days if first_seen_at else 0
        evergreen = bool((old_factors or {}).get("evergreen"))
        ratio, active_n = _company_ratio(company or "")
        score, factors = _ghost_score(
            days_open, evergreen,
            reposts.get((company or "", title_norm or ""), 0),
            ratio, active_n,
        )
        factors["evergreen"] = evergreen
        factors["scored_at"] = now.isoformat()
        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
            {"ghost_risk_score": score, "ghost_risk_factors": factors},
            synchronize_session=False,
        )
        stats["rescored"] += 1

    db.commit()
    return stats


# ─── Legacy adoption ─────────────────────────────────────────────────────────

_BOARD_URL_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"greenhouse\.io/(?:v1/boards/)?([^/?#]+)", re.IGNORECASE), "greenhouse"),
    (re.compile(r"jobs\.lever\.co/([^/?#]+)", re.IGNORECASE), "lever"),
    (re.compile(r"jobs\.ashbyhq\.com/([^/?#]+)", re.IGNORECASE), "ashby"),
    (re.compile(r"smartrecruiters\.com/([^/?#]+)", re.IGNORECASE), "smartrecruiters"),
    (re.compile(r"https?://([^./]+)\.wd\d+\.myworkdayjobs\.com", re.IGNORECASE), "workday"),
]


def board_key_from_url(url: str) -> str:
    """Derive "{platform}:{slug}" from a direct-board URL, "" when unknown."""
    for pattern, platform in _BOARD_URL_PATTERNS:
        m = pattern.search(url or "")
        if m:
            slug = m.group(1)
            if platform == "greenhouse" and slug in ("embed", "job", "jobs"):
                continue  # embed URLs put the slug in a query param; skip
            return f"{platform}:{slug}"
    return ""


def backfill_board_keys(db: Session, limit: int = 500) -> int:
    """Adopt legacy direct rows (board_key='') into reconciliation by deriving
    their board from the URL shape. Unknown shapes get 'unknown' so the scan
    doesn't revisit them forever. Commits."""
    rows = (
        db.query(ScrapedJob.id, ScrapedJob.url)
        .filter(ScrapedJob.source_platform == "ats",
                or_(ScrapedJob.board_key.is_(None), ScrapedJob.board_key == ""))
        .limit(limit)
        .all()
    )
    adopted = 0
    for row_id, url in rows:
        key = board_key_from_url(url or "") or "unknown"
        db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
            {"board_key": key}, synchronize_session=False,
        )
        if key != "unknown":
            adopted += 1
    if rows:
        db.commit()
    return adopted


# ─── URL liveness probing ────────────────────────────────────────────────────

# Only these statuses are evidence of death. Bot walls answer 401/403/405/406/
# 429/999 and some employers 5xx under load — none of that means the job is
# gone, and a real user's browser usually gets through where our probe can't.
DEAD_HTTP_STATUSES = (404, 410)

# Server-rendered hosts whose closed/expired postings return HTTP 200 with the
# "gone" message baked into the HTML (a soft 404). Only these hosts get a body
# verdict: SPA hosts (Workday/Ashby/most career sites) render that message
# client-side, so their 200 body never carries the signal and can't false-match.
# The biggest payoff is LinkedIn — 57% of aged rows answer 200 + the banner
# below while never returning an honest 404.
_SOFT_404_HOSTS = (
    "linkedin.com", "greenhouse.io", "lever.co",
    "smartrecruiters.com", "taleo.net", "icims.com",
)

# Phrases that appear only on a dead posting, kept specific so a live page's
# boilerplate (footers, "similar jobs") never trips them.
# ``expired_jd_redirect`` is LinkedIn's own marker: an expired job redirects the
# guest page to a jobs search and stamps that trk token into the nav links — a
# live posting never carries it. LinkedIn serves the "no longer accepting
# applications" banner on some hits and the expired-redirect on others, so we
# match both to catch a dead row on whichever variant a given probe lands on.
_DEAD_BODY_RE = re.compile(
    r"no longer accepting applications"
    r"|expired_jd_redirect"
    r"|this (?:job|position|posting|role) is no longer (?:available|active|open)"
    r"|(?:job|position|posting) (?:has been|has|is) (?:filled|closed)"
    r"|position has been filled"
    r"|the job you(?:'re| are| were)?\s+(?:looking for|requested)"
    r"|job is no longer available"
    r"|this posting has (?:closed|expired|been removed)",
    re.IGNORECASE,
)

_MAX_BODY_SCAN = 200_000  # cap the HTML we scan for a dead-message


def _body_says_dead(final_url: str, body: str) -> bool:
    """True when a 200 response is really a soft 404 (dead posting served with
    a 'no longer available' message), trusted only on server-rendered hosts."""
    host = (urlparse(final_url or "").hostname or "").lower()
    if not any(h in host for h in _SOFT_404_HOSTS):
        return False
    return bool(_DEAD_BODY_RE.search(body[:_MAX_BODY_SCAN]))


async def probe_url_liveness(client, url: str) -> str:
    """One GET, three verdicts: 'dead' (honest 404/410, or a soft-404 body on a
    trusted host), 'alive' (200), 'unknown' (everything else / network noise)."""
    if not url:
        return "unknown"
    try:
        response = await client.get(url, follow_redirects=True)
    except Exception:
        return "unknown"
    if response.status_code in DEAD_HTTP_STATUSES:
        return "dead"
    if response.status_code == 200:
        try:
            if _body_says_dead(str(response.url), response.text):
                return "dead"
        except Exception:
            pass
        return "alive"
    return "unknown"


async def probe_urls_liveness(client, urls: list[str], *, concurrency: int = 8,
                              budget: int = 80) -> dict[str, str]:
    """Probe up to ``budget`` URLs concurrently. Returns {url: verdict};
    URLs past the budget are simply absent (treated as unverified)."""
    import asyncio

    urls = [u for u in urls if u][:budget]
    if not urls:
        return {}
    semaphore = asyncio.Semaphore(concurrency)

    async def one(u: str) -> tuple[str, str]:
        async with semaphore:
            return u, await probe_url_liveness(client, u)

    return dict(await asyncio.gather(*[one(u) for u in urls]))


def mark_listing_removed(db: Session, row_id: int,
                         now: datetime.datetime | None = None) -> None:
    """Soft-remove one listing (dead apply URL). Commit is the caller's."""
    now = now or _utcnow()
    db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
        {"listing_status": LISTING_REMOVED, "listing_status_changed_at": now},
        synchronize_session=False,
    )


async def verify_recent_aggregator_listings(db: Session, client, limit: int = 150,
                                            now: datetime.datetime | None = None) -> dict:
    """Probe the NEWEST visible aggregator rows — the ones users actually click.
    Covers GitHub-list rows (the curated lists re-publish already-closed roles)
    AND LinkedIn rows (no board reconciliation ever covers either, and a huge
    share of aged LinkedIn actives are soft-dead — 200 + "no longer accepting
    applications"). Indeed is excluded: Cloudflare 403s the probe.

    An honest 404/410 or a soft-404 body → removed. Anything else stamps
    ``last_seen_at`` (here it means "probed", not board-confirmed — nothing
    else reads it for aggregator rows) so each row is re-checked ~daily instead
    of every run. Commits. Returns counts.
    """
    now = now or _utcnow()
    recheck_cutoff = now - datetime.timedelta(hours=20)
    effective_date = func.coalesce(ScrapedJob.posted_date, ScrapedJob.scraped_at)

    rows = (
        db.query(ScrapedJob.id, ScrapedJob.url)
        .filter(
            ScrapedJob.listing_status.in_((LISTING_ACTIVE, LISTING_STALE)),
            ScrapedJob.source_platform.in_(("github", "linkedin")),
            ScrapedJob.duplicate_of.is_(None),
            or_(ScrapedJob.last_seen_at.is_(None),
                ScrapedJob.last_seen_at < recheck_cutoff),
        )
        .order_by(effective_date.desc(), ScrapedJob.id.desc())
        .limit(limit)
        .all()
    )
    stats = {"checked": 0, "removed": 0}
    if not rows:
        return stats

    verdicts = await probe_urls_liveness(client, [url for _id, url in rows],
                                         budget=limit)
    for row_id, url in rows:
        verdict = verdicts.get(url)
        if verdict is None:
            continue
        stats["checked"] += 1
        if verdict == "dead":
            mark_listing_removed(db, row_id, now)
            stats["removed"] += 1
        else:
            db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                {"last_seen_at": now}, synchronize_session=False,
            )
    db.commit()
    return stats


# ─── Stale-row URL verification ──────────────────────────────────────────────

# Hosts whose job URLs return honest status codes BOTH ways — a 200 here
# really means the posting is live, so it may revive a stale row. SPAs
# (Ashby, most company career sites) 200 on everything, so a 200 from them
# proves nothing; only the honest 404/410 verdict applies everywhere.
_REVIVABLE_HOSTS = ("greenhouse.io", "jobs.lever.co", "smartrecruiters.com",
                    "myworkdayjobs.com")

# Indeed sits behind Cloudflare and answers our probe with 403 — indeterminate
# in either direction, so we never probe it. LinkedIn is NOT here: its public
# guest job page returns 200 with an explicit "no longer accepting applications"
# banner for closed roles, which the soft-404 body check reads as dead.
_UNPROBEABLE_HOSTS = ("indeed.com",)


async def verify_stale_listings(db: Session, client, limit: int = 200,
                                now: datetime.datetime | None = None) -> dict:
    """Work through the stale backlog with real requests, newest-first (the
    rows a search can still surface). An honest 404/410 — or a soft-404 body on
    a trusted host (incl. LinkedIn's "no longer accepting applications") —
    removes the row on ANY host; a 200 revives it only on hosts that 404
    honestly for dead postings. Everything else stamps ``last_seen_at`` so the
    next run moves on to unchecked rows instead of re-probing the same bot
    walls."""
    now = now or _utcnow()
    stats = {"checked": 0, "removed": 0, "revived": 0}
    recheck_cutoff = now - datetime.timedelta(hours=20)
    effective_date = func.coalesce(ScrapedJob.posted_date, ScrapedJob.scraped_at)

    rows = (
        db.query(ScrapedJob.id, ScrapedJob.url)
        .filter(
            ScrapedJob.listing_status == LISTING_STALE,
            or_(ScrapedJob.last_seen_at.is_(None),
                ScrapedJob.last_seen_at < recheck_cutoff),
        )
        .order_by(effective_date.desc(), ScrapedJob.id.desc())
        .limit(limit * 2)
        .all()
    )
    probeable = [
        (row_id, url) for row_id, url in rows
        if url and not any(host in url for host in _UNPROBEABLE_HOSTS)
    ][:limit]
    if not probeable:
        return stats

    verdicts = await probe_urls_liveness(client, [u for _i, u in probeable],
                                         budget=limit)
    for row_id, url in probeable:
        verdict = verdicts.get(url)
        if verdict is None:
            continue
        stats["checked"] += 1
        if verdict == "dead":
            mark_listing_removed(db, row_id, now)
            stats["removed"] += 1
        elif verdict == "alive" and any(h in url for h in _REVIVABLE_HOSTS):
            db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                {"listing_status": LISTING_ACTIVE, "listing_status_changed_at": now,
                 "last_seen_at": now},
                synchronize_session=False,
            )
            stats["revived"] += 1
        else:
            db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                {"last_seen_at": now}, synchronize_session=False,
            )

    if stats["checked"]:
        db.commit()
    return stats
