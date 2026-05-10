"""
Pydantic schemas for the apply flow (session, profile data, progress).
"""

from pydantic import BaseModel


class ApplySession(BaseModel):
    """An active apply session returned when initiating an application."""
    session_id: str
    job_id: int
    resume_version: str  # "original" or "tailored"
    cover_letter_ready: bool
    match_score: int


class FillProfile(BaseModel):
    """Profile data sent to extension for form filling."""
    first_name: str
    last_name: str
    email: str
    phone: str
    location: str
    linkedin_url: str
    website: str
    skills: list[str] = []
    experience: list[dict] = []
    education: list[dict] = []
    projects: list[dict] = []
    resume_text: str  # tailored or original
    cover_letter: str = ""
    prefilled_answers: dict[str, str] = {}


class ProgressUpdate(BaseModel):
    """Progress update from the extension during form filling."""
    total_fields: int
    filled_fields: int
    percentage: int
    current_field: str
    status: str  # filling, waiting_user, complete, error
