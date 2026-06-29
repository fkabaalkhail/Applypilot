"""Schemas for the extension résumé-tailoring endpoints (mounted at /api)."""
from pydantic import BaseModel

from backend.schemas.resume_document import ResumeDocument


class TailorResumeIn(BaseModel):
    """Tailor a résumé to a scraped job (no job_id)."""
    resume_id: int | None = None
    job_description: str = ""
    job_title: str = ""
    company: str = ""
    sections: list[str] | None = None
    # None -> weave all missing keywords; a list (even []) -> use exactly that.
    add_keywords: list[str] | None = None


class TailorResumeOut(BaseModel):
    """Tailored document + before/after scores + the stable candidate keyword set."""
    document: ResumeDocument
    original_overall_score: int
    new_overall_score: int
    new_ats_score: int
    new_keyword_coverage: int
    matched_keywords: list[str] = []
    missing_keywords: list[str] = []
    diff_summary: str = ""


class RenderResumeIn(BaseModel):
    document: ResumeDocument
    filename: str | None = None


class RenderResumeOut(BaseModel):
    data_base64: str
    name: str
    content_type: str = "application/pdf"
