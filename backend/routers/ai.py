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
from backend.db.models import ScrapedJob, ResumeProfileDB, ResumeVersion, CoverLetter
from backend.auth.dependencies import get_verified_user_id, verify_cron_secret
from backend.services.usage_limiter import llm_guard
from backend.services.match_notifier import sweep_match_alerts
from backend.schemas.match import MatchBreakdown, FitAnalysis
from backend.schemas.ai import (
    TailoredResumeOut,
    CoverLetterOut,
    JobAnalysisOut,
    RewriteIn,
    RewriteOut,
    CoverLetterIn,
    CoverLetterRecordOut,
    CoverLetterSaveIn,
    ResumeVersionIn,
    ResumeVersionOut,
    SnippetEditIn,
    SnippetEditOut,
)
from backend.services.profile_version import bump_profile_version
from backend.schemas.resume_document import ResumeDocument
from backend.services.match_engine import MatchEngine
from backend.services.resume_tailor import ResumeTailor
from backend.services.cover_letter import CoverLetterGenerator
from backend.services.resume_document import db_record_to_document, document_to_text
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)
router = APIRouter()

LLM_503_DETAIL = "AI service unavailable. Please check your Anthropic API key."


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


def _persist_active_cover_letter(
    db: Session, user_id: int, job: ScrapedJob, text: str, tone: str | None
) -> None:
    """Upsert a per-job cover letter, mark it active, and bump the sync version
    so it shows up in the web app and the extension's cover-letter fields."""
    db.query(CoverLetter).filter(CoverLetter.user_id == user_id).update(
        {CoverLetter.is_active: 0}, synchronize_session=False
    )
    row = (
        db.query(CoverLetter)
        .filter(CoverLetter.user_id == user_id, CoverLetter.job_id == job.id)
        .first()
    )
    if row is None:
        row = CoverLetter(user_id=user_id, job_id=job.id)
        db.add(row)
    row.company = job.company or ""
    row.job_title = job.title or ""
    row.job_url = job.url or ""
    row.text = text
    row.tone = tone or ""
    row.source = "generated"
    row.is_active = 1
    db.commit()
    bump_profile_version(db, user_id)


