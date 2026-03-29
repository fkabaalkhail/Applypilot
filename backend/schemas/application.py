"""
Pydantic schemas for application tracking.
"""

import datetime
from pydantic import BaseModel
from typing import Optional
from backend.db.models import ApplicationStatus


class ApplicationOut(BaseModel):
    """Application record returned by the API."""
    id: int
    platform: str
    company: str
    role: str
    url: Optional[str] = None
    status: ApplicationStatus
    applied_at: datetime.datetime
    notes: Optional[str] = None
    resume_version: Optional[str] = None

    model_config = {"from_attributes": True}


class ApplicationReview(BaseModel):
    """Extended application record for the review page."""
    id: int
    platform: str
    company: str
    role: str
    url: Optional[str] = None
    status: ApplicationStatus
    applied_at: datetime.datetime
    notes: Optional[str] = None
    resume_version: str = "original"
    screenshot_path: str = ""
    failure_screenshot_path: str = ""
    cover_letter_text: str = ""
    questions_answered: list[dict] = []
    ats_type: str = ""

    model_config = {"from_attributes": True}


class ApplicationUpdate(BaseModel):
    """Fields that can be manually updated on an application."""
    status: Optional[ApplicationStatus] = None
    notes: Optional[str] = None


class ApplicationStats(BaseModel):
    """Aggregate statistics for the dashboard."""
    total: int
    this_week: int
    by_platform: dict[str, int]
    by_status: dict[str, int]


class ApplicationCSVRow(BaseModel):
    """Schema for a single row in the CSV export."""
    job_id: Optional[int] = None
    title: str = ""
    company: str = ""
    location: str = ""
    work_style: str = ""
    description_excerpt: str = ""
    experience_required: Optional[int] = None
    skills: str = ""
    hr_contact_name: str = ""
    hr_contact_link: str = ""
    resume_used: str = ""
    date_posted: Optional[datetime.datetime] = None
    date_applied: Optional[datetime.datetime] = None
    job_link: str = ""
    questions_found: str = ""
    status: str = ""


class JobPosting(BaseModel):
    """Represents a scraped or manually entered job posting."""
    title: str
    company: str
    location: str = ""
    description: str = ""
    url: str = ""


class ConnectionRequestOut(BaseModel):
    """Connection request returned by the API."""
    id: int
    job_id: Optional[int] = None
    contact_name: str
    contact_title: str = ""
    company: str
    role_applied: str = ""
    message_sent: str = ""
    status: str = "sent"
    sent_at: datetime.datetime

    model_config = {"from_attributes": True}


class AutopilotRunOut(BaseModel):
    """Autopilot run stats returned by the API."""
    id: int
    task_id: str
    started_at: datetime.datetime
    stopped_at: Optional[datetime.datetime] = None
    total_applied: int = 0
    total_skipped: int = 0
    total_failed: int = 0
    total_waiting: int = 0
    status: str = "running"

    model_config = {"from_attributes": True}
