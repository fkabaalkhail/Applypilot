"""
Job listing endpoints (data only — no bot automation).

GET  /jobs          — list scraped jobs with filters
GET  /jobs/{id}     — get a single job
GET  /jobs/stats    — aggregate stats
POST /jobs/{id}/save   — save a job
POST /jobs/{id}/unsave — unsave a job
"""

import datetime
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import and_, func, or_

from backend.db.database import get_db
from backend.db.models import ScrapedJob, JobStatus, ApplicationRecord, UserSavedJob
from backend.auth.dependencies import (
    get_verified_user_id,
    get_optional_user_id,
    get_admin_user_id,
    verify_cron_secret,
)
from backend.schemas.jobs import ScrapedJobOut, IngestBatchIn
from backend.schemas.application import ApplicationOut
from backend.services.description_extractor import (
    BROWSER_HEADERS,
    extract_description_from_html,
    extract_description_from_url,
)
from backend.services.location_parser import location_fields
from backend.services.logo_resolver import resolve_logo
from backend.services.cross_source_dedup import (
    canonical_url,
    has_direct_twin,
    normalize_title,
)
from backend.services.listing_freshness import HIDDEN_LISTING_STATUSES

logger = logging.getLogger(__name__)
router = APIRouter()


def _overlay_saved(db: Session, jobs: list[ScrapedJob], user_id: Optional[int]) -> list[ScrapedJobOut]:
    """Attach the requesting user's saved/liked status (UserSavedJob is per-user, not global)."""
    saved_ids: set[int] = set()
    if user_id is not None and jobs:
        rows = (
            db.query(UserSavedJob.job_id)
            .filter(UserSavedJob.user_id == user_id, UserSavedJob.job_id.in_([j.id for j in jobs]))
            .all()
        )
        saved_ids = {row[0] for row in rows}
    results = []
    for job in jobs:
        out = ScrapedJobOut.model_validate(job)
        out.saved = 1 if job.id in saved_ids else 0
        results.append(out)
    return results


def _escape_like(term: str) -> str:
    """Escape SQL LIKE wildcards to prevent DoS via expensive patterns."""
    return re.sub(r'([%_])', r'\\\1', term)


def _sanitize_description(text: str) -> str:
    """Sanitize HTML from job descriptions to prevent stored XSS."""
    import nh3
    # Strip all HTML tags, keeping only safe text content
    return nh3.clean(text, tags=set())


