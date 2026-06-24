"""
Resume upload and parsing endpoints.

POST /resumes/upload — accepts PDF or DOCX, extracts text, analyzes via Claude,
stores profile in DB, returns typed ResumeProfile.
GET /resumes — list all resumes for the current user.
GET /resumes/{id} — get full resume detail including profile and analysis report.
"""

import datetime
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ResumeProfileDB, ScrapedJob
from backend.auth.dependencies import get_verified_user_id
from backend.schemas.resume import (
    ResumeProfile,
    ResumeUploadResponse,
    ResumeListItem,
    ResumeDetailResponse,
    ResumeUpdateRequest,
    AnalysisReport,
)
from backend.services.resume_parser import extract_text
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("", response_model=list[ResumeListItem])
def list_resumes(
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """List all resumes for the current user, ordered by most recently created first."""
    records = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.user_id == user_id)
        .order_by(ResumeProfileDB.created_at.desc())
        .all()
    )
    return [
        ResumeListItem(
            id=r.id,
            name=r.name,
            target_job_title=r.target_job_title,
            is_primary=bool(r.is_primary),
            status=r.status,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
        for r in records
    ]


@router.put("/{resume_id}/primary", response_model=ResumeDetailResponse)
def set_primary_resume(
    resume_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Set a resume as primary, unsetting all others for this user."""
    record = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")

    # Unset all user's resumes as primary
    db.query(ResumeProfileDB).filter(ResumeProfileDB.user_id == user_id).update(
        {ResumeProfileDB.is_primary: 0}
    )
    # Set the target resume as primary
    record.is_primary = 1
    db.commit()
    db.refresh(record)

    profile = ResumeProfile(
        name=record.profile_name or "",
        email=record.email or "",
        phone=record.phone or "",
        location=record.location or "",
        linkedin_url=record.linkedin_url or "",
        github_url=record.github_url or "",
        other_link=record.other_link or "",
        skills=record.skills or [],
        experience=record.experience or [],
        education=record.education or [],
        projects=record.projects or [],
        technologies=record.technologies or {},
    )

    analysis_report = None
    if record.analysis_report is not None:
        analysis_report = AnalysisReport(**record.analysis_report)

    return ResumeDetailResponse(
        id=record.id,
        name=record.name,
        target_job_title=record.target_job_title,
        is_primary=bool(record.is_primary),
        profile=profile,
        analysis_report=analysis_report,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.post("/{resume_id}/analyze", response_model=AnalysisReport)
async def analyze_resume(
    resume_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Run AI quality analysis on a resume and persist the report."""
    record = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")

    if not record.raw_text:
        raise HTTPException(status_code=422, detail="Resume has no extracted text to analyze.")

    llm = get_llm_service()
    try:
        report = await llm.analyze_resume_quality(record.raw_text)
    except Exception as e:
        logger.error("AI quality analysis failed: %s", e)
        raise HTTPException(status_code=502, detail=f"AI quality analysis failed: {e}")

    record.analysis_report = report.model_dump()
    record.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(record)

    return report


@router.get("/{resume_id}", response_model=ResumeDetailResponse)
def get_resume(
    resume_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Get full resume detail by id, including profile and analysis report."""
    record = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")

    profile = ResumeProfile(
        name=record.profile_name or "",
        email=record.email or "",
        phone=record.phone or "",
        location=record.location or "",
        linkedin_url=record.linkedin_url or "",
        github_url=record.github_url or "",
        other_link=record.other_link or "",
        skills=record.skills or [],
        experience=record.experience or [],
        education=record.education or [],
        projects=record.projects or [],
        technologies=record.technologies or {},
    )

    analysis_report = None
    if record.analysis_report is not None:
        analysis_report = AnalysisReport(**record.analysis_report)

    return ResumeDetailResponse(
        id=record.id,
        name=record.name,
        target_job_title=record.target_job_title,
        is_primary=bool(record.is_primary),
        profile=profile,
        analysis_report=analysis_report,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.put("/{resume_id}", response_model=ResumeDetailResponse)
def update_resume(
    resume_id: int,
    body: ResumeUpdateRequest,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Update a resume's name, target_job_title, and/or profile fields."""
    record = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")

    if body.name is not None:
        record.name = body.name
    if body.target_job_title is not None:
        record.target_job_title = body.target_job_title
    if body.profile is not None:
        profile = body.profile
        record.profile_name = profile.name
        record.email = profile.email
        record.phone = profile.phone
        record.location = profile.location
        record.linkedin_url = profile.linkedin_url
        record.github_url = profile.github_url
        record.other_link = profile.other_link
        record.skills = profile.skills
        record.experience = [exp.model_dump() for exp in profile.experience]
        record.education = [edu.model_dump() for edu in profile.education]
        record.projects = [proj.model_dump() for proj in profile.projects]
        record.technologies = profile.technologies

    record.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(record)

    response_profile = ResumeProfile(
        name=record.profile_name or "",
        email=record.email or "",
        phone=record.phone or "",
        location=record.location or "",
        linkedin_url=record.linkedin_url or "",
        github_url=record.github_url or "",
        other_link=record.other_link or "",
        skills=record.skills or [],
        experience=record.experience or [],
        education=record.education or [],
        projects=record.projects or [],
        technologies=record.technologies or {},
    )

    analysis_report = None
    if record.analysis_report is not None:
        analysis_report = AnalysisReport(**record.analysis_report)

    return ResumeDetailResponse(
        id=record.id,
        name=record.name,
        target_job_title=record.target_job_title,
        is_primary=bool(record.is_primary),
        profile=response_profile,
        analysis_report=analysis_report,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.delete("/{resume_id}", status_code=204)
def delete_resume(
    resume_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Delete a resume by id. Returns 204 on success, 404 if not found."""
    record = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")
    db.delete(record)
    db.commit()


@router.post("/upload", response_model=ResumeUploadResponse)
async def upload_resume(
    file: UploadFile = File(...),
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Upload a PDF or DOCX resume, parse it, and store the profile."""
    if file.content_type not in (
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are accepted.")

    # File size limit: 10 MB
    MAX_FILE_SIZE = 10 * 1024 * 1024
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 10 MB.")
    filename = file.filename or "resume"

    # Extract raw text
    try:
        raw_text = extract_text(content, filename)
    except Exception as e:
        logger.error("Text extraction failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Could not extract text: {e}")

    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="Extracted text is empty.")

    # Analyze with Claude (graceful degradation if rate limited)
    llm = get_llm_service()
    profile = None
    try:
        profile = await llm.analyze_resume(raw_text)
    except Exception as e:
        logger.warning("AI analysis failed (will save raw text): %s", e)
        # Don't fail the upload — save with basic info extracted from text
        from backend.schemas.resume import ResumeProfile as RP
        profile = RP(name=file.filename.rsplit(".", 1)[0] if file.filename else "")

    # Persist to DB
    db_profile = ResumeProfileDB(
        user_id=user_id,
        name=file.filename.rsplit(".", 1)[0] if file.filename else "Untitled Resume",
        profile_name=profile.name,
        email=profile.email,
        phone=profile.phone,
        location=profile.location,
        linkedin_url=profile.linkedin_url,
        github_url=profile.github_url,
        other_link=profile.other_link,
        skills=profile.skills,
        experience=[exp.model_dump() for exp in profile.experience],
        education=[edu.model_dump() for edu in profile.education],
        projects=[proj.model_dump() for proj in profile.projects],
        technologies=profile.technologies,
        raw_text=raw_text,
        status="analyzed" if profile.experience else "uploaded",
    )
    db.add(db_profile)
    db.commit()
    db.refresh(db_profile)

    # Trigger batch scoring for top jobs in background
    import asyncio
    from backend.services.match_engine import MatchEngine

    async def _score_top_jobs():
        try:
            engine = MatchEngine(db)
            jobs_to_score = (
                db.query(ScrapedJob)
                .filter(
                    ScrapedJob.match_score == 0,
                    ScrapedJob.description != "",
                    ScrapedJob.description != None,
                )
                .order_by(ScrapedJob.id.desc())
                .limit(10)
                .all()
            )
            for job in jobs_to_score:
                if job.description and len(job.description) > 50:
                    try:
                        breakdown = await engine.compute_breakdown(raw_text, job.description)
                        job.match_score = breakdown.overall_score
                        job.experience_score = breakdown.experience_score
                        job.skill_score = breakdown.skill_score
                        job.industry_score = breakdown.industry_score
                        job.match_label = breakdown.match_label
                        db.commit()
                    except Exception:
                        pass
        except Exception:
            pass

    asyncio.ensure_future(_score_top_jobs())

    return ResumeUploadResponse(id=db_profile.id, profile=profile)
