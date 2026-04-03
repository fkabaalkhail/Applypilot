"""
SQLAlchemy ORM models for the Auto Apply Bot.

Models:
    - ScrapedJob: jobs found by the scraper, shown on dashboard
    - ApplicationRecord: tracked job applications
    - UserSettings: all client config (creds, profile, filters, prefilled answers)
    - BotRun: persisted bot execution logs
    - PendingQuestion: questions the bot couldn't answer during apply
    - ResumeProfileDB: parsed resume data
"""

import enum
import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Enum, JSON, Float,
)
from backend.db.database import Base


class JobStatus(str, enum.Enum):
    """Status of a scraped job listing."""
    NEW = "new"
    APPLYING = "applying"
    WAITING_ANSWER = "waiting_answer"
    APPLIED = "applied"
    FAILED = "failed"
    SKIPPED = "skipped"


class ApplicationStatus(str, enum.Enum):
    """Possible states for a job application."""
    APPLIED = "applied"
    FAILED = "failed"
    SKIPPED = "skipped"
    INTERVIEWING = "interviewing"
    REJECTED = "rejected"
    OFFER = "offer"


class ScrapedJob(Base):
    """A job listing found by the scraper. Shown on dashboard for user to act on."""
    __tablename__ = "scraped_jobs"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String, default="linkedin")
    title = Column(String, nullable=False)
    company = Column(String, nullable=False)
    location = Column(String, default="")
    url = Column(String, nullable=False, unique=True)
    description = Column(Text, default="")
    easy_apply = Column(Integer, default=1)
    status = Column(Enum(JobStatus, values_callable=lambda x: [e.value for e in x]), default=JobStatus.NEW)
    scraped_at = Column(DateTime, default=datetime.datetime.utcnow)
    posted_date = Column(DateTime, nullable=True)  # When the job was posted on LinkedIn

    # AI match analysis (populated after scrape via Ollama)
    match_score = Column(Integer, default=0)  # 0-100
    requirements_met = Column(Integer, default=0)
    requirements_total = Column(Integer, default=0)
    match_summary = Column(Text, default="")  # AI-generated summary
    requirements_detail = Column(JSON, default=list)  # [{req: str, met: bool}]
    salary_range = Column(String, default="")
    company_size = Column(String, default="")
    company_description = Column(Text, default="")
    company_logo = Column(String, default="")
    ats_type = Column(String, default="")  # easy_apply, greenhouse, lever, workday, other

    # Smart filter fields
    experience_years_required = Column(Integer, nullable=True)  # AI-extracted from description
    skip_reason = Column(String, default="")


class PendingQuestion(Base):
    """A question the bot got stuck on during an application. User must answer."""
    __tablename__ = "pending_questions"

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, nullable=False)  # FK to scraped_jobs
    task_id = Column(String, nullable=True)
    question = Column(Text, nullable=False)
    field_type = Column(String, default="text")  # text, select, radio, checkbox
    options = Column(JSON, default=list)  # for select/radio: list of option strings
    answer = Column(Text, nullable=True)  # user's answer, null until answered
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class ResumeProfileDB(Base):
    """Stores a parsed resume profile in the database."""
    __tablename__ = "resume_profiles"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    location = Column(String, nullable=True)
    linkedin_url = Column(String, nullable=True)
    skills = Column(JSON, default=list)
    experience = Column(JSON, default=list)
    education = Column(JSON, default=list)
    raw_text = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class ApplicationRecord(Base):
    """Tracks every job application the bot makes or the user logs."""
    __tablename__ = "application_records"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String, nullable=False, default="linkedin")
    company = Column(String, nullable=False)
    role = Column(String, nullable=False)
    url = Column(String, nullable=True)
    status = Column(Enum(ApplicationStatus, values_callable=lambda x: [e.value for e in x]), default=ApplicationStatus.APPLIED)
    applied_at = Column(DateTime, default=datetime.datetime.utcnow)
    notes = Column(Text, nullable=True)
    resume_version = Column(String, default="original")  # original or tailored
    job_id = Column(Integer, nullable=True)  # FK to scraped_jobs

    # Enhanced tracking fields
    screenshot_path = Column(String, default="")          # Pre-submit screenshot
    failure_screenshot_path = Column(String, default="")   # Failure debug screenshot
    cover_letter_text = Column(Text, default="")           # Generated cover letter
    questions_answered = Column(JSON, default=list)        # [{question, answer, source}]
    ats_type = Column(String, default="")


