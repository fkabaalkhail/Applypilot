"""
Resume upload and parsing endpoints.

POST /resumes/upload — accepts PDF or DOCX, extracts text, analyzes via Ollama,
stores profile in DB, returns typed ResumeProfile.
"""

import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ResumeProfileDB
from backend.schemas.resume import ResumeProfile, ResumeUploadResponse
from backend.services.resume_parser import extract_text
from backend.services.ollama_service import OllamaService

logger = logging.getLogger(__name__)
router = APIRouter()


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

    # Analyze with Ollama
    ollama = OllamaService()
    try:
        profile = await ollama.analyze_resume(raw_text)
    except Exception as e:
        logger.error("Ollama analysis failed: %s", e)
        raise HTTPException(status_code=502, detail=f"AI analysis failed: {e}")

    # Persist to DB
    db_profile = ResumeProfileDB(
        name=profile.name,
        email=profile.email,
        phone=profile.phone,
        location=profile.location,
        linkedin_url=profile.linkedin_url,
        skills=profile.skills,
        experience=[exp.model_dump() for exp in profile.experience],
        education=[edu.model_dump() for edu in profile.education],
        raw_text=raw_text,
    )
    db.add(db_profile)
    db.commit()
    db.refresh(db_profile)

    return ResumeUploadResponse(id=db_profile.id, profile=profile)
