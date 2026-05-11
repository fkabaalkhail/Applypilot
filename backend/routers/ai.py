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
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import TailoredResumeOut, CoverLetterOut
from backend.services.match_engine import MatchEngine
from backend.services.resume_tailor import ResumeTailor
from backend.services.cover_letter import CoverLetterGenerator

logger = logging.getLogger(__name__)
router = APIRouter()

LLM_503_DETAIL = "AI service unavailable. Please check your Gemini API key."


def _get_resume_text(db: Session) -> str:
    """Get the user's resume text from the most recent profile."""
    profile = db.query(ResumeProfileDB).order_by(
        ResumeProfileDB.created_at.desc()
    ).first()
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
async def match_breakdown(job_id: int, db: Session = Depends(get_db)):
    """Compute match score breakdown for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db)

    try:
        engine = MatchEngine(db)
        return await engine.compute_breakdown(resume_text, job.description)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/tailor-resume/{job_id}", response_model=TailoredResumeOut)
async def tailor_resume(job_id: int, db: Session = Depends(get_db)):
    """Generate a tailored resume for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db)

    try:
        tailor = ResumeTailor(db)
        result = await tailor.tailor_resume(resume_text, job.description, job_id)
        return result
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/cover-letter/{job_id}", response_model=CoverLetterOut)
async def cover_letter(job_id: int, db: Session = Depends(get_db)):
    """Generate a cover letter for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db)

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
async def analyze_fit(job_id: int, db: Session = Depends(get_db)):
    """Get detailed fit analysis for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db)

    try:
        engine = MatchEngine(db)
        return await engine.analyze_fit(resume_text, job.description)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)
