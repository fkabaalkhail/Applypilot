"""
Apply flow endpoints for managing job application sessions.

POST /apply/initiate                 → ApplySession
GET  /apply/{session_id}/profile     → FillProfile
POST /apply/{session_id}/progress    → ProgressUpdate
POST /apply/{session_id}/complete    → ApplicationRecordOut
POST /apply/{session_id}/question    → PendingQuestionOut
"""

import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import (
    ScrapedJob, JobStatus, ApplicationRecord, PendingQuestion,
    ResumeProfileDB, TailoredResume, UserSettings,
)
from backend.auth.clerk import get_current_user_id
from backend.schemas.apply import ApplySession, FillProfile, ProgressUpdate
from backend.schemas.jobs import PendingQuestionOut

logger = logging.getLogger(__name__)
router = APIRouter()

# In-memory session store (for simplicity; could be Redis in production)
_sessions: dict[str, dict] = {}


class InitiateRequest(BaseModel):
    """Request body for initiating an apply flow."""
    job_id: int


class QuestionRequest(BaseModel):
    """Request body for submitting a question from the extension."""
    question: str
    field_type: str = "text"
    options: list[str] = []


@router.post("/initiate", response_model=ApplySession)
def initiate_apply(
    request: InitiateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Initiate an apply flow for a job."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == request.job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    # Update job status to applying
    job.status = JobStatus.APPLYING
    db.commit()

    # Check if tailored resume exists for this user
    tailored = (
        db.query(TailoredResume)
        .filter(
            TailoredResume.job_id == request.job_id,
            TailoredResume.user_id == user_id,
            TailoredResume.status == "accepted",
        )
        .first()
    )

    session_id = str(uuid.uuid4())
    resume_version = "tailored" if tailored else "original"

    # Store session with user_id
    _sessions[session_id] = {
        "job_id": request.job_id,
        "user_id": user_id,
        "resume_version": resume_version,
        "status": "initiated",
    }

    return ApplySession(
        session_id=session_id,
        job_id=request.job_id,
        resume_version=resume_version,
        cover_letter_ready=False,
        match_score=job.match_score or 0,
    )


@router.get("/{session_id}/profile", response_model=FillProfile)
def get_fill_profile(
    session_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Get profile data for form filling by the extension."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Apply session not found.")

    # Verify session belongs to this user
    if session.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this session.")

    # Get user settings
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if not settings:
        raise HTTPException(status_code=400, detail="User settings not configured.")

    # Get resume text (tailored if available)
    resume_text = ""
    if session["resume_version"] == "tailored":
        tailored = (
            db.query(TailoredResume)
            .filter(
                TailoredResume.job_id == session["job_id"],
                TailoredResume.user_id == user_id,
                TailoredResume.status == "accepted",
            )
            .first()
        )
        if tailored:
            resume_text = tailored.tailored_text

    if not resume_text:
        profile = (
            db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.user_id == user_id)
            .order_by(ResumeProfileDB.created_at.desc())
            .first()
        )
        resume_text = profile.raw_text if profile else ""

    # Get resume profile for structured data — prefer primary, fall back to most recent
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

    # Merge all technology categories into flat skills list for backward compat
    skills = list(profile.skills or []) if profile else []
    if profile:
        technologies = profile.technologies or {}
        for category_skills in technologies.values():
            for skill in category_skills:
                if skill not in skills:
                    skills.append(skill)

    return FillProfile(
        first_name=settings.first_name,
        last_name=settings.last_name,
        email=settings.email,
        phone=settings.phone,
        location=settings.city,
        linkedin_url=settings.linkedin_url,
        website=settings.website,
        skills=skills,
        experience=profile.experience if profile else [],
        education=profile.education if profile else [],
        projects=profile.projects if profile else [],
        resume_text=resume_text,
        cover_letter="",
        prefilled_answers=settings.prefilled_answers or {},
    )


@router.post("/{session_id}/progress")
def update_progress(
    session_id: str,
    update: ProgressUpdate,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Receive progress update from the extension."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Apply session not found.")

    if session.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this session.")

    session["status"] = update.status
    session["progress"] = update.percentage

    return {"status": "ok"}


@router.post("/{session_id}/complete")
def complete_apply(
    session_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Mark application as complete."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Apply session not found.")

    if session.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this session.")

    job = db.query(ScrapedJob).filter(ScrapedJob.id == session["job_id"]).first()
    if job:
        job.status = JobStatus.APPLIED

    # Create application record linked to user
    record = ApplicationRecord(
        user_id=user_id,
        platform=job.platform if job else "linkedin",
        company=job.company if job else "",
        role=job.title if job else "",
        url=job.url if job else "",
        resume_version=session["resume_version"],
        job_id=session["job_id"],
    )
    db.add(record)
    db.commit()

    # Mark session as complete
    session["status"] = "complete"

    return {"status": "applied", "job_id": session["job_id"]}


@router.post("/{session_id}/question", response_model=PendingQuestionOut)
def submit_question(
    session_id: str,
    request: QuestionRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Submit a question the extension couldn't answer."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Apply session not found.")

    if session.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this session.")

    question = PendingQuestion(
        user_id=user_id,
        job_id=session["job_id"],
        question=request.question,
        field_type=request.field_type,
        options=request.options,
    )
    db.add(question)
    db.commit()
    db.refresh(question)

    return question
