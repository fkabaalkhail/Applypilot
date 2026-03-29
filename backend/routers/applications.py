"""
Application tracking endpoints.

GET  /applications           — list with filters and pagination
PATCH /applications/{id}     — update status/notes
GET  /applications/stats     — aggregate dashboard stats
GET  /applications/review    — paginated review list with screenshots, cover letters, etc.
GET  /applications/export    — CSV download of all application records
"""

import csv
import datetime
import io
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_

from backend.db.database import get_db
from backend.db.models import ApplicationRecord, ApplicationStatus, ScrapedJob, ConnectionRequest
from backend.schemas.application import ApplicationOut, ApplicationReview, ApplicationUpdate, ApplicationStats

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/stats", response_model=ApplicationStats)
def get_stats(db: Session = Depends(get_db)):
    """Return aggregate application statistics for the dashboard."""
    total = db.query(func.count(ApplicationRecord.id)).scalar() or 0

    week_ago = datetime.datetime.utcnow() - datetime.timedelta(days=7)
    this_week = (
        db.query(func.count(ApplicationRecord.id))
        .filter(ApplicationRecord.applied_at >= week_ago)
        .scalar()
    ) or 0

    by_platform_rows = (
        db.query(ApplicationRecord.platform, func.count(ApplicationRecord.id))
        .group_by(ApplicationRecord.platform)
        .all()
    )
    by_platform = {row[0]: row[1] for row in by_platform_rows}

    by_status_rows = (
        db.query(ApplicationRecord.status, func.count(ApplicationRecord.id))
        .group_by(ApplicationRecord.status)
        .all()
    )
    by_status = {row[0].value if hasattr(row[0], "value") else row[0]: row[1] for row in by_status_rows}

    return ApplicationStats(
        total=total,
        this_week=this_week,
        by_platform=by_platform,
        by_status=by_status,
    )


@router.get("", response_model=list[ApplicationOut])
def list_applications(
    status: Optional[ApplicationStatus] = None,
    platform: Optional[str] = None,
    date_from: Optional[datetime.date] = None,
    date_to: Optional[datetime.date] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List applications with optional filters and pagination."""
    q = db.query(ApplicationRecord)

    if status:
        q = q.filter(ApplicationRecord.status == status)
    if platform:
        q = q.filter(ApplicationRecord.platform == platform)
    if date_from:
        q = q.filter(ApplicationRecord.applied_at >= datetime.datetime.combine(date_from, datetime.time.min))
    if date_to:
        q = q.filter(ApplicationRecord.applied_at <= datetime.datetime.combine(date_to, datetime.time.max))

    q = q.order_by(ApplicationRecord.applied_at.desc())
    q = q.offset((page - 1) * page_size).limit(page_size)

    return q.all()


@router.patch("/{app_id}", response_model=ApplicationOut)
def update_application(
    app_id: int,
    update: ApplicationUpdate,
    db: Session = Depends(get_db),
):
    """Update status and/or notes on an existing application."""
    record = db.query(ApplicationRecord).filter(ApplicationRecord.id == app_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Application not found.")

    if update.status is not None:
        record.status = update.status
    if update.notes is not None:
        record.notes = update.notes

    db.commit()
    db.refresh(record)
    return record


@router.get("/review", response_model=list[ApplicationReview])
def review_applications(
    status: Optional[ApplicationStatus] = None,
    search: Optional[str] = Query(None, description="Search by company, role, or status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Paginated application review with screenshots, cover letters, and Q&A."""
    q = db.query(ApplicationRecord)

    if status:
        q = q.filter(ApplicationRecord.status == status)

    if search:
        term = f"%{search}%"
        q = q.filter(
            or_(
                ApplicationRecord.company.ilike(term),
                ApplicationRecord.role.ilike(term),
                ApplicationRecord.status.ilike(term),
            )
        )

    total = q.count()
    q = q.order_by(ApplicationRecord.applied_at.desc())
    q = q.offset((page - 1) * page_size).limit(page_size)

    return q.all()


@router.get("/export")
def export_applications_csv(db: Session = Depends(get_db)):
    """Generate and stream a CSV file with all application records and joined job data."""
    records = (
        db.query(ApplicationRecord, ScrapedJob)
        .outerjoin(ScrapedJob, ApplicationRecord.job_id == ScrapedJob.id)
        .order_by(ApplicationRecord.applied_at.desc())
        .all()
    )

    # Also fetch connection requests keyed by job_id for HR contact info
    connections = (
        db.query(ConnectionRequest)
        .all()
    )
    conn_by_job: dict[int, ConnectionRequest] = {}
    for c in connections:
        if c.job_id and c.job_id not in conn_by_job:
            conn_by_job[c.job_id] = c

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Job ID", "Title", "Company", "Location", "Work Style",
        "Description Excerpt", "Experience Required", "Skills",
        "HR Contact Name", "HR Contact Link", "Resume Used",
        "Date Posted", "Date Applied", "Job Link",
        "Questions Found", "Status",
    ])

    for app, job in records:
        hr = conn_by_job.get(app.job_id)
        desc_excerpt = ""
        if job and job.description:
            desc_excerpt = job.description[:200].replace("\n", " ")

        skills = ""
        if job and job.requirements_detail:
            skills = "; ".join(
                r.get("req", "") for r in (job.requirements_detail or []) if r.get("met")
            )

        questions = ""
        if app.questions_answered:
            questions = "; ".join(
                q.get("question", "") for q in (app.questions_answered or [])
            )

        writer.writerow([
            app.job_id or "",
            app.role,
            app.company,
            job.location if job else "",
            job.company_description[:50] if job and job.company_description else "",
            desc_excerpt,
            job.experience_years_required if job else "",
            skills,
            hr.contact_name if hr else "",
            "",  # HR contact link — not stored separately
            app.resume_version or "original",
            job.scraped_at.isoformat() if job and job.scraped_at else "",
            app.applied_at.isoformat() if app.applied_at else "",
            app.url or (job.url if job else ""),
            questions,
            app.status.value if hasattr(app.status, "value") else str(app.status),
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=applications_export.csv"},
    )
