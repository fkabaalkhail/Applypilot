"""
Job listing endpoints (data only — no bot automation).

GET  /jobs          — list scraped jobs with filters
GET  /jobs/{id}     — get a single job
GET  /jobs/stats    — aggregate stats
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ScrapedJob, JobStatus
from backend.schemas.jobs import ScrapedJobOut

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("", response_model=list[ScrapedJobOut])
def list_jobs(
    status: Optional[JobStatus] = None,
    min_score: int = Query(0, ge=0),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status and match score."""
    q = db.query(ScrapedJob).filter(ScrapedJob.match_score >= min_score)
    if status:
        q = q.filter(ScrapedJob.status == status)
    q = q.order_by(ScrapedJob.match_score.desc())
    q = q.offset((page - 1) * page_size).limit(page_size)
    return q.all()


@router.get("/stats")
def job_stats(db: Session = Depends(get_db)):
    """Return aggregate job stats."""
    total = db.query(ScrapedJob).count()
    applied = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.APPLIED).count()
    new = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.NEW).count()
    return {"total": total, "applied": applied, "new": new}


@router.get("/{job_id}", response_model=ScrapedJobOut)
def get_job(job_id: int, db: Session = Depends(get_db)):
    """Get a single job by ID."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job
