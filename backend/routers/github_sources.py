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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import GitHubSource
from backend.schemas.github_source import GitHubSourceOut, GitHubSourceCreate
from backend.services.github_scraper import GitHubScraper, validate_github_repo_url

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_github_url(url: str) -> tuple[str, str]:
    """Extract owner and repo name from a GitHub URL."""
    match = re.match(r'https://github\.com/([^/]+)/([^/]+)/?$', url)
    if not match:
        raise HTTPException(status_code=422, detail="Invalid GitHub repository URL.")
    return match.group(1), match.group(2)


@router.get("", response_model=list[GitHubSourceOut])
def list_sources(db: Session = Depends(get_db)):
    """List all configured GitHub sources."""
    return db.query(GitHubSource).all()


@router.post("", response_model=GitHubSourceOut)
def create_source(source: GitHubSourceCreate, db: Session = Depends(get_db)):
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
async def seed_sources(db: Session = Depends(get_db)):
    """Seed all 9 jobright-ai repositories. Idempotent.

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
    except Exception as e:
        import traceback
        logger.error(f"Seed failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Seed failed: {str(e)}")


@router.api_route("/cron-poll", methods=["GET", "POST"])
async def cron_poll(db: Session = Depends(get_db)):
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
    except Exception as e:
        import traceback
        logger.error(f"Cron poll failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Cron poll failed: {str(e)}")


@router.put("/{source_id}", response_model=GitHubSourceOut)
def update_source(source_id: int, source: GitHubSourceCreate, db: Session = Depends(get_db)):
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
def delete_source(source_id: int, db: Session = Depends(get_db)):
    """Remove a GitHub source."""
    db_source = db.query(GitHubSource).filter(GitHubSource.id == source_id).first()
    if not db_source:
        raise HTTPException(status_code=404, detail="GitHub source not found.")

    db.delete(db_source)
    db.commit()
    return {"status": "deleted"}


@router.post("/{source_id}/poll")
async def poll_source(source_id: int, db: Session = Depends(get_db)):
    """Trigger an immediate poll of a GitHub source."""
    db_source = db.query(GitHubSource).filter(GitHubSource.id == source_id).first()
    if not db_source:
        raise HTTPException(status_code=404, detail="GitHub source not found.")

    scraper = GitHubScraper(db)
    try:
        jobs = await scraper.fetch_jobs(db_source)
        new_count = await scraper._store_jobs(jobs, db_source)
        return {"status": "polled", "new_jobs": new_count, "total_found": len(jobs)}
    except Exception as e:
        logger.error(f"Poll failed for source {source_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Poll failed: {str(e)}")
