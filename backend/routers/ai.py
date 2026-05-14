"""
AI-powered endpoints for match analysis, resume tailoring, and cover letter generation.

POST /ai/match-breakdown/{job_id}  → MatchBreakdown
POST /ai/tailor-resume/{job_id}    → TailoredResumeOut
POST /ai/cover-letter/{job_id}     → CoverLetterOut
POST /ai/analyze-fit/{job_id}      → FitAnalysis
"""

import datetime
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ScrapedJob, ResumeProfileDB
from backend.auth.dependencies import get_current_user_id
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import TailoredResumeOut, CoverLetterOut
from backend.services.match_engine import MatchEngine
from backend.services.resume_tailor import ResumeTailor
from backend.services.cover_letter import CoverLetterGenerator

logger = logging.getLogger(__name__)
router = APIRouter()

LLM_503_DETAIL = "AI service unavailable. Please check your Gemini API key."


def _get_resume_text(db: Session, user_id: int) -> str:
    """Get the user's resume text from their primary or most recent profile."""
    # Prefer primary resume
    profile = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.user_id == user_id, ResumeProfileDB.is_primary == 1)
        .first()
    )
    if not profile:
        profile = (
            db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.user_id == user_id)
            .order_by(ResumeProfileDB.created_at.desc())
            .first()
        )
    if not profile or not profile.raw_text:
        raise HTTPException(
            status_code=400,
            detail="No resume profile found. Please upload a resume first.",
        )
    return profile.raw_text


def _get_job(job_id: int, db: Session) -> ScrapedJob:
    """Get a job by ID or raise 404."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.post("/match-breakdown/{job_id}", response_model=MatchBreakdown)
async def match_breakdown(
    job_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Compute match score breakdown for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db, user_id)

    try:
        engine = MatchEngine(db)
        return await engine.compute_breakdown(resume_text, job.description)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/tailor-resume/{job_id}", response_model=TailoredResumeOut)
async def tailor_resume(
    job_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Generate a tailored resume for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db, user_id)

    try:
        tailor = ResumeTailor(db)
        result = await tailor.tailor_resume(resume_text, job.description, job_id, user_id=user_id)
        return result
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/cover-letter/{job_id}", response_model=CoverLetterOut)
async def cover_letter(
    job_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Generate a cover letter for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db, user_id)

    try:
        generator = CoverLetterGenerator()
        text = await generator.generate(resume_text, job.description, job.company)
        return CoverLetterOut(
            text=text,
            job_id=job_id,
            generated_at=datetime.datetime.utcnow(),
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/analyze-fit/{job_id}", response_model=FitAnalysis)
async def analyze_fit(
    job_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Get detailed fit analysis for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db, user_id)

    try:
        engine = MatchEngine(db)
        return await engine.analyze_fit(resume_text, job.description)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/batch-score")
async def batch_score_jobs(
    batch_size: int = 10,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Score the newest unscored jobs against the user's resume.

    Call this after uploading a resume to populate match scores for the job list.
    Processes up to batch_size jobs that have descriptions but no match score.
    """
    resume_text = _get_resume_text(db, user_id)

    # Find jobs with descriptions but no match score (newest first)
    from sqlalchemy import or_, func
    jobs_to_score = (
        db.query(ScrapedJob)
        .filter(
            ScrapedJob.match_score == 0,
            ScrapedJob.description != "",
            ScrapedJob.description != None,
            func.length(ScrapedJob.description) > 50,
        )
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    scored = 0
    errors = 0
    engine = MatchEngine(db)

    for job in jobs_to_score:
        try:
            result = await engine.compute_breakdown(resume_text, job.description)
            job.match_score = result.overall_score
            job.experience_score = result.experience_score
            job.skill_score = result.skill_score
            job.industry_score = result.industry_score
            job.match_label = result.match_label
            db.commit()
            scored += 1
        except Exception:
            errors += 1
            continue

    return {
        "scored": scored,
        "errors": errors,
        "remaining": db.query(ScrapedJob).filter(
            ScrapedJob.match_score == 0,
            ScrapedJob.description != "",
            ScrapedJob.description != None,
        ).count(),
    }


@router.post("/batch-score")
async def batch_score_jobs(
    batch_size: int = 20,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Score the top unscored jobs against the user's resume.

    Processes jobs that have descriptions but no match score yet.
    Prioritizes newest jobs first.
    """
    resume_text = _get_resume_text(db, user_id)

    # Find jobs with descriptions but no match score
    jobs_to_score = (
        db.query(ScrapedJob)
        .filter(
            ScrapedJob.match_score == 0,
            ScrapedJob.description != "",
            ScrapedJob.description != None,
        )
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    scored = 0
    errors = 0
    try:
        engine = MatchEngine(db)
        for job in jobs_to_score:
            if not job.description or len(job.description) < 50:
                continue
            try:
                breakdown = await engine.compute_breakdown(resume_text, job.description)
                job.match_score = breakdown.overall_score
                job.experience_score = breakdown.experience_score
                job.skill_score = breakdown.skill_score
                job.industry_score = breakdown.industry_score
                job.match_label = breakdown.match_label
                db.commit()
                scored += 1
            except Exception as e:
                errors += 1
                logger.warning(f"Failed to score job {job.id}: {e}")
    except (ConnectionError,):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    return {
        "scored": scored,
        "errors": errors,
        "remaining": db.query(ScrapedJob).filter(
            ScrapedJob.match_score == 0,
            ScrapedJob.description != "",
            ScrapedJob.description != None,
        ).count(),
    }
