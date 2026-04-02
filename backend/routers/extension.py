"""
Extension API endpoints — Chrome extension integration.

GET   /extension/profile    — get profile data for form filling
POST  /extension/ai/answer  — get AI answer for unknown question
POST  /extension/applied    — report a completed application
GET   /extension/jobs       — get pending jobs to apply to
"""

import logging
from typing import Optional
from pydantic import BaseModel

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import UserSettings, ApplicationRecord, ScrapedJob, ApplicationStatus, JobStatus, ResumeProfileDB

logger = logging.getLogger(__name__)
router = APIRouter()


class ProfileOut(BaseModel):
    """Profile data for the Chrome extension."""
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    phoneCountryCode: str = "+1"
    city: str = ""
    state: str = ""
    postal: str = ""
    country: str = ""
    linkedinUrl: str = ""
    website: str = ""
    resumeBase64: Optional[str] = None
    resumeFileName: Optional[str] = None
    prefilledAnswers: dict = {}
    # Common question answers
    visaSponsorship: str = "no"
    legallyAuthorized: str = "yes"
    willingToRelocate: str = "yes"
    driversLicense: str = "yes"


class AIQuestionRequest(BaseModel):
    """Request for AI-powered answer."""
    question: str
    options: list[str] = []
    resumeText: str = ""
    jobDescription: str = ""


class AIAnswerResponse(BaseModel):
    """Response with AI answer."""
    answer: Optional[str] = None
    error: Optional[str] = None


class AppliedJobReport(BaseModel):
    """Report of a completed application from the extension."""
    company: str
    role: str
    url: str
    atsType: str = "linkedin"
    status: str = "applied"  # applied, partial, failed
    fieldsFilled: int = 0
    fieldsSkipped: int = 0
    fieldsFailed: int = 0


class PendingJobOut(BaseModel):
    """Job pending application."""
    id: int
    title: str
    company: str
    url: str
    location: str = ""
    matchScore: int = 0
    atsType: str = "easy_apply"


def _get_settings(db: Session) -> UserSettings:
    """Get the singleton settings row, or create it if it doesn't exist."""
    settings = db.query(UserSettings).filter(UserSettings.id == 1).first()
    if not settings:
        settings = UserSettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("/profile", response_model=ProfileOut)
def get_profile(db: Session = Depends(get_db)):
    """
    Get profile data for the Chrome extension to use for form filling.
    
    Returns all profile fields, prefilled answers, and optionally the resume
    as base64 for file upload fields.
    """
    s = _get_settings(db)
    
    # Get resume if available
    resume_base64 = None
    resume_filename = None
    if s.resume_file_path:
        from pathlib import Path
        import base64
        resume_path = Path(s.resume_file_path)
        if resume_path.exists():
            resume_base64 = base64.b64encode(resume_path.read_bytes()).decode('utf-8')
            resume_filename = resume_path.name
    
    # Extract prefilled answers for common questions
    prefilled = s.prefilled_answers or {}
    
    return ProfileOut(
        firstName=s.first_name or "",
        lastName=s.last_name or "",
        email=s.email or "",
        phone=s.phone or "",
        phoneCountryCode="+1",  # Default, could be stored in settings
        city=s.city or "",
        state="",  # Could be added to settings
        postal="",  # Could be added to settings
        country="Canada",  # Could be added to settings
        linkedinUrl=s.linkedin_url or "",
        website=s.website or "",
        resumeBase64=resume_base64,
        resumeFileName=resume_filename,
        prefilledAnswers=prefilled,
        # Common questions - could be stored in settings
        visaSponsorship=prefilled.get("visa_sponsorship", "no"),
        legallyAuthorized=prefilled.get("legally_authorized", "yes"),
        willingToRelocate=prefilled.get("willing_to_relocate", "yes"),
        driversLicense=prefilled.get("drivers_license", "yes"),
    )