class UserSettings(Base):
    """
    All client-configurable settings stored in DB.
    Includes prefilled answers for common application questions.
    """
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, index=True)

    # LinkedIn credentials
    linkedin_email = Column(String, default="")
    linkedin_password_encrypted = Column(String, default="")

    # Personal info for form filling
    first_name = Column(String, default="")
    last_name = Column(String, default="")
    email = Column(String, default="")
    phone = Column(String, default="")
    city = Column(String, default="")
    linkedin_url = Column(String, default="")
    website = Column(String, default="")

    # Resume file path
    resume_file_path = Column(String, default="")

    # LinkedIn session cookies
    linkedin_cookies = Column(Text, default="")

    # Bot preferences
    job_title = Column(String, default="Software Engineer")
    location = Column(String, default="United States")
    remote_only = Column(Integer, default=0)
    max_applications_per_run = Column(Integer, default=25)

    # Filters
    experience_levels = Column(String, default="")
    work_type = Column(String, default="")
    regions = Column(String, default="")

    # Prefilled answers for common application questions (JSON dict)
    # e.g. {"Are you a veteran?": "No", "Citizenship": "US Citizen", ...}
    prefilled_answers = Column(JSON, default=dict)

    # Smart filter settings
    company_blacklist = Column(JSON, default=list)       # ["Company A", "Company B"]
    keyword_blacklist = Column(JSON, default=list)       # ["unpaid", "intern only"]
    min_salary = Column(Integer, nullable=True)
    max_salary = Column(Integer, nullable=True)
    min_experience_years = Column(Integer, nullable=True)
    max_experience_years = Column(Integer, nullable=True)

    # Autopilot settings
    autopilot_enabled = Column(Integer, default=0)
    daily_apply_limit = Column(Integer, default=50)
    weekly_apply_limit = Column(Integer, default=200)
    apply_delay_min = Column(Float, default=30.0)        # Seconds between apps
    apply_delay_max = Column(Float, default=120.0)

    # UX toggles
    pause_before_submit = Column(Integer, default=0)
    follow_companies = Column(Integer, default=0)
    smooth_scrolling = Column(Integer, default=0)

    # HR outreach
    hr_outreach_enabled = Column(Integer, default=0)
    hr_daily_connect_limit = Column(Integer, default=10)

    # AI features
    resume_tailoring_enabled = Column(Integer, default=0)


class BotRun(Base):
    """Persisted record of a bot execution for historical review."""
    __tablename__ = "bot_runs"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(String, unique=True, index=True)
    status = Column(String, default="idle")
    started_at = Column(DateTime, default=datetime.datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    total_applied = Column(Integer, default=0)
    total_skipped = Column(Integer, default=0)
    total_failed = Column(Integer, default=0)
    log_lines = Column(JSON, default=list)


class ConnectionRequest(Base):
    """Tracks connection requests sent to hiring managers after applying."""
    __tablename__ = "connection_requests"

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, nullable=True)
    contact_name = Column(String, nullable=False)
    contact_title = Column(String, default="")
    company = Column(String, nullable=False)
    role_applied = Column(String, default="")
    message_sent = Column(Text, default="")
    status = Column(String, default="sent")  # sent, accepted, pending
    sent_at = Column(DateTime, default=datetime.datetime.utcnow)


class AutopilotRun(Base):
    """Tracks each autopilot session with aggregate stats."""
    __tablename__ = "autopilot_runs"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(String, unique=True, index=True)
    started_at = Column(DateTime, default=datetime.datetime.utcnow)
    stopped_at = Column(DateTime, nullable=True)
    total_applied = Column(Integer, default=0)
    total_skipped = Column(Integer, default=0)
    total_failed = Column(Integer, default=0)
    total_waiting = Column(Integer, default=0)
    status = Column(String, default="running")  # running, stopped, limit_reached
