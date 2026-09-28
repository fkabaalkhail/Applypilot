"""
GitHub source management endpoints.

GET    /github-sources           → list[GitHubSourceOut]
POST   /github-sources           → GitHubSourceOut
POST   /github-sources/seed      → SeedResult
PUT    /github-sources/{id}      → GitHubSourceOut
DELETE /github-sources/{id}      → None
POST   /github-sources/{id}/poll → PollResult
"""

import asyncio
import os
import re
import datetime
import logging
import time
import traceback
from contextlib import aclosing

from fastapi import APIRouter, Depends, HTTPException
from typing import Optional
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import GitHubSource
from backend.schemas.github_source import GitHubSourceOut, GitHubSourceCreate
from backend.services.github_scraper import GitHubScraper, validate_github_repo_url
from backend.services.role_classifier import classify as classify_role
from backend.services.location_parser import location_fields
from backend.services.cross_source_dedup import mark_inferior_twins, normalize_title
from backend.auth.dependencies import get_admin_user_id, verify_cron_secret

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_github_url(url: str) -> tuple[str, str]:
    """Extract owner and repo name from a GitHub URL."""
    match = re.match(r'https://github\.com/([^/]+)/([^/]+)/?$', url)
    if not match:
        raise HTTPException(status_code=422, detail="Invalid GitHub repository URL.")
    return match.group(1), match.group(2)