@router.post("/ai/answer", response_model=AIAnswerResponse)
async def get_ai_answer(request: AIQuestionRequest, db: Session = Depends(get_db)):
    """
    Get an AI-powered answer for an unknown application question.
    
    Uses the Ollama service to generate contextual answers based on
    the user's resume and the job description.
    """
    try:
        from backend.services.ollama_service import OllamaService
        
        # Get user settings for profile info
        settings = db.query(UserSettings).filter(UserSettings.id == 1).first()
        
        # Get resume text if not provided
        resume_text = request.resumeText
        if not resume_text:
            resume = db.query(ResumeProfileDB).order_by(ResumeProfileDB.created_at.desc()).first()
            if resume:
                resume_text = resume.raw_text or ""
        
        # Build context from resume, profile, and job description
        context_parts = []
        
        # Add profile info
        if settings:
            profile_info = f"""Applicant Profile:
- Name: {settings.first_name or ''} {settings.last_name or ''}
- Email: {settings.email or ''}
- Phone: {settings.phone or ''}
- Location: {settings.city or ''}, Canada
- LinkedIn: {settings.linkedin_url or ''}
- Currently authorized to work in Canada
- Does not require visa sponsorship
- Willing to relocate
- Has valid driver's license
"""
            context_parts.append(profile_info)
        
        if resume_text:
            context_parts.append(f"Resume:\n{resume_text[:2000]}")
        if request.jobDescription:
            context_parts.append(f"Job Description:\n{request.jobDescription[:1000]}")
        if request.options:
            context_parts.append(f"IMPORTANT - Choose from these options ONLY: {', '.join(request.options)}")
        
        context = "\n\n".join(context_parts) if context_parts else "No additional context available."
        
        ollama = OllamaService()
        
        # Use the answer_question method
        answer = await ollama.answer_question(
            question=request.question,
            context=context,
        )
        
        if not answer:
            return AIAnswerResponse(answer=None, error="No answer generated")
        
        answer = answer.strip()
        
        # If options were provided, try to match the answer to one of them
        if request.options and answer:
            answer_lower = answer.lower().strip()
            
            # Exact match
            for opt in request.options:
                if opt.lower().strip() == answer_lower:
                    return AIAnswerResponse(answer=opt)
            
            # Partial match - answer contains option
            for opt in request.options:
                if opt.lower() in answer_lower:
                    return AIAnswerResponse(answer=opt)
            
            # Partial match - option contains answer
            for opt in request.options:
                if answer_lower in opt.lower():
                    return AIAnswerResponse(answer=opt)
            
            # Yes/No matching
            if any(word in answer_lower for word in ['yes', 'true', 'agree', 'accept', 'correct']):
                for opt in request.options:
                    if opt.lower().strip() in ['yes', 'true', 'agree', 'accept']:
                        return AIAnswerResponse(answer=opt)
            
            if any(word in answer_lower for word in ['no', 'false', 'disagree', 'decline', 'incorrect']):
                for opt in request.options:
                    if opt.lower().strip() in ['no', 'false', 'disagree', 'decline']:
                        return AIAnswerResponse(answer=opt)
            
            # Return first option as fallback
            logger.warning(f"AI answer '{answer}' didn't match options {request.options}, using first option")
            return AIAnswerResponse(answer=request.options[0])
        
        return AIAnswerResponse(answer=answer)
        
    except Exception as e:
        logger.error("AI answer failed: %s", e)
        return AIAnswerResponse(error=str(e))


