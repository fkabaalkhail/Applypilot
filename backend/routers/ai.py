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
from backend.auth.dependencies import get_verified_user_id
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import (
    TailoredResumeOut,
    CoverLetterOut,
    JobAnalysisOut,
    RewriteIn,
    RewriteOut,
    CoverLetterIn,
)
from backend.services.match_engine import MatchEngine
from backend.services.resume_tailor import ResumeTailor
from backend.services.cover_letter import CoverLetterGenerator

logger = logging.getLogger(__name__)
router = APIRouter()

LLM_503_DETAIL = "AI service unavailable. Please check your Gemini API key."


def _resolve_resume(
    db: Session, user_id: int, resume_id: int | None = None
) -> ResumeProfileDB:
    """Resolve which resume to use: explicit resume_id → primary → most recent."""
    profile = None
    if resume_id is not None:
        profile = (
            db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.id == resume_id, ResumeProfileDB.user_id == user_id)
            .first()
        )
        if not profile:
            raise HTTPException(status_code=404, detail="Resume not found.")

    if profile is None:
        profile = (
            db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.user_id == user_id, ResumeProfileDB.is_primary == 1)
            .first()
            or db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.user_id == user_id)
            .order_by(ResumeProfileDB.created_at.desc())
            .first()
        )

    if not profile or not profile.raw_text:
        raise HTTPException(
            status_code=400,
            detail="No resume profile found. Please upload a resume first.",
        )
    return profile


def _get_resume_text(db: Session, user_id: int) -> str:
    """Get the user's resume text from their primary or most recent profile."""
    return _resolve_resume(db, user_id).raw_text


def _get_job(job_id: int, db: Session) -> ScrapedJob:
    """Get a job by ID or raise 404."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.post("/match-breakdown/{job_id}", response_model=MatchBreakdown)
async def match_breakdown(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
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
    user_id: int = Depends(get_verified_user_id),
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
    body: CoverLetterIn | None = None,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Generate (or regenerate in a tone) a cover letter for a job.

    The body is optional — existing callers that POST with no body still get a
    fresh letter from the primary resume.
    """
    job = _get_job(job_id, db)
    resume = _resolve_resume(db, user_id, body.resume_id if body else None)

    try:
        generator = CoverLetterGenerator()
        text = await generator.generate(
            resume.raw_text,
            job.description,
            job.company,
            tone=body.tone if body else None,
            base_text=body.base_text if body else None,
        )
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
    user_id: int = Depends(get_verified_user_id),
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


# ---------------------------------------------------------------------------
# Web "Generate Custom Resume" flow (See Difference → Align → Review)
#
# These power the per-job-card modal. Nothing is persisted (download/copy only).
# ---------------------------------------------------------------------------


@router.post("/job-analysis/{job_id}", response_model=JobAnalysisOut)
async def job_analysis(
    job_id: int,
    body: RewriteIn | None = None,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Step 1 'See Your Difference': match score + matched/missing keywords."""
    job = _get_job(job_id, db)
    resume = _resolve_resume(db, user_id, body.resume_id if body else None)

    try:
        engine = MatchEngine(db)
        return await engine.analyze_job(
            resume.raw_text, job.title, job.company, job.description
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/rewrite/{job_id}", response_model=RewriteOut)
async def rewrite_resume(
    job_id: int,
    body: RewriteIn | None = None,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Step 3 'Review': tailor the resume with the chosen sections/keywords and
    report the before/after scores. Not persisted."""
    job = _get_job(job_id, db)
    opts = body or RewriteIn()
    resume = _resolve_resume(db, user_id, opts.resume_id)

    try:
        engine = MatchEngine(db)
        before = await engine.analyze_job(
            resume.raw_text, job.title, job.company, job.description
        )

        tailor = ResumeTailor(db)
        tailored_text = await tailor.llm.tailor_resume_guided(
            resume.raw_text, job.description, opts.sections, opts.add_keywords
        )
        diff_summary = tailor.compute_diff(resume.raw_text, tailored_text)

        after = await engine.analyze_job(
            tailored_text, job.title, job.company, job.description
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    return RewriteOut(
        tailored_text=tailored_text,
        original_text=resume.raw_text,
        diff_summary=diff_summary,
        original_overall_score=before.overall_score,
        new_overall_score=after.overall_score,
        new_ats_score=after.ats_score,
        new_keyword_coverage=after.keyword_coverage,
    )


@router.post("/batch-score")
async def batch_score_jobs(
    batch_size: int = 10,
    user_id: str = Depends(get_verified_user_id),
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
    user_id: str = Depends(get_verified_user_id),
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