@router.get("", response_model=list[ScrapedJobOut])
def list_jobs(
    status: Optional[JobStatus] = None,
    min_score: int = Query(0, ge=0),
    source: Optional[str] = None,
    saved: Optional[int] = None,
    search: Optional[str] = None,
    location: Optional[str] = None,
    country: Optional[str] = None,
    work_type: Optional[str] = None,
    role_category: Optional[str] = None,
    experience_level: Optional[str] = None,
    date_posted: Optional[str] = None,
    sort: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user_id: Optional[int] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status, match score, source, country, work_type, etc."""
    from backend.services.job_filters import (
        date_posted_cutoff,
        expand_experience_filter_values,
    )

    q = db.query(ScrapedJob).filter(ScrapedJob.match_score >= min_score)
    q = q.filter(
        ScrapedJob.company.isnot(None),
        func.trim(ScrapedJob.company) != "",
        ScrapedJob.company != "Unknown",
    )

    if status:
        q = q.filter(ScrapedJob.status == status)
    if source:
        q = q.filter(ScrapedJob.source_platform == source)
    if saved:
        # "Liked" jobs are per-user (UserSavedJob), not a global flag on the job.
        # Hidden cross-source duplicates STAY visible here — a bookmark the
        # user made must not vanish because its twin arrived later.
        if user_id is None:
            return []
        q = q.join(UserSavedJob, UserSavedJob.job_id == ScrapedJob.id).filter(
            UserSavedJob.user_id == user_id
        )
    else:
        q = q.filter(ScrapedJob.duplicate_of.is_(None))
        # Freshness: listings the source took down (or that aged out) leave
        # the catalogue. `stale` stays visible — usually crawl lag, not death.
        q = q.filter(
            or_(
                ScrapedJob.listing_status.is_(None),
                ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES),
            )
        )
    if search:
        search_term = _escape_like(search.strip())
        if search_term:
            q = q.filter(
                or_(
                    ScrapedJob.title.ilike(f"%{search_term}%"),
                    ScrapedJob.company.ilike(f"%{search_term}%"),
                )
            )
    if location:
        from backend.services.location_parser import fold, location_tag_tokens

        # Tags arrive ";"-joined (a single tag may contain a comma, e.g.
        # "Ottawa, ON"); legacy clients joined plain city names with ",".
        tags = location.split(";") if ";" in location else location.split(",")
        tag_conditions = []
        for tag in tags:
            tag = tag.strip()
            if not tag:
                continue
            if fold(tag) == "remote":
                tag_conditions.append(
                    or_(
                        ScrapedJob.work_type == "remote",
                        ScrapedJob.location_search.like("%|remote|%"),
                        ScrapedJob.location.ilike("%remote%"),
                    )
                )
                continue
            tokens = location_tag_tokens(tag)
            if not tokens:
                continue
            # Exact token-boundary match ("|ottawa|" can't hit Toronto), with
            # a substring fallback for rows the backfill hasn't parsed yet.
            token_match = and_(
                *[ScrapedJob.location_search.like(f"%|{t}|%") for t in tokens]
            )
            legacy_fallback = and_(
                or_(
                    ScrapedJob.location_search.is_(None),
                    ScrapedJob.location_search == "",
                ),
                ScrapedJob.location.ilike(f"%{_escape_like(tokens[0])}%"),
            )
            tag_conditions.append(or_(token_match, legacy_fallback))
        if tag_conditions:
            q = q.filter(or_(*tag_conditions))

    if country:
        country_values = [c.strip().upper() for c in country.split(",") if c.strip()]
        if country_values:
            q = q.filter(ScrapedJob.country.in_(country_values))
    if work_type:
        work_type_values = [w.strip().lower() for w in work_type.split(",") if w.strip()]
        if work_type_values:
            q = q.filter(ScrapedJob.work_type.in_(work_type_values))
    if role_category:
        category_values = [c.strip() for c in role_category.split(",") if c.strip()]
        if category_values:
            from backend.services.role_classifier import expand_filter_values
            q = q.filter(ScrapedJob.role_category.in_(expand_filter_values(category_values)))
    if experience_level:
        level_values = [l.strip() for l in experience_level.split(",") if l.strip()]
        if level_values:
            q = q.filter(
                ScrapedJob.experience_level.in_(expand_experience_filter_values(level_values))
            )

    effective_date = func.coalesce(ScrapedJob.posted_date, ScrapedJob.scraped_at)
    cutoff = date_posted_cutoff(date_posted or "")
    if cutoff is not None:
        q = q.filter(effective_date >= cutoff)

    # id tiebreaker: bulk inserts share timestamps, and ties without a total
    # order make pagination unstable (the same job shows up on two pages).
    if sort == "match":
        q = q.order_by(
            ScrapedJob.match_score.desc(),
            effective_date.desc().nullslast(),
            ScrapedJob.id.desc(),
        )
    else:
        q = q.order_by(effective_date.desc().nullslast(), ScrapedJob.id.desc())

    q = q.offset((page - 1) * page_size).limit(page_size)
    return _overlay_saved(db, q.all(), user_id)


@router.post("/create")
def create_job(
    title: str,
    company: str,
    location: str,
    url: str,
    source_platform: str = "linkedin",
    experience_level: str = "new_grad",
    work_type: str = "onsite",
    country: str = "CA",
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Create a new job listing (admin only — used by scrapers to push jobs)."""
    # Dedup by URL. Query the id, not the entity: loading the row would pull its
    # ~1.9 KB description over the wire just to read back an id. Scrapers call
    # this once per job, hourly, and nearly every call is a duplicate.
    existing = db.query(ScrapedJob.id).filter(ScrapedJob.url == url).first()
    if existing:
        return {"status": "duplicate", "id": existing.id}

    resolved_logo, resolved_domain = resolve_logo(company)
    job = ScrapedJob(
        title=title,
        company=company,
        location=location,
        url=url,
        description="",
        source_platform=source_platform,
        easy_apply=0,
        work_type=work_type,
        role_category="",
        country=country,
        experience_level=experience_level,
        company_logo=resolved_logo,
        company_domain=resolved_domain,
        title_norm=normalize_title(title),
        **location_fields(location),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return {"status": "created", "id": job.id}


@router.post("/ingest-batch")
def ingest_batch(
    batch: IngestBatchIn,
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Bulk-ingest scraped jobs (cron-secret auth — for the JobSpy/LinkedIn
    scraper scripts).

    The per-job /jobs/create path costs one request + one query per job and is
    admin-JWT-only, which the scripts can't send — every call 401'd since
    809c80f. This dedupes the whole batch with ONE url query and bulk-inserts
    the rest.
    """
    from sqlalchemy.exc import IntegrityError
    from backend.services.role_classifier import classify as classify_role
    from backend.services.structured_extraction import detect_employment_type

    received = len(batch.jobs)
    skipped = 0
    duplicates = 0
    unique = {}
    for job in batch.jobs:
        url = canonical_url((job.url or "").strip())
        if not url:
            skipped += 1
            continue
        if url in unique:
            duplicates += 1
            continue
        unique[url] = job

    existing: set[str] = set()
    if unique:
        rows = db.query(ScrapedJob.url).filter(ScrapedJob.url.in_(unique.keys())).all()
        existing = {row[0] for row in rows}

    to_insert = []
    twins_skipped = 0
    for url, job in unique.items():
        if url in existing:
            duplicates += 1
            continue

        posted_date = None
        if job.posted_date:
            try:
                posted_date = datetime.datetime.fromisoformat(job.posted_date)
            except (ValueError, TypeError):
                posted_date = None

        resolved_logo, resolved_domain = resolve_logo(job.company)
        fields = location_fields(job.location)

        # A direct (ats/github) row for this employer+title+city already in
        # the catalogue makes this aggregator copy redundant — skip it.
        if job.source_platform in ("linkedin", "indeed") and has_direct_twin(
            db,
            company=job.company,
            company_domain=resolved_domain,
            title=job.title,
            city=fields["city"],
            country=job.country or "",
        ):
            twins_skipped += 1
            duplicates += 1
            continue

        ingested_at = datetime.datetime.utcnow()
        to_insert.append(
            ScrapedJob(
                title=job.title,
                company=job.company,
                location=job.location,
                url=url,
                description="",
                source_platform=job.source_platform,
                posted_date=posted_date,
                easy_apply=0,
                work_type=job.work_type,
                role_category=classify_role(job.title),
                country=job.country,
                experience_level=job.experience_level,
                company_logo=resolved_logo,
                company_domain=resolved_domain,
                title_norm=normalize_title(job.title),
                # Aggregator rows: nobody re-confirms them, so they enter as
                # low-trust and age out via sweep_aggregator_expiry. Rich
                # extraction happens in cron-backfill once a description lands.
                first_seen_at=ingested_at,
                last_seen_at=ingested_at,
                source_trust="low" if job.source_platform in ("linkedin", "indeed") else "medium",
                employment_type=detect_employment_type(job.title),
                **fields,
            )
        )

    created = 0
    if to_insert:
        db.add_all(to_insert)
        try:
            db.commit()
            created = len(to_insert)
        except IntegrityError:
            # Race: another writer landed one of these URLs between our dedup
            # query and the commit. Retry row by row so the rest still insert.
            db.rollback()
            for row in to_insert:
                db.add(row)
                try:
                    db.commit()
                    created += 1
                except IntegrityError:
                    db.rollback()
                    duplicates += 1

    return {
        "received": received,
        "created": created,
        "duplicates": duplicates,
        "cross_source_twins_skipped": twins_skipped,
        "skipped": skipped,
    }


@router.post("/cron-backfill")
async def cron_backfill(
    batch_size: int = Query(100, ge=1, le=150),
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Bounded repair pass: fetch missing descriptions (<=3 attempts/job,
    direct-URL rows before login-walled LinkedIn/Indeed ones), fill structured
    location + company_domain, and harvest real logos for companies stuck on
    tiny favicons."""
    import asyncio
    import httpx
    from backend.services.logo_harvester import harvest_logo

    needs_description = or_(
        ScrapedJob.description.is_(None),
        func.length(func.trim(ScrapedJob.description)) < 50,
    )
    # LinkedIn/Indeed pages are login-walled og-snippets at best; spend the
    # batch on direct URLs first. false < true in both SQLite and Postgres.
    is_aggregator = or_(
        ScrapedJob.url.ilike("%linkedin.com%"),
        ScrapedJob.url.ilike("%indeed.com%"),
    )
    jobs = (
        db.query(ScrapedJob)
        .filter(
            needs_description,
            func.coalesce(ScrapedJob.desc_fetch_attempts, 0) < 3,
            ScrapedJob.duplicate_of.is_(None),  # hidden twins aren't worth fetches
        )
        .order_by(is_aggregator.asc(), ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    descriptions_fixed = locations_fixed = domains_fixed = 0
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=12, headers=BROWSER_HEADERS
    ) as client:
        # Phase 1: concurrent HTTP only — the Session is not thread/task safe,
        # so every DB mutation happens sequentially in phase 2.
        semaphore = asyncio.Semaphore(6)

        async def fetch(job_id: int, url: str) -> tuple[int, str]:
            async with semaphore:
                try:
                    return job_id, await extract_description_from_url(client, url)
                except Exception:
                    return job_id, ""

        results = await asyncio.gather(
            *[fetch(job.id, job.url) for job in jobs if job.url]
        )
        fetched = dict(results)

        from backend.services.structured_extraction import (
            compute_raw_hash,
            detect_employment_type,
            detect_visa_sponsorship,
            extract_skills,
            parse_salary,
        )

        for job in jobs:
            job.desc_fetch_attempts = (job.desc_fetch_attempts or 0) + 1
            text = fetched.get(job.id, "")
            if text:
                job.description = _sanitize_description(text)
                job.description_sections = None
                descriptions_fixed += 1
                # A description just landed — the structured fields it feeds
                # (visa/skills/salary/type) can finally be extracted.
                job.visa_sponsorship = detect_visa_sponsorship(job.description)
                job.skills = extract_skills(job.title, job.description) or None
                if not job.employment_type:
                    job.employment_type = detect_employment_type(job.title, job.description)
                if not job.salary_min:
                    parsed = parse_salary(job.salary_range or "") or parse_salary(job.description)
                    if parsed:
                        (job.salary_min, job.salary_max,
                         job.salary_currency, job.salary_period) = parsed
                job.raw_hash = compute_raw_hash(job.title, job.location or "",
                                                job.description, job.salary_range or "")
            if not (job.location_search or "") and (job.location or ""):
                for key, value in location_fields(job.location).items():
                    setattr(job, key, value)
                locations_fixed += 1
            if not (job.company_domain or ""):
                logo, domain = resolve_logo(job.company, job.company_url)
                if domain:
                    job.company_domain = domain
                    if not (job.company_logo or "") or "icon.horse" in (job.company_logo or ""):
                        job.company_logo = logo
                    domains_fixed += 1
        db.commit()

        # Phase 3: real-logo harvest for companies still on tiny favicons.
        # sz=128 marks "never probed"; success stores the real logo URL,
        # failure stores the sz=256 favicon as a "probed, favicon-only"
        # sentinel so no domain is fetched twice.
        unprobed = or_(
            ScrapedJob.company_logo.is_(None),
            ScrapedJob.company_logo == "",
            ScrapedJob.company_logo.like("%google.com/s2/favicons%sz=128%"),
            ScrapedJob.company_logo.like("%icon.horse%"),
            ScrapedJob.company_logo.like("%apistemic%"),
        )
        domains = [
            row[0] for row in (
                db.query(ScrapedJob.company_domain)
                .filter(
                    unprobed,
                    ScrapedJob.company_domain.isnot(None),
                    ScrapedJob.company_domain != "",
                    ScrapedJob.duplicate_of.is_(None),
                )
                .group_by(ScrapedJob.company_domain)
                .order_by(func.count(ScrapedJob.id).desc())
                .limit(8)
                .all()
            )
        ]
        logos_harvested = 0
        for domain in domains:
            company = (
                db.query(ScrapedJob.company)
                .filter(ScrapedJob.company_domain == domain)
                .order_by(ScrapedJob.id.desc())
                .limit(1)
                .scalar()
            ) or ""
            # A LinkedIn job page for this company carries its logo when the
            # homepage and Wikidata have nothing.
            linkedin_url = (
                db.query(ScrapedJob.url)
                .filter(
                    ScrapedJob.company_domain == domain,
                    ScrapedJob.url.ilike("%linkedin.com/jobs%"),
                )
                .order_by(ScrapedJob.id.desc())
                .limit(1)
                .scalar()
            ) or ""
            try:
                harvested = await harvest_logo(client, domain, company, linkedin_url)
            except Exception:
                harvested = ""
            new_logo = harvested or (
                f"https://www.google.com/s2/favicons?domain={domain}&sz=256"
            )
            db.query(ScrapedJob).filter(
                ScrapedJob.company_domain == domain, unprobed
            ).update({"company_logo": new_logo}, synchronize_session=False)
            db.commit()
            if harvested:
                logos_harvested += 1

    # New LinkedIn/Indeed rows that duplicate an existing better posting keep
    # arriving between sweeps; absorb them incrementally.
    from backend.services.cross_source_dedup import absorb_new_aggregator_rows
    try:
        twins_absorbed = absorb_new_aggregator_rows(db)
    except Exception:
        db.rollback()
        twins_absorbed = 0

    remaining = (
        db.query(ScrapedJob)
        .filter(
            needs_description,
            func.coalesce(ScrapedJob.desc_fetch_attempts, 0) < 3,
            ScrapedJob.duplicate_of.is_(None),
        )
        .count()
    )
    return {
        "processed": len(jobs),
        "descriptions_fixed": descriptions_fixed,
        "locations_fixed": locations_fixed,
        "domains_fixed": domains_fixed,
        "logo_domains_probed": len(domains),
        "logos_harvested": logos_harvested,
        "twins_absorbed": twins_absorbed,
        "remaining": remaining,
    }


@router.post("/cron-freshness")
async def cron_freshness(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Hourly lifecycle sweep — the half of freshness that board crawls can't
    do: age out rows nothing re-confirms, spot-check stale URLs against
    reality, keep ghost-risk scores current, and adopt legacy rows into board
    reconciliation."""
    import httpx
    from backend.services import listing_freshness

    adopted = listing_freshness.backfill_board_keys(db)
    stale = listing_freshness.sweep_stale(db)
    expired = listing_freshness.sweep_aggregator_expiry(db)

    async with httpx.AsyncClient(
        follow_redirects=True, timeout=10, headers=BROWSER_HEADERS
    ) as client:
        verified = await listing_freshness.verify_stale_listings(db, client)
        # The GitHub lists re-publish closed postings; probe the newest rows —
        # the ones users actually click — so dead apply links leave the
        # catalogue within the hour instead of collecting 404 complaints.
        recent = await listing_freshness.verify_recent_aggregator_listings(
            db, client, limit=120
        )

    ghost = listing_freshness.score_ghost_risk(db)

    return {
        "board_keys_adopted": adopted,
        "marked_stale": stale,
        "expired": expired,
        "stale_verified": verified,
        "recent_verified": recent,
        "ghost_scoring": ghost,
    }


@router.get("/ingest-metrics")
def ingest_metrics(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Pipeline health snapshot: catalogue freshness, ingest volume, dedup
    rate, ghost flags, and the currently-broken boards (dead-letter view).
    Cron-secret auth so the workflow can log it every run."""
    from backend.db.models import SourceHealth
    from backend.services.listing_freshness import LISTING_ACTIVE
    from backend.services.source_health import FAILURE_THRESHOLD

    now = datetime.datetime.utcnow()
    day_ago = now - datetime.timedelta(days=1)
    week_ago = now - datetime.timedelta(days=7)

    by_status = dict(
        db.query(ScrapedJob.listing_status, func.count(ScrapedJob.id))
        .group_by(ScrapedJob.listing_status)
        .all()
    )
    by_trust = dict(
        db.query(ScrapedJob.source_trust, func.count(ScrapedJob.id))
        .filter(ScrapedJob.listing_status == LISTING_ACTIVE)
        .group_by(ScrapedJob.source_trust)
        .all()
    )
    ingested_24h = (
        db.query(ScrapedJob).filter(ScrapedJob.first_seen_at >= day_ago).count()
    )
    ingested_7d = (
        db.query(ScrapedJob).filter(ScrapedJob.first_seen_at >= week_ago).count()
    )
    removed_24h = (
        db.query(ScrapedJob)
        .filter(ScrapedJob.listing_status == "removed",
                ScrapedJob.listing_status_changed_at >= day_ago)
        .count()
    )
    hidden_duplicates = (
        db.query(ScrapedJob).filter(ScrapedJob.duplicate_of.isnot(None)).count()
    )
    total_rows = db.query(ScrapedJob).count()

    active_q = db.query(ScrapedJob).filter(
        ScrapedJob.listing_status == LISTING_ACTIVE,
        ScrapedJob.duplicate_of.is_(None),
    )
    active_total = active_q.count()
    ghost_flagged = active_q.filter(ScrapedJob.ghost_risk_score >= 50).count()

    # Median active listing age without a percentile function (SQLite + PG).
    median_age_days = None
    if active_total:
        midpoint_first_seen = (
            db.query(ScrapedJob.first_seen_at)
            .filter(ScrapedJob.listing_status == LISTING_ACTIVE,
                    ScrapedJob.duplicate_of.is_(None),
                    ScrapedJob.first_seen_at.isnot(None))
            .order_by(ScrapedJob.first_seen_at.desc())
            .offset(active_total // 2)
            .limit(1)
            .scalar()
        )
        if midpoint_first_seen:
            median_age_days = (now - midpoint_first_seen).days

    failing_boards = [
        {
            "board_key": row.board_key,
            "consecutive_failures": row.consecutive_failures,
            "last_error": row.last_error,
            "last_success_at": row.last_success_at.isoformat() if row.last_success_at else None,
        }
        for row in (
            db.query(SourceHealth)
            .filter(SourceHealth.consecutive_failures > 0)
            .order_by(SourceHealth.consecutive_failures.desc())
            .limit(20)
            .all()
        )
    ]
    boards_in_cooldown = (
        db.query(SourceHealth)
        .filter(SourceHealth.consecutive_failures >= FAILURE_THRESHOLD)
        .count()
    )

    return {
        "by_listing_status": by_status,
        "active_by_trust": by_trust,
        "ingested_24h": ingested_24h,
        "ingested_7d": ingested_7d,
        "removed_24h": removed_24h,
        "hidden_duplicates": hidden_duplicates,
        "dedup_rate": round(hidden_duplicates / total_rows, 4) if total_rows else 0.0,
        "active_total": active_total,
        "ghost_flagged": ghost_flagged,
        "ghost_rate": round(ghost_flagged / active_total, 4) if active_total else 0.0,
        "median_active_age_days": median_age_days,
        "failing_boards": failing_boards,
        "boards_in_cooldown": boards_in_cooldown,
    }


@router.get("/stats")
def job_stats(
    user_id: Optional[int] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    """Return aggregate job stats with breakdowns by country, work_type, role_category, experience_level."""
    # Exclude blank-company jobs, hidden duplicates, and dead listings to
    # match the listing query.
    _has_company = (
        ScrapedJob.company.isnot(None)
        & (func.trim(ScrapedJob.company) != "")
        & (ScrapedJob.company != "Unknown")
        & ScrapedJob.duplicate_of.is_(None)
        & or_(
            ScrapedJob.listing_status.is_(None),
            ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES),
        )
    )
    total = db.query(ScrapedJob).filter(_has_company).count()
    applied = db.query(ScrapedJob).filter(_has_company, ScrapedJob.status == JobStatus.APPLIED).count()
    new = db.query(ScrapedJob).filter(_has_company, ScrapedJob.status == JobStatus.NEW).count()
    saved_count = 0
    if user_id is not None:
        saved_count = (
            db.query(UserSavedJob)
            .join(ScrapedJob, ScrapedJob.id == UserSavedJob.job_id)
            .filter(UserSavedJob.user_id == user_id, _has_company)
            .count()
        )

    avg_score = db.query(func.avg(ScrapedJob.match_score)).scalar()
    avg_match_score = round(avg_score) if avg_score else 0

    # Breakdown by country
    by_country = {}
    country_counts = (
        db.query(ScrapedJob.country, func.count(ScrapedJob.id))
        .filter(ScrapedJob.country != "")
        .group_by(ScrapedJob.country)
        .all()
    )
    for country, count in country_counts:
        by_country[country] = count

    # Breakdown by work_type
    by_work_type = {}
    work_type_counts = (
        db.query(ScrapedJob.work_type, func.count(ScrapedJob.id))
        .filter(ScrapedJob.work_type != "")
        .group_by(ScrapedJob.work_type)
        .all()
    )
    for wt, count in work_type_counts:
        by_work_type[wt] = count

    # Breakdown by role_category
    by_role_category = {}
    category_counts = (
        db.query(ScrapedJob.role_category, func.count(ScrapedJob.id))
        .filter(ScrapedJob.role_category != "")
        .group_by(ScrapedJob.role_category)
        .all()
    )
    for cat, count in category_counts:
        by_role_category[cat] = count

    # Breakdown by experience_level
    by_experience_level = {}
    level_counts = (
        db.query(ScrapedJob.experience_level, func.count(ScrapedJob.id))
        .filter(ScrapedJob.experience_level != "")
        .group_by(ScrapedJob.experience_level)
        .all()
    )
    for level, count in level_counts:
        by_experience_level[level] = count

    return {
        "total": total,
        "applied": applied,
        "new": new,
        "saved_count": saved_count,
        "avg_match_score": avg_match_score,
        "by_country": by_country,
        "by_work_type": by_work_type,
        "by_role_category": by_role_category,
        "by_experience_level": by_experience_level,
    }


@router.get("/applications", response_model=list[ApplicationOut])
def list_applications(
    user_id: int = Depends(get_verified_user_id),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List the current user's application records."""
    rows = (
        db.query(ApplicationRecord, ScrapedJob)
        .outerjoin(ScrapedJob, ScrapedJob.id == ApplicationRecord.job_id)
        .filter(ApplicationRecord.user_id == user_id)
        .order_by(ApplicationRecord.applied_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    results = []
    for record, job in rows:
        out = ApplicationOut.model_validate(record)
        if job:
            out.company_logo = job.company_logo
            out.company_domain = job.company_domain
            out.company_url = job.company_url
        results.append(out)
    return results


@router.get("/cities")
def list_cities(
    country: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(12, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """Distinct parsed cities (with counts) for filter autocomplete."""
    from backend.services.location_parser import fold

    query = (
        db.query(ScrapedJob.city, func.count(ScrapedJob.id))
        .filter(
            ScrapedJob.city.isnot(None),
            ScrapedJob.city != "",
            ScrapedJob.duplicate_of.is_(None),
            or_(
                ScrapedJob.listing_status.is_(None),
                ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES),
            ),
        )
    )
    if country:
        query = query.filter(ScrapedJob.country == country.strip().upper())
    if q and q.strip():
        query = query.filter(ScrapedJob.city.like(f"{fold(q)}%"))
    rows = (
        query.group_by(ScrapedJob.city)
        .order_by(func.count(ScrapedJob.id).desc())
        .limit(limit)
        .all()
    )
    return [
        {"city": " ".join(w.capitalize() for w in city.split(" ")), "count": count}
        for city, count in rows
    ]


@router.get("/{job_id}", response_model=ScrapedJobOut)
def get_job(
    job_id: int,
    user_id: Optional[int] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    """Get a single job by ID."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _overlay_saved(db, [job], user_id)[0]


@router.post("/{job_id}/fetch-details")
async def fetch_job_details(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Fetch job description from the apply URL on-demand and cache it."""
    import json
    import httpx
    import ipaddress
    import socket
    from urllib.parse import urlparse

    def _ip_is_internal(ip_str: str) -> bool:
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return True
        return (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        )

    def _is_url_allowed(url: str) -> bool:
        try:
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                return False
            host = parsed.hostname or ""
            if not host:
                return False
            try:
                ipaddress.ip_address(host)
                return not _ip_is_internal(host)
            except ValueError:
                pass
            try:
                infos = socket.getaddrinfo(host, None)
            except Exception:
                return False
            if not infos:
                return False
            return not any(_ip_is_internal(info[4][0]) for info in infos)
        except Exception:
            return False

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    if not job.url or not _is_url_allowed(job.url):
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url or "",
            "company_logo": job.company_logo or "",
        }

    if job.description and len(job.description) > 50:
        if "This button displays the currently selected search type" not in job.description:
            return {
                "id": job.id,
                "description": job.description,
                "apply_url": job.url,
                "company_logo": job.company_logo,
            }
        job.description = ""
        db.commit()

    # Count this as a fetch attempt so the backfill cron stops retrying URLs
    # that fail here too.
    job.desc_fetch_attempts = (job.desc_fetch_attempts or 0) + 1
    db.commit()

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
            response = await client.get(job.url)
            text = response.text
            final_url = str(response.url)

            description = await extract_description_from_html(client, job.url, text, final_url)
            apply_url = final_url if final_url != job.url else job.url

            linkedin_url = "linkedin.com/jobs" in job.url or "linkedin.com/jobs" in final_url
            if linkedin_url:
                if not job.company or job.company.strip() == "":
                    og_title_match = re.search(
                        r'<meta\s+property="og:title"\s+content="([^"]*)"',
                        text, re.IGNORECASE,
                    )
                    if og_title_match:
                        og_title = og_title_match.group(1)
                        at_match = re.search(r'\s+at\s+(.+?)(?:\s*\||\s*-|\s*$)', og_title)
                        hiring_match = re.search(r'^(.+?)\s+hiring\s+', og_title)
                        if at_match:
                            job.company = at_match.group(1).strip()
                        elif hiring_match:
                            job.company = hiring_match.group(1).strip()

                if not job.company_logo:
                    logo_match = re.search(
                        r'<img[^>]*class="[^"]*artdeco-entity-image[^"]*"[^>]*src="([^"]+)"',
                        text, re.IGNORECASE,
                    )
                    if not logo_match:
                        logo_match = re.search(
                            r'<meta\s+property="og:image"\s+content="([^"]*)"',
                            text, re.IGNORECASE,
                        )
                    if logo_match:
                        logo_url = logo_match.group(1)
                        if logo_url.startswith("http") and "linkedin" not in logo_url.lower():
                            job.company_logo = logo_url
                    if not job.company_logo and job.company:
                        cleaned = re.sub(r'[^a-z0-9]', '', job.company.lower())
                        if len(cleaned) >= 2:
                            job.company_logo = f"https://logos-api.apistemic.com/domain:{cleaned}.com?fallback=404"

            next_match = re.search(
                r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
                text, re.DOTALL,
            )
            if next_match:
                try:
                    next_data = json.loads(next_match.group(1))
                    job_result = (
                        next_data.get("props", {})
                        .get("pageProps", {})
                        .get("dataSource", {})
                        .get("jobResult", {})
                    ) or {}
                    if job_result:
                        logo = job_result.get("jdLogo", "")
                        if logo and isinstance(logo, str) and logo.startswith("http") and not job.company_logo:
                            job.company_logo = logo
                        salary = job_result.get("salaryDesc", "")
                        if salary and not job.salary_range:
                            job.salary_range = salary[:255]
                        applicants = job_result.get("applicantsCount")
                        if isinstance(applicants, int) and applicants >= 0 and job.applicant_count is None:
                            job.applicant_count = applicants
                        work_model = (job_result.get("workModel") or "").lower()
                        if work_model:
                            if "remote" in work_model:
                                job.work_type = "remote"
                            elif "hybrid" in work_model:
                                job.work_type = "hybrid"
                            elif "site" in work_model or "office" in work_model:
                                job.work_type = "onsite"
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass

            if not job.company_logo:
                logo_match = re.search(
                    r'<meta\s+property="og:image"\s+content="([^"]*)"',
                    text, re.IGNORECASE,
                )
                if logo_match:
                    logo_url = logo_match.group(1)
                    if logo_url.startswith("http"):
                        job.company_logo = logo_url

            if description:
                job.description = _sanitize_description(description)
                job.description_sections = None  # re-structure the new text

            db.commit()

            return {
                "id": job.id,
                "description": job.description or "",
                "apply_url": apply_url if not linkedin_url else job.url,
                "company_logo": job.company_logo or "",
                "company": job.company or "",
                "company_domain": job.company_domain or "",
                "salary_range": job.salary_range or "",
                "applicant_count": job.applicant_count,
                "work_type": job.work_type or "",
            }
    except Exception as e:
        logger.warning(f"Failed to fetch details for job {job_id}: {e}")
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url,
            "company_logo": job.company_logo or "",
        }


@router.post("/{job_id}/structure-description")
async def structure_description(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Parse a job description into structured sections using Claude AI. Cached in DB."""
    import json
    from backend.services.llm import get_llm_service

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    if not job.description or len(job.description) < 50:
        return {"sections": [], "skills": [], "error": "No description available"}

    # Cache: proper column first, then the legacy company_description JSON hack
    # (rows structured before description_sections existed).
    if isinstance(job.description_sections, dict) and job.description_sections.get("sections"):
        return job.description_sections
    if job.company_description and job.company_description.startswith("{"):
        try:
            cached = json.loads(job.company_description)
            if cached.get("sections"):
                job.description_sections = cached
                db.commit()
                return cached
        except (json.JSONDecodeError, TypeError):
            pass

    llm = get_llm_service()

    prompt = f"""Parse this job description into structured JSON sections. Return ONLY a JSON object:
{{
  "sections": [
    {{"title": "Responsibilities", "icon": "clipboard-list", "items": ["..."]}},
    {{"title": "Qualifications", "icon": "graduation-cap", "subsections": [
      {{"title": "Required", "items": ["..."]}},
      {{"title": "Preferred", "items": ["..."]}}
    ]}},
    {{"title": "Benefits", "icon": "gift", "items": ["..."]}},
    {{"title": "About the Company", "icon": "building", "items": ["..."]}}
  ],
  "skills": ["Python", "SQL", "Stakeholder engagement"],
  "experience_years": "2-4",
  "education": "BS in Computer Science"
}}

Rules:
- Preserve every bullet from the posting in the matching section; do not invent content.
- Qualifications MUST use Required/Preferred subsections when the posting distinguishes them; otherwise put everything under Required.
- "skills" are 5-18 concrete skill tags from the posting: technologies, tools, languages, certifications, and named competencies (e.g. "Bilingualism English/French").
- Omit sections the posting does not contain. Keep items to one sentence.

Job Description:
{job.description[:6000]}"""

    try:
        response = await llm._generate(prompt, model="gpt-4o-mini", json_mode=True)
        data = json.loads(response)
        if data.get("sections"):
            job.description_sections = data
            db.commit()
        return data
    except Exception as e:
        return {"sections": [], "skills": [], "error": str(e)}


@router.post("/{job_id}/save", response_model=ScrapedJobOut)
def save_job(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Save a job (bookmark it) for the current user."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    # Check if already saved
    existing = db.query(UserSavedJob).filter(
        UserSavedJob.user_id == user_id,
        UserSavedJob.job_id == job_id,
    ).first()
    if not existing:
        saved_entry = UserSavedJob(user_id=user_id, job_id=job_id)
        db.add(saved_entry)
        db.commit()
    return _overlay_saved(db, [job], user_id)[0]


@router.post("/{job_id}/unsave", response_model=ScrapedJobOut)
def unsave_job(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Unsave a job (remove bookmark) for the current user."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    db.query(UserSavedJob).filter(
        UserSavedJob.user_id == user_id,
        UserSavedJob.job_id == job_id,
    ).delete()
    db.commit()
    return _overlay_saved(db, [job], user_id)[0]


@router.post("/{job_id}/mark-applied", response_model=ApplicationOut)
def mark_applied(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Record that the current user applied to a job (manual apply confirmation)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    job.status = JobStatus.APPLIED

    record = (
        db.query(ApplicationRecord)
        .filter(ApplicationRecord.user_id == user_id, ApplicationRecord.job_id == job_id)
        .first()
    )
    if record:
        record.applied_at = datetime.datetime.utcnow()
    else:
        record = ApplicationRecord(
            user_id=user_id,
            job_id=job_id,
            platform=job.source_platform or "linkedin",
            company=job.company,
            role=job.title,
            url=job.url,
            applied_at=datetime.datetime.utcnow(),
        )
        db.add(record)

    db.commit()
    db.refresh(record)
    return record


@router.post("/fix-empty-companies")
async def fix_empty_companies(
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Fix jobs with empty company names by extracting from LinkedIn or other sources."""
    import re
    import httpx

    jobs_with_empty_company = (
        db.query(ScrapedJob)
        .filter(ScrapedJob.company == "")
        .limit(50)
        .all()
    )

    fixed = 0
    for job in jobs_with_empty_company:
        company_name = ""

        # Try to extract company from LinkedIn job URL
        if "linkedin.com/jobs/view" in (job.url or ""):
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
                    resp = await client.get(job.url)
                    text = resp.text
                    # LinkedIn og:title format: "Company hiring Title in Location | LinkedIn"
                    og_match = re.search(r'property="og:title"[^>]*content="([^"]*)"', text)
                    if og_match:
                        og_title = og_match.group(1)
                        # Format: "Company hiring Job Title in Location | LinkedIn"
                        if " hiring " in og_title:
                            company_name = og_title.split(" hiring ")[0].strip()
                        elif " at " in og_title:
                            # Alternate format: "Job Title at Company | LinkedIn"
                            company_name = og_title.split(" at ")[1].split("|")[0].strip()
                    if not company_name:
                        # Try title tag: "Company hiring Title..."
                        title_match = re.search(r'<title>([^<]*)</title>', text)
                        if title_match:
                            title_text = title_match.group(1)
                            if " hiring " in title_text:
                                company_name = title_text.split(" hiring ")[0].strip()
            except Exception:
                pass

        if company_name:
            job.company = company_name
            job.company_logo, job.company_domain = resolve_logo(company_name)
            db.commit()
            fixed += 1

    return {"total_empty": len(jobs_with_empty_company), "fixed": fixed}


@router.post("/batch-fix-descriptions")
async def batch_fix_descriptions(
    batch_size: int = Query(20, ge=1, le=50),
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Batch fix jobs with missing or garbage descriptions.

    Processes LinkedIn and Greenhouse/Lever jobs that have empty or garbage descriptions.
    Prioritizes LinkedIn jobs (most common source for missing descriptions).
    """
    import re
    import json
    import httpx

    GARBAGE_PATTERNS = [
        "This button displays the currently selected search type",
        "Sign in to view more",
        "Join now to see",
    ]

    # Find jobs needing description fixes
    jobs_to_fix = (
        db.query(ScrapedJob)
        .filter(
            or_(
                ScrapedJob.description == "",
                ScrapedJob.description == None,
                ScrapedJob.description.ilike("%This button displays%"),
            )
        )
        .limit(batch_size)
        .all()
    )

    fixed = 0
    failed = 0
    results = []

    async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
        for job in jobs_to_fix:
            try:
                description = await extract_description_from_url(client, job.url or "")
                if description:
                    job.description = _sanitize_description(description)
                    job.description_sections = None
                    db.commit()
                    fixed += 1
                    results.append({"id": job.id, "company": job.company, "status": "fixed"})
                else:
                    failed += 1
                    results.append({"id": job.id, "company": job.company, "status": "no_description_found"})
            except Exception as e:
                failed += 1
                results.append({"id": job.id, "company": job.company, "status": f"error: {str(e)[:50]}"})

    return {
        "total_processed": len(jobs_to_fix),
        "fixed": fixed,
        "failed": failed,
        "remaining": db.query(ScrapedJob).filter(
            or_(
                ScrapedJob.description == "",
                ScrapedJob.description == None,
            )
        ).count(),
    }


@router.post("/batch-enrich-salaries")
async def batch_enrich_salaries(
    batch_size: int = Query(50, ge=1, le=200),
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Enrich jobs with salary data from Levels.fyi and known company ranges.

    Uses a mapping of known intern/new-grad salary ranges for major tech companies.
    For companies not in the mapping, attempts to extract from job descriptions.
    """
    import re

    # Known intern/new-grad hourly rates (CAD/USD) from Levels.fyi and public data
    SALARY_MAP = {
        # Big Tech
        "google": "$45-55/hr",
        "amazon": "$40-50/hr",
        "microsoft": "$40-52/hr",
        "apple": "$40-55/hr",
        "meta": "$45-55/hr",
        # Mid-size Tech
        "shopify": "$35-45/hr CAD",
        "databricks": "$45-55/hr",
        "stripe": "$45-55/hr",
        "airbnb": "$45-55/hr",
        "uber": "$42-52/hr",
        "lyft": "$40-50/hr",
        "pinterest": "$40-50/hr",
        "reddit": "$40-50/hr",
        "discord": "$40-50/hr",
        "figma": "$45-55/hr",
        "roblox": "$45-55/hr",
        "robinhood": "$42-52/hr",
        "cloudflare": "$38-48/hr",
        "datadog": "$40-50/hr",
        "mongodb": "$35-45/hr",
        "elastic": "$35-45/hr",
        "twilio": "$38-48/hr",
        "okta": "$35-45/hr",
        "pagerduty": "$35-45/hr",
        "samsara": "$38-48/hr",
        "scale ai": "$45-55/hr",
        "spacex": "$30-38/hr",
        "palantir": "$45-55/hr",
        # Canadian companies
        "ciena": "$25-34/hr CAD",
        "nokia": "$28-38/hr CAD",
        "ericsson": "$28-38/hr CAD",
        "blackberry": "$25-35/hr CAD",
        "kinaxis": "$25-35/hr CAD",
        "ross video": "$22-30/hr CAD",
        "fullscript": "$25-35/hr CAD",
        "solace": "$28-38/hr CAD",
        "fortinet": "$30-40/hr CAD",
        # Finance
        "jane street": "$55-65/hr",
        "citadel": "$55-65/hr",
        "two sigma": "$50-60/hr",
        # Other
        "nvidia": "$42-55/hr",
        "intel": "$30-40/hr",
        "amd": "$30-40/hr",
        "qualcomm": "$32-42/hr",
        "broadcom": "$32-42/hr",
        "cisco": "$30-40/hr",
        "ibm": "$25-35/hr",
        "oracle": "$30-40/hr",
        "salesforce": "$40-50/hr",
        "adobe": "$38-48/hr",
        "vmware": "$35-45/hr",
        "splunk": "$38-48/hr",
        "atlassian": "$40-50/hr",
        "snap": "$42-52/hr",
        "doordash": "$40-50/hr",
        "instacart": "$38-48/hr",
        "coinbase": "$45-55/hr",
        "block": "$40-50/hr",
        "square": "$40-50/hr",
        "affirm": "$42-52/hr",
        "brex": "$40-50/hr",
        "chime": "$38-48/hr",
        "sofi": "$35-45/hr",
        "toast": "$35-45/hr",
        "gusto": "$38-48/hr",
        "vercel": "$35-45/hr",
        "netlify": "$35-45/hr",
        "webflow": "$35-45/hr",
        "duolingo": "$40-50/hr",
        "epic games": "$38-48/hr",
        "riot games": "$38-48/hr",
        "unity": "$35-45/hr",
        "waymo": "$45-55/hr",
        "nuro": "$42-52/hr",
        "zoox": "$42-52/hr",
        "lucid motors": "$35-45/hr",
        "roku": "$38-48/hr",
        "peloton": "$35-45/hr",
        "dropbox": "$40-50/hr",
        "asana": "$40-50/hr",
        "gitlab": "$35-45/hr",
        "new relic": "$35-45/hr",
        "cockroachdb": "$38-48/hr",
        "contentful": "$35-45/hr",
        "flexport": "$38-48/hr",
        "faire": "$38-48/hr",
        "squarespace": "$38-48/hr",
        "wattpad": "$25-35/hr CAD",
        "vanta": "$40-50/hr",
    }

    # Find jobs without salary data (newest first so recent jobs get enriched first)
    jobs_to_enrich = (
        db.query(ScrapedJob)
        .filter(
            or_(
                ScrapedJob.salary_range == "",
                ScrapedJob.salary_range == None,
            ),
            ScrapedJob.experience_level.in_(["internship", "new_grad"]),
        )
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    enriched = 0
    for job in jobs_to_enrich:
        company_lower = job.company.lower().strip()

        # Check direct match
        salary = SALARY_MAP.get(company_lower)

        # Check partial match (e.g., "Scale AI" matches "scale ai")
        if not salary:
            for key, val in SALARY_MAP.items():
                if key in company_lower or company_lower in key:
                    salary = val
                    break

        # Try to extract from description
        if not salary and job.description:
            # Look for patterns like "$XX/hr", "$XX-$YY/hr", "$XX,000-$YY,000"
            hr_match = re.search(r'\$(\d+(?:\.\d+)?)\s*[-–]\s*\$?(\d+(?:\.\d+)?)\s*/\s*(?:hr|hour)', job.description, re.IGNORECASE)
            if hr_match:
                salary = f"${hr_match.group(1)}-${hr_match.group(2)}/hr"
            else:
                annual_match = re.search(r'\$(\d{2,3}),?(\d{3})\s*[-–]\s*\$?(\d{2,3}),?(\d{3})', job.description)
                if annual_match:
                    low = int(annual_match.group(1) + annual_match.group(2))
                    high = int(annual_match.group(3) + annual_match.group(4))
                    if low > 10000 and high > 10000:
                        salary = f"${low:,}-${high:,}/yr"

        if salary:
            job.salary_range = salary
            db.commit()
            enriched += 1

    remaining = db.query(ScrapedJob).filter(
        or_(
            ScrapedJob.salary_range == "",
            ScrapedJob.salary_range == None,
        ),
        ScrapedJob.experience_level.in_(["internship", "new_grad"]),
    ).count()

    return {
        "total_processed": len(jobs_to_enrich),
        "enriched": enriched,
        "remaining_without_salary": remaining,
    }
