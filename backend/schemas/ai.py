"""
Pydantic schemas for AI-generated content (tailored resumes, cover letters).
"""

import datetime
from pydantic import BaseModel


class TailoredResumeOut(BaseModel):
    """A tailored resume returned to the frontend."""
    id: int
    job_id: int
    tailored_text: str
    diff_summary: str
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class CoverLetterOut(BaseModel):
    """A generated cover letter returned to the frontend."""
    text: str
    job_id: int
    generated_at: datetime.datetime