@router.post("/applied")
def report_applied_job(report: AppliedJobReport, db: Session = Depends(get_db)):
    """
    Report a completed application from the Chrome extension.
    
    Creates an ApplicationRecord and optionally updates the ScrapedJob status.
    """
    # Map status string to enum
    status_map = {
        "applied": ApplicationStatus.APPLIED,
        "partial": ApplicationStatus.PENDING,
        "failed": ApplicationStatus.FAILED,
    }
    status = status_map.get(report.status, ApplicationStatus.APPLIED)
    
    # Check if we already have this application
    existing = db.query(ApplicationRecord).filter(
        ApplicationRecord.url == report.url
    ).first()
    
    if existing:
        # Update existing record
        existing.status = status
        db.commit()
        return {"message": "Application updated", "id": existing.id}
    
    # Create new application record
    record = ApplicationRecord(
        platform="linkedin" if "linkedin" in report.url else "external",
        company=report.company,
        role=report.role,
        url=report.url,
        status=status,
        ats_type=report.atsType,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    
    # Try to find and update the corresponding ScrapedJob
    job = db.query(ScrapedJob).filter(ScrapedJob.url == report.url).first()
    if job:
        if status == ApplicationStatus.APPLIED:
            job.status = JobStatus.APPLIED
        elif status == ApplicationStatus.FAILED:
            job.status = JobStatus.FAILED
        db.commit()
    
    logger.info("Application reported: %s at %s (%s)", report.role, report.company, report.status)
    return {"message": "Application recorded", "id": record.id}


@router.get("/jobs", response_model=list[PendingJobOut])
def get_pending_jobs(
    limit: int = 10,
    min_score: int = 0,
    easy_apply_only: bool = True,
    external_only: bool = False,
    db: Session = Depends(get_db),
):
    """
    Get pending jobs for the extension to apply to.
    
    Returns jobs that haven't been applied to yet, sorted by match score.
    Filters:
    - easy_apply_only=true: Only LinkedIn Easy Apply jobs
    - external_only=true: Only external ATS jobs (Greenhouse, Lever, etc.)
    - Both false: All jobs
    """
    query = db.query(ScrapedJob).filter(
        ScrapedJob.status == JobStatus.NEW,
        ScrapedJob.match_score >= min_score,
    )
    
    # Filter by job type
    if easy_apply_only:
        # Easy Apply jobs: ats_type is "easy_apply" OR ats_type is empty/null with easy_apply=1
        query = query.filter(
            (ScrapedJob.ats_type == "easy_apply") | 
            ((ScrapedJob.ats_type == "") & (ScrapedJob.easy_apply == 1)) |
            ((ScrapedJob.ats_type.is_(None)) & (ScrapedJob.easy_apply == 1))
        )
    elif external_only:
        # External jobs: ats_type is set and not "easy_apply"
        query = query.filter(
            ScrapedJob.ats_type.isnot(None),
            ScrapedJob.ats_type != "",
            ScrapedJob.ats_type != "easy_apply"
        )
    # else: all jobs (no additional filter)
    
    jobs = query.order_by(
        ScrapedJob.match_score.desc()
    ).limit(limit).all()
    
    logger.info(f"Found {len(jobs)} pending jobs (easy_apply_only={easy_apply_only}, external_only={external_only})")
    for j in jobs:
        logger.info(f"  - {j.title} at {j.company}, ats_type={j.ats_type}, easy_apply={j.easy_apply}")
    
    return [
        PendingJobOut(
            id=j.id,
            title=j.title,
            company=j.company,
            url=j.url,
            location=j.location or "",
            matchScore=j.match_score or 0,
            atsType=j.ats_type or "easy_apply",
        )
        for j in jobs
    ]


@router.delete("/jobs/clear")
def clear_all_jobs(db: Session = Depends(get_db)):
    """
    Clear all jobs from the database.
    This gives a fresh start - useful for testing or when old jobs are stale.
    """
    from backend.db.models import ApplicationRecord
    
    # Delete all application records first (foreign key constraint)
    deleted_apps = db.query(ApplicationRecord).delete()
    
    # Delete all scraped jobs
    deleted_jobs = db.query(ScrapedJob).delete()
    
    db.commit()
    
    logger.info(f"Cleared {deleted_jobs} jobs and {deleted_apps} application records")
    
    return {
        "message": "All jobs cleared",
        "deletedJobs": deleted_jobs,
        "deletedApplications": deleted_apps
    }
