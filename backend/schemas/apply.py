"""
Pydantic schemas for the apply flow (session, profile data, progress).
"""

import datetime

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


class LogApplicationRequest(BaseModel):
    """An application the extension observed the user submit on an ATS page.

    Everything is optional so the extension can log whatever job context it
    scraped from the page. Used by POST /apply/log, the external-page analogue
    of POST /apply/{session_id}/complete (which needs an internal job_id).
    """
    company: str = ""
    role: str = ""
    url: str = ""
    platform: str = "extension"
    ats_type: str = ""
    resume_version: str = "original"
    job_id: int | None = None


class LoggedApplication(BaseModel):
    """The application record created (or refreshed) by POST /apply/log."""
    id: int
    company: str
    role: str
    url: str | None = None
    status: str
    applied_at: datetime.datetime
    job_id: int | None = None
    # True when a new record was inserted; False when an existing one (same
    # user + url) had its applied_at refreshed instead of duplicating.
    created: bool