@router.post("/match-breakdown/{job_id}", response_model=MatchBreakdown)
async def match_breakdown(
    job_id: int,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Compute match score breakdown for a job."""
    job = _get_job(job_id, db)
    resume_text = _get_resume_text(db, user_id)

    description = job.description or ""
    if len(description.strip()) < 50 and job.url:
        from backend.services.description_extractor import (
            BROWSER_HEADERS,
            extract_description_from_url,
            sanitize_description,
        )
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
                fetched = await extract_description_from_url(client, job.url)
            if fetched:
                job.description = sanitize_description(fetched)
                db.commit()
                description = job.description
        except Exception:
            pass

    if len(description.strip()) < 50:
        raise HTTPException(status_code=422, detail="No job description available to analyze.")

    try:
        engine = MatchEngine(db)
        return await engine.compute_breakdown(resume_text, description)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/tailor-resume/{job_id}", response_model=TailoredResumeOut)
async def tailor_resume(
    job_id: int,
    user_id: int = Depends(llm_guard),
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
    user_id: int = Depends(llm_guard),
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
            name=resume.profile_name,
            email=resume.email,
            phone=resume.phone,
            location=resume.location,
            linkedin=resume.linkedin_url,
        )
        # Persist + sync so it's accessible from the web app and extension.
        _persist_active_cover_letter(db, user_id, job, text, body.tone if body else None)
        return CoverLetterOut(
            text=text,
            job_id=job_id,
            generated_at=datetime.datetime.utcnow(),
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


# ---------------------------------------------------------------------------
# Saved cover letters (CRUD) — synced to web app + extension
# ---------------------------------------------------------------------------


@router.get("/cover-letters", response_model=list[CoverLetterRecordOut])
def list_cover_letters(
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """List the user's saved cover letters, newest first."""
    return (
        db.query(CoverLetter)
        .filter(CoverLetter.user_id == user_id)
        .order_by(CoverLetter.updated_at.desc(), CoverLetter.id.desc())
        .limit(50)
        .all()
    )


@router.post("/cover-letters", response_model=CoverLetterRecordOut)
def save_cover_letter(
    body: CoverLetterSaveIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Save a user-written/edited cover letter (optionally as the active one)."""
    if body.set_active:
        db.query(CoverLetter).filter(CoverLetter.user_id == user_id).update(
            {CoverLetter.is_active: 0}, synchronize_session=False
        )
    row = CoverLetter(
        user_id=user_id,
        job_id=body.job_id,
        company=body.company,
        job_title=body.job_title,
        job_url=body.job_url,
        text=body.text,
        tone=body.tone,
        source="user",
        is_active=1 if body.set_active else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    bump_profile_version(db, user_id)
    return row


@router.put("/cover-letters/{cover_letter_id}/active", response_model=CoverLetterRecordOut)
def set_active_cover_letter(
    cover_letter_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Mark a cover letter active (the default used for autofill)."""
    row = (
        db.query(CoverLetter)
        .filter(CoverLetter.id == cover_letter_id, CoverLetter.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Cover letter not found.")
    db.query(CoverLetter).filter(CoverLetter.user_id == user_id).update(
        {CoverLetter.is_active: 0}, synchronize_session=False
    )
    row.is_active = 1
    db.commit()
    db.refresh(row)
    bump_profile_version(db, user_id)
    return row


@router.delete("/cover-letters/{cover_letter_id}", status_code=204)
def delete_cover_letter(
    cover_letter_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    row = (
        db.query(CoverLetter)
        .filter(CoverLetter.id == cover_letter_id, CoverLetter.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Cover letter not found.")
    db.delete(row)
    db.commit()
    bump_profile_version(db, user_id)


@router.post("/analyze-fit/{job_id}", response_model=FitAnalysis)
async def analyze_fit(
    job_id: int,
    user_id: int = Depends(llm_guard),
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
@router.post("/custom-resume-analysis/{job_id}", response_model=JobAnalysisOut)
async def job_analysis(
    job_id: int,
    body: RewriteIn | None = None,
    user_id: int = Depends(llm_guard),
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
@router.post("/custom-resume/{job_id}", response_model=RewriteOut)
async def rewrite_resume(
    job_id: int,
    body: RewriteIn | None = None,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Step 3 'Review': tailor the resume (structured) with the chosen
    sections/keywords, report before/after scores, and save the version.

    Returns a structured ``ResumeDocument`` — the single source the renderer,
    PDF, and DOCX all consume — so the download always matches the preview.
    """
    job = _get_job(job_id, db)
    opts = body or RewriteIn()
    resume = _resolve_resume(db, user_id, opts.resume_id)

    original_document = db_record_to_document(resume)
    original_text = document_to_text(original_document)

    try:
        from backend.services.resume_tailor import tailor_document
        result = await tailor_document(
            db, original_document, job.title, job.company, job.description,
            opts.sections, opts.add_keywords,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    before = result.before
    after = result.after
    document = result.document
    tailored_text = result.tailored_text
    diff_summary = result.diff_summary

    version = ResumeVersion(
        user_id=user_id,
        resume_id=resume.id,
        job_id=job_id,
        label=f"AI · {job.title}"[:120],
        source="ai",
        document_json=document.model_dump(),
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return RewriteOut(
        document=document,
        original_document=original_document,
        tailored_text=tailored_text,
        original_text=original_text,
        diff_summary=diff_summary,
        original_overall_score=before.overall_score,
        new_overall_score=after.overall_score,
        new_ats_score=after.ats_score,
        new_keyword_coverage=after.keyword_coverage,
        version_id=version.id,
    )


@router.post("/batch-score")
async def batch_score_jobs(
    batch_size: int = 10,
    user_id: str = Depends(llm_guard),
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


# ---------------------------------------------------------------------------
# Resume version history (Phase 4) + inline edit assistant (Phase 5)
# ---------------------------------------------------------------------------


def _version_out(row: ResumeVersion) -> ResumeVersionOut:
    return ResumeVersionOut(
        id=row.id,
        resume_id=row.resume_id,
        job_id=row.job_id,
        label=row.label or "",
        source=row.source or "user",
        document=ResumeDocument(**(row.document_json or {})),
        created_at=row.created_at,
    )


@router.get("/resume-versions", response_model=list[ResumeVersionOut])
def list_resume_versions(
    resume_id: int | None = None,
    job_id: int | None = None,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """List the current user's saved resume versions, newest first.

    Optionally scoped to a resume and/or a job (job-specific versions).
    """
    q = db.query(ResumeVersion).filter(ResumeVersion.user_id == user_id)
    if resume_id is not None:
        q = q.filter(ResumeVersion.resume_id == resume_id)
    if job_id is not None:
        q = q.filter(ResumeVersion.job_id == job_id)
    rows = q.order_by(ResumeVersion.created_at.desc(), ResumeVersion.id.desc()).limit(50).all()
    return [_version_out(r) for r in rows]


@router.post("/resume-versions", response_model=ResumeVersionOut)
def save_resume_version(
    body: ResumeVersionIn,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Persist a structured resume document as a new version."""
    row = ResumeVersion(
        user_id=user_id,
        resume_id=body.resume_id,
        job_id=body.job_id,
        label=body.label or "Saved version",
        source=body.source or "user",
        document_json=body.document.model_dump(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    # Custom resumes are a sync target — bump so the extension picks it up.
    bump_profile_version(db, user_id)
    return _version_out(row)


@router.get("/resume-versions/{version_id}", response_model=ResumeVersionOut)
def get_resume_version(
    version_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    row = (
        db.query(ResumeVersion)
        .filter(ResumeVersion.id == version_id, ResumeVersion.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Version not found.")
    return _version_out(row)


@router.delete("/resume-versions/{version_id}", status_code=204)
def delete_resume_version(
    version_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    row = (
        db.query(ResumeVersion)
        .filter(ResumeVersion.id == version_id, ResumeVersion.user_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Version not found.")
    db.delete(row)
    db.commit()


@router.post("/edit-snippet", response_model=SnippetEditOut)
async def edit_snippet(
    body: SnippetEditIn,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Apply a single AI editing action to a selected snippet of resume text.

    Only the provided text is transformed and returned — never the whole resume.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="No text selected.")

    job_description = ""
    if body.job_id:
        job = db.query(ScrapedJob).filter(ScrapedJob.id == body.job_id).first()
        if job:
            job_description = job.description or ""

    try:
        llm = get_llm_service()
        edited = await llm.edit_snippet(text, body.action, job_description)
        return SnippetEditOut(text=edited or text)
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/cron-match-alerts")
async def cron_match_alerts(
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Manually trigger the match-alert sweep (also runs inside cron-poll).

    For every verified user with a resume, score the newest jobs they haven't
    been alerted about yet, then send a single deduped digest of the strong
    (>=80%) matches. Kept as a standalone endpoint for manual runs / testing;
    the scheduled trigger is folded into /github-sources/cron-poll so the app
    stays within Vercel's 2-cron Hobby limit. Authenticated via the cron secret.
    """
    return await sweep_match_alerts(db)
