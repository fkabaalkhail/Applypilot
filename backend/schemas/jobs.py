"""
Pydantic schemas for scraped jobs and pending questions.
"""

import datetime
from pydantic import BaseModel
from typing import Optional
from backend.db.models import JobStatus


class ScrapedJobOut(BaseModel):
    """A scraped job listing returned to the frontend."""
    id: int
    platform: str
    title: str
    company: str
    location: str
    url: str
    description: str
    easy_apply: bool
    status: JobStatus
    scraped_at: datetime.datetime
    match_score: int = 0
    requirements_met: int = 0
    requirements_total: int = 0
    match_summary: str = ""
    requirements_detail: list[dict] = []
    salary_range: str = ""
    company_size: str = ""
    company_description: str = ""
    company_logo: str = ""
    ats_type: str = ""

    # Multi-source and match breakdown fields
    source_platform: str = "linkedin"
    saved: int = 0
    experience_score: int = 0
    skill_score: int = 0
    industry_score: int = 0
    match_label: str = ""
    applicant_count: Optional[int] = None

    # Job aggregator classification fields
    work_type: str = "onsite"
    role_category: str = ""
    country: str = ""
    experience_level: str = ""
    posted_date: Optional[datetime.datetime] = None

    model_config = {"from_attributes": True}


class PendingQuestionOut(BaseModel):
    """A question the bot needs the user to answer."""
    id: int
    job_id: int
    question: str
    field_type: str
    options: list[str]
    answer: Optional[str] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class AnswerSubmit(BaseModel):
    """User submitting an answer to a pending question."""
    answer: str
