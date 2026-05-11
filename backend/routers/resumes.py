"""
Resume upload and parsing endpoints.

POST /resumes/upload — accepts PDF or DOCX, extracts text, analyzes via Gemini,
stores profile in DB, returns typed ResumeProfile.
GET /resumes — list all resumes ordered by created_at desc.
GET /resumes/{id} — get full resume detail including profile and analysis report.
"""

import datetime
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ResumeProfileDB
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
def list_resumes(db: Session = Depends(get_db)):
    """List all resumes ordered by most recently created first."""
    records = db.query(ResumeProfileDB).order_by(ResumeProfileDB.created_at.desc()).all()
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
def set_primary_resume(resume_id: int, db: Session = Depends(get_db)):
    """Set a resume as primary, unsetting all others."""
    record = db.query(ResumeProfileDB).filter(ResumeProfileDB.id == resume_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")

    # Unset all resumes as primary
    db.query(ResumeProfileDB).update({ResumeProfileDB.is_primary: 0})
    # Set the target resume as primary
    record.is_primary = 1
    db.commit()
    db.refresh(record)

    # Serialize response using same logic as GET detail
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
async def analyze_resume(resume_id: int, db: Session = Depends(get_db)):
    """Run AI quality analysis on a resume and persist the report."""
    record = db.query(ResumeProfileDB).filter(ResumeProfileDB.id == resume_id).first()
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
def get_resume(resume_id: int, db: Session = Depends(get_db)):
    """Get full resume detail by id, including profile and analysis report."""
    record = db.query(ResumeProfileDB).filter(ResumeProfileDB.id == resume_id).first()
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
def update_resume(resume_id: int, body: ResumeUpdateRequest, db: Session = Depends(get_db)):
    """Update a resume's name, target_job_title, and/or profile fields."""
    record = db.query(ResumeProfileDB).filter(ResumeProfileDB.id == resume_id).first()
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

    # Serialize response using same logic as GET detail
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
def delete_resume(resume_id: int, db: Session = Depends(get_db)):
    """Delete a resume by id. Returns 204 on success, 404 if not found."""
    record = db.query(ResumeProfileDB).filter(ResumeProfileDB.id == resume_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Resume not found.")
    db.delete(record)
    db.commit()


@router.post("/upload", response_model=ResumeUploadResponse)
async def upload_resume(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a PDF or DOCX resume, parse it, and store the profile."""
    if file.content_type not in (
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX files are accepted.")

    content = await file.read()
    filename = file.filename or "resume"

    # Extract raw text
    try:
        raw_text = extract_text(content, filename)
    except Exception as e:
        logger.error("Text extraction failed: %s", e)
        raise HTTPException(status_code=422, detail=f"Could not extract text: {e}")

    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="Extracted text is empty.")

    # Analyze with Gemini
    llm = get_llm_service()
    try:
        profile = await llm.analyze_resume(raw_text)
    except Exception as e:
        logger.error("AI analysis failed: %s", e)
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {e}")

    # Persist to DB
    db_profile = ResumeProfileDB(
        name="Untitled Resume",
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
        status="analyzed",
    )
    db.add(db_profile)
    db.commit()
    db.refresh(db_profile)

    return ResumeUploadResponse(id=db_profile.id, profile=profile)
