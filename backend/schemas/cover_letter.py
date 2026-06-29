"""Schemas for the extension cover-letter endpoints (mounted at /api)."""
from pydantic import BaseModel


class CoverLetterGenerateIn(BaseModel):
    """Generate/regenerate a cover letter for a scraped job (no job_id)."""
    resume_id: int | None = None
    job_description: str = ""
    job_title: str = ""
    company: str = ""
    tone: str | None = None
    # None -> fresh letter; set -> rewrite this text in `tone`.
    base_text: str | None = None


class CoverLetterGenerateOut(BaseModel):
    text: str


class RenderCoverLetterIn(BaseModel):
    text: str
    filename: str | None = None


class RenderCoverLetterOut(BaseModel):
    data_base64: str
    name: str
    content_type: str = "application/pdf"
