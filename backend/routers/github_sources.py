"""
GitHub source management endpoints.

GET    /github-sources           → list[GitHubSourceOut]
POST   /github-sources           → GitHubSourceOut
POST   /github-sources/seed      → SeedResult
PUT    /github-sources/{id}      → GitHubSourceOut
DELETE /github-sources/{id}      → None
POST   /github-sources/{id}/poll → PollResult
"""

import re
import logging
import traceback

from fastapi import APIRouter, Depends, HTTPException
from typing import Optional
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import GitHubSource
from backend.schemas.github_source import GitHubSourceOut, GitHubSourceCreate
from backend.services.github_scraper import GitHubScraper, validate_github_repo_url
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


@router.post("/cron-ats")
async def cron_ats(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Scrape ATS platforms (Greenhouse, Lever) for intern/new-grad jobs.

    Polls all configured companies' public ATS APIs and stores jobs
    with direct apply links. Filters to entry-level + US/Canada only.
    Designed to be called by Vercel Cron Jobs on a schedule.
    """
    try:
        from backend.db.models import ScrapedJob
        from backend.services.ats_scraper import ATSScraper
        from backend.services.country_filter import CountryFilter
        from backend.services.work_type_classifier import WorkTypeClassifier
        from backend.services.logo_resolver import resolve_logo
        from backend.data.company_registry import load_logo_map

        scraper = ATSScraper(filter_entry_level=True, filter_north_america=True)
        country_filter = CountryFilter()
        work_type_classifier = WorkTypeClassifier()
        logo_map = load_logo_map()

        jobs = await scraper.scrape_all()

        new_count = 0
        skipped_dupe = 0
        for job in jobs:
            # Dedup by URL
            existing = db.query(ScrapedJob).filter(ScrapedJob.url == job.url).first()
            if existing:
                skipped_dupe += 1
                continue

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
                description="",
                source_platform="ats",
                posted_date=job.posted_date,
                easy_apply=0,
                work_type=work_type,
                role_category=job.department or "",
                country=country,
                experience_level=experience_level,
                company_logo=company_logo,
                company_domain=resolved_domain,
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
            # Dedup by URL
            existing = db.query(ScrapedJob).filter(ScrapedJob.url == job.url).first()
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

            # Generate company logo URL
            cleaned_company = re.sub(r'[^a-z0-9]', '', job.company.lower())
            company_logo = f"https://icon.horse/icon/{cleaned_company}.com"

            scraped_job = ScrapedJob(
                title=job.title,
                company=job.company,
                location=job.location,
                url=job.url,
                description="",
                source_platform="linkedin",
                posted_date=None,
                easy_apply=0,
                work_type=work_type,
                role_category="",
                country=country,
                experience_level=experience_level,
                company_logo=company_logo,
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
    """Seed sources (if needed) and poll the next overdue source.

    Designed to be called by Vercel Cron Jobs on a schedule.
    Seeds first (idempotent), then polls ONE source (the most overdue).
    Call multiple times to poll all sources.
    """
    try:
        from backend.services.aggregator import AggregatorService
        aggregator = AggregatorService(db)

        # Seed first (idempotent — no-op if already seeded)
        seed_result = await aggregator.seed_sources()

        # Poll just the most overdue source (to stay within Vercel timeout)
        source = (
            db.query(GitHubSource)
            .filter(GitHubSource.status == "active")
            .order_by(GitHubSource.last_polled_at.asc().nullsfirst())
            .first()
        )

        if not source:
            return {"status": "no_sources", "sources_seeded": seed_result["created"]}

        new_count = await aggregator.poll_source(source)
        return {
            "status": "completed",
            "sources_seeded": seed_result["created"],
            "source_polled": source.repo_name,
            "new_jobs": new_count,
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
