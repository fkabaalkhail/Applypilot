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
        
        # Build rich context from resume, profile, and job description
        context_parts = []
        
        # Add detailed profile info
        if settings:
            profile_info = f"""APPLICANT PROFILE:
- Full Name: {settings.first_name or ''} {settings.last_name or ''}
- Email: {settings.email or ''}
- Phone: {settings.phone or ''}
- City: {settings.city or 'Ottawa'}
- Country: Canada
- LinkedIn: {settings.linkedin_url or ''}
- Website: {settings.website or ''}
- Work Authorization: Legally authorized to work in Canada
- Visa Sponsorship: Does NOT require sponsorship
- Willing to Relocate: Yes
- Willing to Travel: Yes
- Driver's License: Yes
- Available to Start: Immediately
- Comfortable with Remote Work: Yes
- Open to Startup Environment: Yes"""
            
            # Add prefilled answers as additional context
            prefilled = settings.prefilled_answers or {}
            if prefilled:
                profile_info += "\n\nPREFILLED ANSWERS (use these if relevant):"
                for q, a in prefilled.items():
                    profile_info += f"\n- Q: {q} → A: {a}"
            
            context_parts.append(profile_info)
        
        if resume_text:
            # Send more resume text for better context
            context_parts.append(f"RESUME:\n{resume_text[:4000]}")
        if request.jobDescription:
            context_parts.append(f"JOB DESCRIPTION:\n{request.jobDescription[:2000]}")
        if request.options:
            context_parts.append(f"AVAILABLE OPTIONS (pick EXACTLY one):\n" + "\n".join(f"- {o}" for o in request.options))
        
        context = "\n\n".join(context_parts) if context_parts else "No additional context available."
        
        ollama = OllamaService()
        
        # Use the answer_question method
        answer = await ollama.answer_question(
            question=request.question,
            context=context,
        )
        
        if not answer:
            return AIAnswerResponse(answer=None, error="No answer generated")
        
        # Post-process: strip conversational fluff from AI response
        answer = _clean_ai_answer(answer)
        
        if not answer:
            return AIAnswerResponse(answer=None, error="AI gave empty/invalid response")
        
        # If options were provided, try to match the answer to one of them
        if request.options and answer:
            matched = _match_option(answer, request.options)
            if matched:
                return AIAnswerResponse(answer=matched)
            
            # No match found - return first option as fallback
            logger.warning(f"AI answer '{answer}' didn't match options {request.options}, using first option")
            return AIAnswerResponse(answer=request.options[0])
        
        return AIAnswerResponse(answer=answer)
        
    except Exception as e:
        logger.error("AI answer failed: %s", e)
        return AIAnswerResponse(error=str(e))


def _clean_ai_answer(answer: str) -> str:
    """Strip conversational fluff and formatting from AI responses."""
    answer = answer.strip()
    
    # Remove markdown code fences
    if answer.startswith("```"):
        lines = answer.split("\n")
        answer = "\n".join(l for l in lines if not l.strip().startswith("```")).strip()
    
    # Remove common conversational prefixes (case-insensitive)
    prefixes_to_strip = [
        "I'm happy to help!",
        "I'd be happy to help!",
        "I am happy to help!",
        "I would be happy to help!",
        "Sure!",
        "Sure,",
        "Of course!",
        "Of course,",
        "Certainly!",
        "Certainly,",
        "Absolutely!",
        "Absolutely,",
        "Happy to help!",
        "Glad to help!",
        "Here's the answer:",
        "Here is the answer:",
        "Here's my answer:",
        "Here is my answer:",
        "The answer is:",
        "My answer is:",
        "Answer:",
        "ANSWER:",
    ]
    
    for prefix in prefixes_to_strip:
        if answer.lower().startswith(prefix.lower()):
            answer = answer[len(prefix):].strip()
    
    # Remove leading newlines after stripping
    answer = answer.strip()
    
    # If the answer is wrapped in quotes, unwrap
    if answer.startswith('"') and answer.endswith('"'):
        answer = answer[1:-1].strip()
    
    return answer


def _match_option(answer: str, options: list[str]) -> str | None:
    """Try to match an AI answer to one of the available options."""
    import re
    answer_lower = answer.lower().strip()
    
    # Exact match
    for opt in options:
        if opt.lower().strip() == answer_lower:
            return opt
    
    # Answer contains option text
    for opt in options:
        if opt.lower().strip() in answer_lower:
            return opt
    
    # Option contains answer text
    for opt in options:
        if answer_lower in opt.lower():
            return opt
    
    # Yes/No matching
    yes_words = ['yes', 'true', 'agree', 'accept', 'correct', 'affirmative', 'i agree', 'i do']
    no_words = ['no', 'false', 'disagree', 'decline', 'incorrect', 'i do not', "i don't"]
    
    if any(word in answer_lower for word in yes_words):
        for opt in options:
            ol = opt.lower().strip()
            if ol in ['yes', 'true', 'agree', 'accept', 'i agree'] or ol.startswith('yes'):
                return opt
    
    if any(word in answer_lower for word in no_words):
        for opt in options:
            ol = opt.lower().strip()
            if ol in ['no', 'false', 'disagree', 'decline'] or ol.startswith('no'):
                return opt
    
    # Number matching (e.g., AI says "3" and option is "3" or "3 years")
    num_match = re.match(r'^(\d+)', answer_lower)
    if num_match:
        num = num_match.group(1)
        for opt in options:
            if opt.strip() == num or opt.strip().startswith(num + ' ') or opt.strip().startswith(num + '-'):
                return opt
    
    return None


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
    limit: int = 50,
    min_score: int = 0,
    easy_apply_only: bool = True,
    external_only: bool = False,
    posted_within: str = "",
    db: Session = Depends(get_db),
):
    """
    Get pending jobs for the extension to apply to.
    
    Returns jobs that haven't been applied to yet, sorted by match score.
    Filters:
    - easy_apply_only=true: Only LinkedIn Easy Apply jobs
    - external_only=true: Only external ATS jobs (Greenhouse, Lever, etc.)
    - Both false: All jobs
    - posted_within: Filter by posting date ("24h", "week", "month", or empty for all)
    """
    import datetime
    
    query = db.query(ScrapedJob).filter(
        ScrapedJob.status == JobStatus.NEW,
        ScrapedJob.match_score >= min_score,
    )
    
    # Filter by posting date
    if posted_within:
        now = datetime.datetime.utcnow()
        if posted_within == "24h":
            cutoff = now - datetime.timedelta(hours=24)
        elif posted_within == "week":
            cutoff = now - datetime.timedelta(days=7)
        elif posted_within == "month":
            cutoff = now - datetime.timedelta(days=30)
        else:
            cutoff = None
        
        if cutoff:
            # Only include jobs where posted_date is known AND recent enough
            # Jobs without posted_date are excluded when a time filter is active
            query = query.filter(
                ScrapedJob.posted_date.isnot(None),
                ScrapedJob.posted_date >= cutoff,
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
    
    logger.info(f"Found {len(jobs)} pending jobs (easy_apply_only={easy_apply_only}, external_only={external_only}, posted_within={posted_within})")
    for j in jobs:
        logger.info(f"  - {j.title} at {j.company}, ats_type={j.ats_type}, easy_apply={j.easy_apply}, posted_date={j.posted_date}")
    
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
