"""
Job listing endpoints (data only — no bot automation).

GET  /jobs          — list scraped jobs with filters
GET  /jobs/{id}     — get a single job
GET  /jobs/stats    — aggregate stats
POST /jobs/{id}/save   — save a job
POST /jobs/{id}/unsave — unsave a job
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.db.database import get_db
from backend.db.models import ScrapedJob, JobStatus
from backend.schemas.jobs import ScrapedJobOut

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("", response_model=list[ScrapedJobOut])
def list_jobs(
    status: Optional[JobStatus] = None,
    min_score: int = Query(0, ge=0),
    source: Optional[str] = None,
    saved: Optional[int] = None,
    location: Optional[str] = None,
    country: Optional[str] = None,
    work_type: Optional[str] = None,
    role_category: Optional[str] = None,
    experience_level: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status, match score, source, country, work_type, etc."""
    q = db.query(ScrapedJob).filter(ScrapedJob.match_score >= min_score)
    if status:
        q = q.filter(ScrapedJob.status == status)
    if source:
        q = q.filter(ScrapedJob.source_platform == source)
    if saved is not None:
        q = q.filter(ScrapedJob.saved == saved)
    if location:
        city_values = [c.strip() for c in location.split(",") if c.strip()]
        if city_values:
            from sqlalchemy import or_
            location_conditions = [
                ScrapedJob.location.ilike(f"%{city}%") for city in city_values
            ]
            q = q.filter(or_(*location_conditions))

    # Aggregator filters (AND logic across different filter types, OR within same filter)
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
            q = q.filter(ScrapedJob.role_category.in_(category_values))
    if experience_level:
        level_values = [l.strip().lower() for l in experience_level.split(",") if l.strip()]
        if level_values:
            q = q.filter(ScrapedJob.experience_level.in_(level_values))

    # Default sort: posted_date descending (newest first)
    q = q.order_by(ScrapedJob.posted_date.desc().nullslast())
    q = q.offset((page - 1) * page_size).limit(page_size)
    return q.all()


@router.get("/stats")
def job_stats(db: Session = Depends(get_db)):
    """Return aggregate job stats with breakdowns by country, work_type, role_category, experience_level."""
    total = db.query(ScrapedJob).count()
    applied = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.APPLIED).count()
    new = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.NEW).count()
    saved_count = db.query(ScrapedJob).filter(ScrapedJob.saved == 1).count()

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


@router.get("/{job_id}", response_model=ScrapedJobOut)
def get_job(job_id: int, db: Session = Depends(get_db)):
    """Get a single job by ID."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.post("/{job_id}/fetch-details")
async def fetch_job_details(job_id: int, db: Session = Depends(get_db)):
    """Fetch job description from the jobright page on-demand.

    Scrapes the schema.org structured data from the jobright page to get
    the full job description. Caches the result in the database.
    """
    import re
    import json
    import httpx

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    # If we already have a description, return cached data
    if job.description and len(job.description) > 50:
        return {
            "id": job.id,
            "description": job.description,
            "apply_url": job.url,
            "company_logo": job.company_logo,
        }

    # Fetch the jobright page and extract structured data
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            response = await client.get(job.url)
            text = response.text

        # Extract schema.org JobPosting description
        schema_match = re.search(
            r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
            text, re.DOTALL
        )
        if schema_match:
            try:
                schema_data = json.loads(schema_match.group(1))
                if schema_data.get("@type") == "JobPosting":
                    desc_html = schema_data.get("description", "")
                    # Strip HTML tags for plain text display
                    desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                    desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                    if desc_text:
                        job.description = desc_text
                        db.commit()
            except (json.JSONDecodeError, KeyError):
                pass

        # Try to get company logo from __NEXT_DATA__
        if not job.company_logo:
            next_match = re.search(
                r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
                text, re.DOTALL
            )
            if next_match:
                try:
                    next_data = json.loads(next_match.group(1))
                    job_result = (next_data.get("props", {})
                                  .get("pageProps", {})
                                  .get("dataSource", {})
                                  .get("jobResult", {}))
                    logo = job_result.get("jdLogo", "")
                    if logo and logo.startswith("http"):
                        job.company_logo = logo
                        db.commit()
                except (json.JSONDecodeError, KeyError):
                    pass

        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url,
            "company_logo": job.company_logo or "",
        }
    except Exception as e:
        logger.warning(f"Failed to fetch details for job {job_id}: {e}")
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url,
            "company_logo": job.company_logo or "",
        }


@router.post("/{job_id}/save", response_model=ScrapedJobOut)
def save_job(job_id: int, db: Session = Depends(get_db)):
    """Save a job (bookmark it)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job.saved = 1
    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/unsave", response_model=ScrapedJobOut)
def unsave_job(job_id: int, db: Session = Depends(get_db)):
    """Unsave a job (remove bookmark)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job.saved = 0
    db.commit()
    db.refresh(job)
    return job
