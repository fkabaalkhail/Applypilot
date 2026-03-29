"""
Pydantic schemas for user settings (credentials, profile, bot config, filters).
"""

from pydantic import BaseModel
from typing import Optional


class SettingsUpdate(BaseModel):
    """All configurable settings a client can update from the UI."""
    # LinkedIn credentials
    linkedin_email: Optional[str] = None
    linkedin_password: Optional[str] = None
    linkedin_cookie: Optional[str] = None

    # Personal info (for form filling)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    city: Optional[str] = None
    linkedin_url: Optional[str] = None
    website: Optional[str] = None

    # Bot preferences
    job_title: Optional[str] = None
    location: Optional[str] = None
    remote_only: Optional[bool] = None
    max_applications_per_run: Optional[int] = None

    # Filters
    experience_levels: Optional[list[str]] = None
    work_type: Optional[str] = None
    regions: Optional[list[str]] = None

    # Prefilled answers for common application questions
    prefilled_answers: Optional[dict[str, str]] = None

    # Smart filter settings
    company_blacklist: Optional[list[str]] = None
    keyword_blacklist: Optional[list[str]] = None
    min_salary: Optional[int] = None
    max_salary: Optional[int] = None
    min_experience_years: Optional[int] = None
    max_experience_years: Optional[int] = None

    # Autopilot settings
    autopilot_enabled: Optional[bool] = None
    daily_apply_limit: Optional[int] = None
    weekly_apply_limit: Optional[int] = None
    apply_delay_min: Optional[float] = None
    apply_delay_max: Optional[float] = None

    # UX toggles
    pause_before_submit: Optional[bool] = None
    follow_companies: Optional[bool] = None
    smooth_scrolling: Optional[bool] = None

    # HR outreach
    hr_outreach_enabled: Optional[bool] = None
    hr_daily_connect_limit: Optional[int] = None

    # AI features
    resume_tailoring_enabled: Optional[bool] = None


class SettingsOut(BaseModel):
    """Settings returned to the frontend — password is masked."""
    linkedin_email: str = ""
    linkedin_password_set: bool = False
    linkedin_cookies_set: bool = False

    first_name: str = ""
    last_name: str = ""
    email: str = ""
    phone: str = ""
    city: str = ""
    linkedin_url: str = ""
    website: str = ""

    resume_uploaded: bool = False
    resume_file_name: str = ""

    job_title: str = ""
    location: str = ""
    remote_only: bool = False
    max_applications_per_run: int = 25

    experience_levels: list[str] = []
    work_type: str = ""
    regions: list[str] = []
    prefilled_answers: dict[str, str] = {}

    # Smart filter settings
    company_blacklist: list[str] = []
    keyword_blacklist: list[str] = []
    min_salary: Optional[int] = None
    max_salary: Optional[int] = None
    min_experience_years: Optional[int] = None
    max_experience_years: Optional[int] = None

    # Autopilot settings
    autopilot_enabled: bool = False
    daily_apply_limit: int = 50
    weekly_apply_limit: int = 200
    apply_delay_min: float = 30.0
    apply_delay_max: float = 120.0

    # UX toggles
    pause_before_submit: bool = False
    follow_companies: bool = False
    smooth_scrolling: bool = False

    # HR outreach
    hr_outreach_enabled: bool = False
    hr_daily_connect_limit: int = 10

    # AI features
    resume_tailoring_enabled: bool = False