@router.get("", response_model=list[GitHubSourceOut])
def list_sources(
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """List all configured GitHub sources."""
    return db.query(GitHubSource).all()


@router.post("", response_model=GitHubSourceOut)
def create_source(
    source: GitHubSourceCreate,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Add a new GitHub repository source."""
    if not validate_github_repo_url(source.repo_url):
        raise HTTPException(status_code=422, detail="Invalid GitHub repository URL.")

    # Check for duplicate
    existing = db.query(GitHubSource).filter(GitHubSource.repo_url == source.repo_url).first()
    if existing:
        raise HTTPException(status_code=409, detail="This repository is already configured.")

    owner, repo_name = _parse_github_url(source.repo_url)

    db_source = GitHubSource(
        repo_url=source.repo_url,
        repo_owner=owner,
        repo_name=repo_name,
        file_path=source.file_path,
        poll_interval_minutes=source.poll_interval_minutes,
    )
    db.add(db_source)
    db.commit()
    db.refresh(db_source)
    return db_source


@router.post("/seed")
async def seed_sources(
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Seed all jobright-ai repositories. Idempotent.

    Creates GitHubSource records for all configured repositories.
    Skips any that already exist. Returns counts of created vs existing.
    """
    try:
        from backend.services.aggregator import AggregatorService
        aggregator = AggregatorService(db)
        result = await aggregator.seed_sources()
        return {
            "status": "seeded",
            "created": result["created"],
            "existing": result["existing"],
            "total": result["created"] + result["existing"],
        }
    except Exception:
        logger.error(f"Seed failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/cleanup-jobright")
def cleanup_jobright_jobs(
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Remove all jobs with jobright.ai URLs from the database.

    One-time cleanup to remove redirect-only jobs.
    """
    from backend.db.models import ScrapedJob as SJ
    count = db.query(SJ).filter(SJ.url.like("%jobright.ai%")).delete(synchronize_session=False)
    # Also remove jobright sources
    source_count = db.query(GitHubSource).filter(GitHubSource.repo_url.like("%jobright-ai%")).delete(synchronize_session=False)
    db.commit()
    return {"deleted_jobs": count, "deleted_sources": source_count}


@router.post("/cleanup-blank-companies")
def cleanup_blank_companies(
    dry_run: bool = True,
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Remove jobs with empty/placeholder company names.

    These render as blank cards with no logo on the dashboard (mostly old
    LinkedIn rows whose company failed to parse). The scraper now rejects
    these at write time and the listing API hides them; this permanently
    removes the historical ones. Authenticated via cron secret.

    Defaults to dry_run=True (counts only). Pass ?dry_run=false to delete.
    """
    from backend.db.models import ScrapedJob as SJ
    from sqlalchemy import or_, func

    blank_filter = or_(
        SJ.company.is_(None),
        func.trim(SJ.company) == "",
        SJ.company == "Unknown",
    )
    q = db.query(SJ).filter(blank_filter)
    count = q.count()
    if dry_run:
        return {"dry_run": True, "would_delete": count}

    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"dry_run": False, "deleted_jobs": deleted}


# New Workday rows need one detail request each for their description (the
# list payload has none, and the public page is JS-rendered so cron-backfill
# can't recover it later). Cap per run; jobs past the cap simply stay
# un-inserted and surface as "new" again on the board's next shard pass.
WORKDAY_DETAIL_BUDGET = 40

# Wall-clock budget, from the start of the run, for paging big boards past
# their newest-first head. Full lists are what let Workday boards reconcile
# (BMO is ~50 list POSTs, Parsons ~100), but the whole run shares one request
# with the workflow's 300 s curl. Boards still paging at the deadline finish
# partial: they confirm what they listed and remove nothing.
CRON_ATS_LIST_BUDGET_SECONDS = float(os.getenv("CRON_ATS_LIST_BUDGET_SECONDS", "150"))

# Boards crawled at once. Never two on one API host, so Greenhouse, Lever,
# Ashby and SmartRecruiters boards still go one after another at the per-host
# pace; the parallelism is mostly Workday tenants, each its own host.
CRON_ATS_CONCURRENCY = max(1, int(os.getenv("CRON_ATS_CONCURRENCY", "6")))

_IN_CHUNK = 400  # keep IN () lists comfortably under driver parameter limits

# Launch order: the boards that page the longest go first, so they page while
# the single-request boards stream through the remaining slots.
_LAUNCH_ORDER = {"workday": 0, "smartrecruiters": 1}


async def _crawl_boards(scraper, client, boards: list[tuple[str, str, str]],
                        concurrency: int = CRON_ATS_CONCURRENCY):
    """Crawl boards concurrently, yielding ((platform, slug, name), snapshot,
    error) as each one finishes. At most ``concurrency`` crawls are in flight
    and never two on the same API host. A failed crawl yields its exception
    in place of a snapshot, so one bad board never sinks the run."""
    from backend.services.ats_scraper import board_host

    queue = [
        (board, board_host(board[0], board[1]))
        for board in sorted(boards, key=lambda board: _LAUNCH_ORDER.get(board[0], 2))
    ]
    running: dict[asyncio.Task, tuple[tuple[str, str, str], str]] = {}

    async def crawl(board):
        try:
            return await scraper.scrape_board(client, *board), None
        except Exception as e:
            return None, e

    def launch():
        busy = {host for _board, host in running.values()}
        i = 0
        while i < len(queue) and len(running) < concurrency:
            board, host = queue[i]
            if host in busy:
                i += 1
                continue
            queue.pop(i)
            busy.add(host)
            running[asyncio.ensure_future(crawl(board))] = (board, host)

    try:
        launch()
        while running:
            done, _pending = await asyncio.wait(set(running), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                board, _host = running.pop(task)
                launch()
                snapshot, error = task.result()
                yield board, snapshot, error
    finally:
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)


def _confirm_listed(db: Session, board_key: str, urls: set[str],
                    now: Optional[datetime.datetime] = None) -> dict:
    """The confirm half of reconciliation, for partial snapshots.

    Every URL a board lists is live, even when the crawl couldn't list the
    whole board: bump those rows' ``last_seen_at`` and bring any stale or
    removed ones back to active. Rows the partial list didn't mention are left
    alone, its silence is not evidence of removal (reconcile_board's remove
    half only ever runs on complete snapshots). UPDATEs only, nothing is read
    back. Commits. Returns counts.
    """
    from backend.db.models import ScrapedJob
    from backend.services.listing_freshness import (
        LISTING_ACTIVE, LISTING_EXPIRED, LISTING_REMOVED, LISTING_STALE,
    )

    now = now or datetime.datetime.utcnow()
    stats = {"confirmed": 0, "revived": 0}
    listed = sorted(url for url in urls if url)
    for i in range(0, len(listed), _IN_CHUNK):
        on_board = (ScrapedJob.board_key == board_key,
                    ScrapedJob.url.in_(listed[i:i + _IN_CHUNK]))
        stats["revived"] += (
            db.query(ScrapedJob)
            .filter(*on_board, ScrapedJob.listing_status.in_(
                (LISTING_REMOVED, LISTING_STALE, LISTING_EXPIRED)))
            .update({"listing_status": LISTING_ACTIVE, "listing_status_changed_at": now},
                    synchronize_session=False)
        )
        stats["confirmed"] += (
            db.query(ScrapedJob)
            .filter(*on_board)
            .update({"last_seen_at": now}, synchronize_session=False)
        )
    if listed:
        db.commit()
    return stats


def _adopt_site_rows(db: Session, platform: str, slug: str, board_key: str) -> int:
    """Give a shared Workday tenant's rows to the career site that lists them.

    One tenant can host several sites (BlackBerry and QNX both live on tenant
    "bb"), but board_key_from_url() only names the tenant, so legacy rows of
    both sites share "workday:bb". Such sites get their own registry slugs;
    this moves the rows under this site's URL root onto its key before the
    crawl matches or reconciles, so one site's complete crawl can never mark
    the other site's rows removed. A no-op for single-site tenants, whose
    slug already is the tenant. Commits when it moves anything.
    """
    if platform != "workday":
        return 0
    from backend.data.company_registry import load_workday_bases
    from backend.db.models import ScrapedJob
    from backend.services.ats_scraper import workday_public_base
    from backend.services.listing_freshness import board_key_from_url

    site_root = workday_public_base(load_workday_bases().get(slug, ""))
    if not site_root:
        return 0
    site_root += "/"
    tenant_key = board_key_from_url(site_root)
    if not tenant_key or tenant_key == board_key:
        return 0

    moved = (
        db.query(ScrapedJob)
        .filter(ScrapedJob.board_key == tenant_key,
                ScrapedJob.url.startswith(site_root, autoescape=True))
        .update({"board_key": board_key}, synchronize_session=False)
    )
    if moved:
        db.commit()
    return moved


def _migrate_smartrecruiters_urls(db: Session, snapshot) -> int:
    """Point legacy SmartRecruiters rows at their real posting page.

    Rows stored before the URL fix carry careers.smartrecruiters.com URLs,
    which redirect to the company careers home. When the board lists the
    posting, rewrite the row to the jobs.smartrecruiters.com URL the crawl now
    builds, so refresh and reconcile match it instead of inserting a twin and
    (on a complete board) removing the original. A row whose new URL another
    row already holds (url is UNIQUE) is left for reconciliation to settle.
    Commits when it rewrites anything. Returns the count.
    """
    if snapshot.platform != "smartrecruiters":
        return 0
    from backend.db.models import ScrapedJob
    from backend.services.ats_scraper import smartrecruiters_legacy_url

    legacy_to_new = {smartrecruiters_legacy_url(url): url for url in snapshot.all_urls}
    legacy_to_new.pop("", None)
    legacy = sorted(legacy_to_new)

    migrated = 0
    for i in range(0, len(legacy), _IN_CHUNK):
        found = (
            db.query(ScrapedJob.id, ScrapedJob.url)
            .filter(ScrapedJob.url.in_(legacy[i:i + _IN_CHUNK]))
            .all()
        )
        if not found:
            continue
        wanted = [legacy_to_new[url] for _row_id, url in found]
        taken = {
            url for (url,) in
            db.query(ScrapedJob.url).filter(ScrapedJob.url.in_(wanted)).all()
        }
        for row_id, url in found:
            if legacy_to_new[url] in taken:
                continue
            db.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                {"url": legacy_to_new[url]}, synchronize_session=False,
            )
            migrated += 1
    if migrated:
        db.commit()
    return migrated


@router.post("/cron-ats")
async def cron_ats(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Crawl the least-recently-crawled shard of ATS boards: ingest new
    listings, re-confirm known ones (last_seen_at), and reconcile each board
    so vanished postings are marked removed the same run, the freshness edge
    over aggregators.

    Per-board failures are isolated and recorded in source_health; a board
    failing repeatedly is skipped for a cooldown (circuit breaker) instead of
    burning the run's budget. Filters to entry-level + US/Canada only.
    """
    try:
        from backend.db.models import ScrapedJob
        from backend.services.ats_scraper import ATSScraper, fetch_workday_detail
        from backend.services.country_filter import CountryFilter
        from backend.services.work_type_classifier import WorkTypeClassifier
        from backend.services.logo_resolver import resolve_logo
        from backend.services import listing_freshness, source_health
        from backend.data import company_registry

        scraper = ATSScraper(
            filter_entry_level=True, filter_north_america=True,
            deadline=time.monotonic() + CRON_ATS_LIST_BUDGET_SECONDS,
        )
        country_filter = CountryFilter()
        work_type_classifier = WorkTypeClassifier()
        logo_map = company_registry.load_logo_map()

        # The workflow's "hourly" schedule really fires ~6x a day at uneven
        # gaps, so hour % shard_count can hand the same shard several runs in
        # a row. Crawl whichever shard has waited longest instead.
        shard_index, shard_count, companies = company_registry.pick_shard(
            company_registry.load_companies(), source_health.last_success_times(db)
        )

        import httpx
        from backend.services.description_extractor import (
            extract_smartrecruiters_from_url,
            sanitize_description,
        )

        health_map = source_health.get_health_map(
            db, [f"{p}:{s}" for p, s, _ in companies]
        )

        totals = {
            "total_found": 0, "new_jobs": 0, "refreshed": 0, "edited": 0,
            "removed": 0, "revived": 0, "cross_source_twins_hidden": 0,
            "boards_failed": 0, "boards_skipped_cooldown": 0,
            "boards_partial": 0, "partial_confirmed": 0, "urls_migrated": 0,
        }
        workday_detail_budget = WORKDAY_DETAIL_BUDGET

        runnable = []
        for platform, slug, company_name in companies:
            if source_health.in_cooldown(health_map.get(f"{platform}:{slug}")):
                totals["boards_skipped_cooldown"] += 1
            else:
                runnable.append((platform, slug, company_name))

        async with httpx.AsyncClient(timeout=30) as client, aclosing(
            _crawl_boards(scraper, client, runnable)
        ) as crawl:
            async for (platform, slug, company_name), snapshot, error in crawl:
                board_key = f"{platform}:{slug}"

                if error is not None:
                    totals["boards_failed"] += 1
                    source_health.record_failure(db, board_key, platform, slug, repr(error))
                    continue

                totals["total_found"] += len(snapshot.jobs)

                # Pull legacy rows onto the key and URL this crawl uses, so
                # they are matched below rather than duplicated or removed.
                _adopt_site_rows(db, platform, slug, board_key)
                totals["urls_migrated"] += _migrate_smartrecruiters_urls(db, snapshot)

                # Re-confirm known listings (and detect edits); get the new ones.
                new_jobs, refresh_stats = listing_freshness.refresh_known_listings(
                    db, board_key, snapshot.jobs
                )
                totals["refreshed"] += refresh_stats["refreshed"]
                totals["edited"] += refresh_stats["edited"]

                for job in new_jobs:
                    # Board APIs carry descriptions for GH/Lever/Ashby;
                    # SmartRecruiters/Workday need one extra call per NEW job only.
                    description = (job.description or "").strip()
                    if not description and platform == "smartrecruiters":
                        try:
                            description = await extract_smartrecruiters_from_url(client, job.url)
                        except Exception:
                            description = ""
                    elif not description and platform == "workday":
                        if workday_detail_budget <= 0:
                            continue  # re-surfaces as new on the next pass
                        workday_detail_budget -= 1
                        try:
                            detail = await fetch_workday_detail(client, slug, job.detail_ref)
                            description = detail.get("description", "")
                            if detail.get("employment_type") and not job.employment_type:
                                job.employment_type = detail["employment_type"]
                        except Exception:
                            description = ""
                    description = sanitize_description(description) if description else ""
                    job.description = description

                    # Classify country
                    country = country_filter.classify(job.location)
                    if not country:
                        country = "US"  # ATS scraper already filtered to NA

                    # Classify work type
                    work_type = job.work_type or work_type_classifier.classify(job.location)

                    # Determine experience level from title
                    title_lower = job.title.lower()
                    if "intern" in title_lower or "co-op" in title_lower or "coop" in title_lower:
                        experience_level = "internship"
                    else:
                        experience_level = "new_grad"

                    # Resolve an accurate logo: prefer the curated registry logo,
                    # otherwise derive one from the company domain.
                    resolved_logo, resolved_domain = resolve_logo(job.company)
                    company_logo = logo_map.get(job.company.strip().lower()) or resolved_logo

                    scraped_job = ScrapedJob(
                        title=job.title,
                        company=job.company,
                        location=job.location,
                        url=job.url,
                        description=description,
                        source_platform="ats",
                        title_norm=normalize_title(job.title),
                        **location_fields(job.location),
                        posted_date=job.posted_date,
                        easy_apply=0,
                        work_type=work_type,
                        role_category=classify_role(job.title, job.department or ""),
                        country=country,
                        experience_level=experience_level,
                        company_logo=company_logo,
                        company_domain=resolved_domain,
                        **listing_freshness.build_new_row_fields(job, board_key),
                    )
                    db.add(scraped_job)
                    try:
                        db.commit()
                        totals["new_jobs"] += 1
                    except Exception:
                        db.rollback()
                        continue

                    # This direct row supersedes any LinkedIn/Indeed copies of the
                    # same posting that arrived first.
                    try:
                        totals["cross_source_twins_hidden"] += mark_inferior_twins(db, scraped_job)
                    except Exception:
                        db.rollback()

                # Reconcile the board's stored rows against what it just listed.
                # Only a complete listing votes on removals; a partial one (a
                # board past Workday's ceiling, a spent crawl budget) still
                # proves every URL it listed is live.
                if snapshot.complete:
                    rec = listing_freshness.reconcile_board(db, board_key, snapshot.all_urls)
                    totals["removed"] += rec["removed"]
                    totals["revived"] += rec["revived"]
                else:
                    totals["boards_partial"] += 1
                    seen = _confirm_listed(db, board_key, snapshot.all_urls)
                    totals["partial_confirmed"] += seen["confirmed"]
                    totals["revived"] += seen["revived"]

                source_health.record_success(db, board_key, platform, slug, len(snapshot.jobs))

        return {
            "status": "completed",
            **totals,
            # Back-compat alias: known listings are refreshed now, not skipped.
            "duplicates_skipped": totals["refreshed"],
            "shard": {
                "index": shard_index,
                "count": shard_count,
                "companies": len(companies),
            },
        }
    except Exception:
        logger.error(f"ATS cron failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/scrape-linkedin")
async def scrape_linkedin_jobs(
    city: Optional[str] = None,
    query: Optional[str] = None,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Scrape LinkedIn public job search for intern/new-grad/co-op positions.

    Pass ?city=Ottawa&query=intern to scrape a single query for a single city (fast).
    Without params, scrapes all cities and queries (may timeout on serverless).
    """
    try:
        from backend.db.models import ScrapedJob
        from backend.services.linkedin_scraper import LinkedInScraper, CITIES, QUERIES
        from backend.services.country_filter import CountryFilter
        from backend.services.work_type_classifier import WorkTypeClassifier

        scraper = LinkedInScraper(request_delay=2.0)
        country_filter = CountryFilter()
        work_type_classifier = WorkTypeClassifier()

        if city and query:
            # Single query + single city (fastest, fits serverless timeout)
            city_match = next(
                ((c, p) for c, p in CITIES if c.lower() == city.lower()),
                None
            )
            if not city_match:
                return {"error": f"City '{city}' not found. Available: {[c for c, _ in CITIES]}"}
            jobs = await scraper.scrape_single(query, city_match[0], city_match[1])
            # Return immediately with parsed results for debugging
            return {
                "status": "completed",
                "total_found": len(jobs),
                "jobs_preview": [{"title": j.title, "company": j.company, "location": j.location, "url": j.url} for j in jobs[:5]],
            }
        elif city:
            # All queries for one city
            city_match = next(
                ((c, p) for c, p in CITIES if c.lower() == city.lower()),
                None
            )
            if not city_match:
                return {"error": f"City '{city}' not found. Available: {[c for c, _ in CITIES]}"}
            jobs = await scraper.scrape_city(city_match[0], city_match[1])
        else:
            jobs = await scraper.scrape_all()

        new_count = 0
        skipped_dupe = 0
        for job in jobs:
            # Dedup by URL. Query the column, not the entity: loading the row
            # would pull its ~1.9 KB description across the wire for a boolean.
            existing = db.query(ScrapedJob.url).filter(ScrapedJob.url == job.url).first()
            if existing:
                skipped_dupe += 1
                continue

            # Classify country
            country = country_filter.classify(job.location)
            if not country:
                country = "CA"

            # Classify work type
            work_type = work_type_classifier.classify(job.location)

            # Determine experience level from title
            title_lower = job.title.lower()
            if "intern" in title_lower or "co-op" in title_lower or "coop" in title_lower:
                experience_level = "internship"
            elif "new grad" in title_lower or "new graduate" in title_lower:
                experience_level = "new_grad"
            else:
                experience_level = "new_grad"

            # Resolve logo from the company domain, never guess "<name>.com".
            from backend.services.logo_resolver import resolve_logo as _resolve_logo
            company_logo, company_domain = _resolve_logo(job.company)

            # Parse the card's posted date (ISO "YYYY-MM-DD") when present.
            posted_date = None
            if job.posted_date:
                try:
                    posted_date = datetime.datetime.fromisoformat(job.posted_date)
                except (ValueError, TypeError):
                    posted_date = None

            scraped_job = ScrapedJob(
                title=job.title,
                company=job.company,
                location=job.location,
                url=job.url,
                description="",
                source_platform="linkedin",
                posted_date=posted_date,
                easy_apply=0,
                work_type=work_type,
                role_category=classify_role(job.title),
                country=country,
                experience_level=experience_level,
                company_logo=company_logo,
                company_domain=company_domain,
                **location_fields(job.location),
            )
            db.add(scraped_job)
            try:
                db.commit()
                new_count += 1
            except Exception:
                db.rollback()
                skipped_dupe += 1

        return {
            "status": "completed",
            "total_found": len(jobs),
            "new_jobs": new_count,
            "duplicates_skipped": skipped_dupe,
        }
    except Exception:
        logger.error(f"LinkedIn scrape failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/cron-poll")
async def cron_poll(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Seed sources (if needed) and poll the next batch of overdue GitHub sources."""
    try:
        from backend.services.aggregator import AggregatorService
        aggregator = AggregatorService(db)

        seed_result = await aggregator.seed_sources()

        sources = (
            db.query(GitHubSource)
            .filter(GitHubSource.status == "active")
            .order_by(GitHubSource.last_polled_at.asc().nullsfirst())
            .limit(5)
            .all()
        )

        if not sources:
            return {"status": "no_sources", "sources_seeded": seed_result["created"]}

        polled: list[dict] = []
        total_new = 0
        total_enriched = 0
        for source in sources:
            new_count = await aggregator.poll_source(source)
            enriched = await aggregator._enrich_missing_descriptions(source.id, limit=3)
            total_new += new_count
            total_enriched += enriched
            polled.append(
                {
                    "source": source.repo_name,
                    "new_jobs": new_count,
                    "descriptions_enriched": enriched,
                }
            )

        global_enriched = await aggregator._enrich_missing_descriptions(None, limit=40)

        # Email users about new strong matches. Folded in here (rather than a
        # separate cron) so the app stays within Vercel's 2-cron Hobby limit.
        # Best-effort: a failure here must not fail the poll.
        match_alerts: dict = {}
        try:
            from backend.services.match_notifier import sweep_match_alerts
            match_alerts = await sweep_match_alerts(db)
        except Exception:
            logger.error(f"Match-alert sweep failed: {traceback.format_exc()}")

        return {
            "status": "completed",
            "sources_seeded": seed_result["created"],
            "sources_polled": len(sources),
            "new_jobs": total_new,
            "descriptions_enriched": total_enriched,
            "global_descriptions_enriched": global_enriched,
            "polled": polled,
            "match_alerts": match_alerts,
        }
    except Exception:
        logger.error(f"Cron poll failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/{source_id}", response_model=GitHubSourceOut)
def update_source(
    source_id: int,
    source: GitHubSourceCreate,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Update a GitHub source configuration."""
    db_source = db.query(GitHubSource).filter(GitHubSource.id == source_id).first()
    if not db_source:
        raise HTTPException(status_code=404, detail="GitHub source not found.")

    if not validate_github_repo_url(source.repo_url):
        raise HTTPException(status_code=422, detail="Invalid GitHub repository URL.")

    owner, repo_name = _parse_github_url(source.repo_url)

    db_source.repo_url = source.repo_url
    db_source.repo_owner = owner
    db_source.repo_name = repo_name
    db_source.file_path = source.file_path
    db_source.poll_interval_minutes = source.poll_interval_minutes
    db.commit()
    db.refresh(db_source)
    return db_source


@router.delete("/{source_id}")
def delete_source(
    source_id: int,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Remove a GitHub source."""
    db_source = db.query(GitHubSource).filter(GitHubSource.id == source_id).first()
    if not db_source:
        raise HTTPException(status_code=404, detail="GitHub source not found.")

    db.delete(db_source)
    db.commit()
    return {"status": "deleted"}


@router.post("/{source_id}/poll")
async def poll_source(
    source_id: int,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Trigger an immediate poll of a GitHub source."""
    db_source = db.query(GitHubSource).filter(GitHubSource.id == source_id).first()
    if not db_source:
        raise HTTPException(status_code=404, detail="GitHub source not found.")

    scraper = GitHubScraper(db)
    try:
        jobs = await scraper.fetch_jobs(db_source)
        new_count = await scraper._store_jobs(jobs, db_source)
        return {"status": "polled", "new_jobs": new_count, "total_found": len(jobs)}
    except Exception:
        logger.error(f"Poll failed for source {source_id}: {traceback.format_exc()}")
        raise HTTPException(status_code=502, detail="Internal server error")


@router.post("/backfill-role-categories")
def backfill_role_categories(
    apply: bool = False,
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Remap existing scraped_jobs.role_category to the canonical taxonomy.

    Dry-run by default (returns the counts that would change). Pass ?apply=true
    to write the changes. Rows already canonical are left untouched; known
    legacy aliases are mapped; empty/free-text values are reclassified by title.
    """
    from backend.db.models import ScrapedJob
    from backend.services.role_classifier import (
        CANONICAL_CATEGORIES, classify, normalize_category,
    )

    def target(title: str, current: str) -> str:
        cur = (current or "").strip()
        if cur in CANONICAL_CATEGORIES:
            return cur
        mapped = normalize_category(cur)
        if mapped:
            return mapped
        return classify(title or "", cur)

    rows = db.query(ScrapedJob).all()
    changes: dict[int, str] = {}
    for r in rows:
        new = target(r.title, r.role_category)
        if new != (r.role_category or ""):
            changes[r.id] = new

    if apply:
        for r in rows:
            if r.id in changes:
                r.role_category = changes[r.id]
        db.commit()

    return {
        "total_rows": len(rows),
        "changed": len(changes),
        "applied": apply,
    }
