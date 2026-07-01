"""
SQLAlchemy ORM models for the Auto Apply Bot.

Models:
    - User: authenticated user
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
    Boolean, Column, Integer, String, Text, DateTime, Enum, JSON, Float,
    ForeignKey, UniqueConstraint, func,
)
from backend.db.database import Base


# ─── User ────────────────────────────────────────────────────────────────────

class User(Base):
    """Authenticated user. Links all user-specific data."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    hashed_password = Column(String, nullable=True)  # nullable for OAuth-only users
    auth_provider = Column(String, default="local")  # "local" or "google"
    first_name = Column(String, default="")
    last_name = Column(String, default="")
    profile_image_url = Column(String, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow,
                        onupdate=datetime.datetime.utcnow)

    # Email verification fields
    email_verified = Column(Boolean, default=False, nullable=False)
    verification_token = Column(String(255), nullable=True, default=None)
    verification_token_expires_at = Column(DateTime, nullable=True, default=None)

    # Admin role
    is_admin = Column(Boolean, default=False, nullable=False)

    # Account lockout fields
    failed_login_attempts = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime, nullable=True)
    last_failed_login_at = Column(DateTime, nullable=True)

    # --- Onboarding ---
    has_completed_onboarding = Column(Boolean, default=False, nullable=False)


# ─── Enums ───────────────────────────────────────────────────────────────────

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


# ─── Jobs ────────────────────────────────────────────────────────────────────

class ScrapedJob(Base):
    """A job listing found by the scraper. Shown on dashboard for user to act on."""
    __tablename__ = "scraped_jobs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    platform = Column(String, default="linkedin")
    title = Column(String, nullable=False)
    company = Column(String, nullable=False)
    location = Column(String, default="")
    url = Column(String, nullable=False, unique=True)
    description = Column(Text, default="")
    easy_apply = Column(Integer, default=1)
    status = Column(Enum(JobStatus, values_callable=lambda x: [e.value for e in x]), default=JobStatus.NEW)
    scraped_at = Column(DateTime, default=datetime.datetime.utcnow)
    posted_date = Column(DateTime, nullable=True)

    # AI match analysis
    match_score = Column(Integer, default=0)
    requirements_met = Column(Integer, default=0)
    requirements_total = Column(Integer, default=0)
    match_summary = Column(Text, default="")
    requirements_detail = Column(JSON, default=list)
    salary_range = Column(String, default="")
    company_size = Column(String, default="")
    company_description = Column(Text, default="")
    company_logo = Column(String, default="")
    ats_type = Column(String, default="")

    # Smart filter fields
    experience_years_required = Column(Integer, nullable=True)
    skip_reason = Column(String, default="")

    # Multi-source tracking & dashboard enhancements
    source_platform = Column(String, default="linkedin")
    saved = Column(Integer, default=0)
    experience_score = Column(Integer, default=0)
    skill_score = Column(Integer, default=0)
    industry_score = Column(Integer, default=0)
    match_label = Column(String, default="")
    applicant_count = Column(Integer, nullable=True)
    github_source_id = Column(Integer, nullable=True)
    last_viewed_at = Column(DateTime, nullable=True)

    # Job aggregator classification fields
    work_type = Column(String, default="onsite")
    role_category = Column(String, default="")
    country = Column(String, default="")
    experience_level = Column(String, default="")

    # Logo accuracy: the resolved company website domain (e.g. "stripe.com")
    # and the raw company website URL captured from the source listing.
    company_domain = Column(String, default="")
    company_url = Column(String, default="")


class PendingQuestion(Base):
    """A question the bot got stuck on during an application. User must answer."""
    __tablename__ = "pending_questions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    job_id = Column(Integer, nullable=False)
    task_id = Column(String, nullable=True)
    question = Column(Text, nullable=False)
    field_type = Column(String, default="text")
    options = Column(JSON, default=list)
    answer = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class SavedAnswer(Base):
    """A previously approved application answer, reusable across applications.

    Searched by semantic similarity (embedding cosine) so the same question is
    recognized regardless of company/role wording. Written only after the user
    accepts or edits a suggestion — see POST /api/answers."""
    __tablename__ = "saved_answers"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    question_raw = Column(Text, nullable=False)
    question_canonical = Column(Text, nullable=False, index=True)
    answer = Column(Text, nullable=False)
    category = Column(String, default="general")
    embedding = Column(JSON, default=list)
    embedding_model = Column(String, default="")
    source = Column(String, default="ai")
    times_reused = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow,
                        onupdate=datetime.datetime.utcnow)


class ResumeProfileDB(Base):
    """Stores a parsed resume profile in the database."""
    __tablename__ = "resume_profiles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String, default="Untitled Resume")
    target_job_title = Column(String, nullable=True)
    is_primary = Column(Integer, default=0)
    status = Column(String, default="analyzed")

    # Personal info
    profile_name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    location = Column(String, nullable=True)
    linkedin_url = Column(String, nullable=True)
    github_url = Column(String, nullable=True)
    other_link = Column(String, nullable=True)

    # Structured sections (JSON)
    skills = Column(JSON, default=list)
    experience = Column(JSON, default=list)
    education = Column(JSON, default=list)
    projects = Column(JSON, default=list)
    technologies = Column(JSON, default=dict)

    # Raw text and analysis
    raw_text = Column(Text, nullable=True)
    analysis_report = Column(JSON, nullable=True)

    # Original uploaded file, stored in Vercel Blob. Enables the Chrome
    # extension to auto-upload the real PDF/DOCX into ATS application forms.
    file_blob_url = Column(Text, nullable=True)
    file_name = Column(String, nullable=True)
    file_content_type = Column(String, nullable=True)
    file_size = Column(Integer, nullable=True)
    file_uploaded_at = Column(DateTime, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow,
                        onupdate=datetime.datetime.utcnow)


class JobMatchNotification(Base):
    """Records that we emailed a user about a high-scoring job match.

    One row per (user, job). Used to dedupe alert emails so a user is never
    notified twice about the same job, whether the match was found during a
    resume upload or by the recurring cron sweep.
    """
    __tablename__ = "job_match_notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    job_id = Column(Integer, ForeignKey("scraped_jobs.id"), nullable=False, index=True)
    match_score = Column(Integer, default=0)
    sent_at = Column(DateTime, default=datetime.datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "job_id", name="uq_job_match_notification_user_job"),
    )


class ApplicationRecord(Base):
    """Tracks every job application the bot makes or the user logs."""
    __tablename__ = "application_records"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    platform = Column(String, nullable=False, default="linkedin")
    company = Column(String, nullable=False)
    role = Column(String, nullable=False)
    url = Column(String, nullable=True)
    status = Column(Enum(ApplicationStatus, values_callable=lambda x: [e.value for e in x]), default=ApplicationStatus.APPLIED)
    applied_at = Column(DateTime, default=datetime.datetime.utcnow)
    notes = Column(Text, nullable=True)
    resume_version = Column(String, default="original")
    job_id = Column(Integer, nullable=True)

    # Enhanced tracking fields
    screenshot_path = Column(String, default="")
    failure_screenshot_path = Column(String, default="")
    cover_letter_text = Column(Text, default="")
    questions_answered = Column(JSON, default=list)
    ats_type = Column(String, default="")


class UserSettings(Base):
    """All client-configurable settings stored in DB."""
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, unique=True, index=True)

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

    # Prefilled answers
    prefilled_answers = Column(JSON, default=dict)

    # Smart filter settings
    company_blacklist = Column(JSON, default=list)
    keyword_blacklist = Column(JSON, default=list)
    min_salary = Column(Integer, nullable=True)
    max_salary = Column(Integer, nullable=True)
    min_experience_years = Column(Integer, nullable=True)
    max_experience_years = Column(Integer, nullable=True)

    # Autopilot settings
    autopilot_enabled = Column(Integer, default=0)
    daily_apply_limit = Column(Integer, default=50)
    weekly_apply_limit = Column(Integer, default=200)
    apply_delay_min = Column(Float, default=30.0)
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

    # Sync versioning — bumped on any profile / resume / cover-letter change so
    # the extension can cheaply detect staleness via GET /api/user/profile-version
    # and refetch only when something actually changed.
    data_version = Column(Integer, default=1, nullable=False)
    data_updated_at = Column(DateTime, default=datetime.datetime.utcnow,
                             onupdate=datetime.datetime.utcnow)


class BotRun(Base):
    """Persisted record of a bot execution for historical review."""
    __tablename__ = "bot_runs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
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
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    job_id = Column(Integer, nullable=True)
    contact_name = Column(String, nullable=False)
    contact_title = Column(String, default="")
    company = Column(String, nullable=False)
    role_applied = Column(String, default="")
    message_sent = Column(Text, default="")
    status = Column(String, default="sent")
    sent_at = Column(DateTime, default=datetime.datetime.utcnow)


class AutopilotRun(Base):
    """Tracks each autopilot session with aggregate stats."""
    __tablename__ = "autopilot_runs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    task_id = Column(String, unique=True, index=True)
    started_at = Column(DateTime, default=datetime.datetime.utcnow)
    stopped_at = Column(DateTime, nullable=True)
    total_applied = Column(Integer, default=0)
    total_skipped = Column(Integer, default=0)
    total_failed = Column(Integer, default=0)
    total_waiting = Column(Integer, default=0)
    status = Column(String, default="running")


class GitHubSource(Base):
    """A configured GitHub repository job source."""
    __tablename__ = "github_sources"

    id = Column(Integer, primary_key=True, index=True)
    repo_url = Column(String, nullable=False, unique=True)
    repo_owner = Column(String, nullable=False)
    repo_name = Column(String, nullable=False)
    file_path = Column(String, default="README.md")
    poll_interval_minutes = Column(Integer, default=60)
    last_polled_at = Column(DateTime, nullable=True)
    last_commit_sha = Column(String, nullable=True)
    status = Column(String, default="active")
    error_message = Column(String, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Aggregator classification defaults
    role_category = Column(String, default="")
    experience_level = Column(String, default="")


class TailoredResume(Base):
    """A resume version tailored for a specific job."""
    __tablename__ = "tailored_resumes"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    job_id = Column(Integer, nullable=False)
    original_text = Column(Text, nullable=False)
    tailored_text = Column(Text, nullable=False)
    diff_summary = Column(Text, default="")
    status = Column(String, default="draft")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class ResumeVersion(Base):
    """A saved version of a structured resume document.

    Backs version history and job-specific resume generation. ``document_json``
    is a serialized ``ResumeDocument``; ``source`` is one of original | ai | user.
    """
    __tablename__ = "resume_versions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    resume_id = Column(Integer, ForeignKey("resume_profiles.id"), nullable=True, index=True)
    job_id = Column(Integer, nullable=True, index=True)
    label = Column(String, default="")
    source = Column(String, default="ai")  # original | ai | user
    document_json = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class CoverLetter(Base):
    """A saved cover letter, optionally tied to a specific job.

    Generated by ``CoverLetterGenerator`` or written/edited by the user. Synced
    to the extension so it can be inserted into ATS cover-letter fields. One
    cover letter per user may be flagged ``is_active`` as the default.
    """
    __tablename__ = "cover_letters"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    resume_id = Column(Integer, nullable=True)
    job_id = Column(Integer, nullable=True, index=True)
    job_title = Column(String, default="")
    company = Column(String, default="")
    job_url = Column(String, default="")
    text = Column(Text, default="")
    tone = Column(String, default="")
    source = Column(String, default="generated")  # generated | user
    is_active = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow,
                        onupdate=datetime.datetime.utcnow)


class InsiderConnection(Base):
    """A connection at a target company."""
    __tablename__ = "insider_connections"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    company = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    title = Column(String, default="")
    linkedin_url = Column(String, default="")
    relationship_type = Column(String, default="beyond_network")
    source = Column(String, default="linkedin")
    discovered_at = Column(DateTime, default=datetime.datetime.utcnow)


# ─── Feedback ────────────────────────────────────────────────────────────────

class Feedback(Base):
    """User-submitted feedback (bug reports, feature requests, etc.)."""
    __tablename__ = "feedback"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, default="")
    category = Column(String, default="")  # bug_report, feature_request, ux_feedback, subscription, other
    message = Column(Text, default="")
    wants_followup = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())


# ─── User Saved Jobs (per-user bookmarks) ────────────────────────────────────

class UserSavedJob(Base):
    """Per-user job bookmarks (many-to-many between users and jobs)."""
    __tablename__ = "user_saved_jobs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    job_id = Column(Integer, ForeignKey("scraped_jobs.id"), nullable=False, index=True)
    saved_at = Column(DateTime, default=datetime.datetime.utcnow)


# ─── Revoked Tokens (for token blacklisting) ─────────────────────────────────

class RevokedToken(Base):
    """Stores revoked refresh tokens to prevent reuse after logout/password change."""
    __tablename__ = "revoked_tokens"

    id = Column(Integer, primary_key=True, index=True)
    jti = Column(String(255), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    revoked_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)


# ─── Extension Auth Codes (PKCE handshake) ──────────────────────────────────

class ExtensionAuthCode(Base):
    """Short-lived, single-use authorization code for the extension handshake.

    Issued by ``POST /auth/extension/authorize`` to an authenticated web session
    and redeemed once by ``POST /auth/extension/token`` with the matching PKCE
    verifier. Bound to a user and a SHA-256 ``code_challenge``; expires in ~60s.
    This is how the extension obtains tokens without ever handling credentials.
    """
    __tablename__ = "extension_auth_codes"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(255), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    code_challenge = Column(String(255), nullable=False)
    redirect_uri = Column(String, nullable=False)
    used = Column(Boolean, default=False, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


# ─── Sessions (Connected Devices registry) ──────────────────────────────────

class Session(Base):
    """A long-lived auth session (one per connect / login), keyed by a stable
    ``sid`` that survives refresh-token rotation. Backs the "Connected Devices"
    dashboard and per-device revocation. ``revoked_at`` set => the session's next
    refresh is rejected. Labels/UA-parsing are intentionally omitted (YAGNI)."""
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    sid = Column(String(36), unique=True, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    client = Column(String(20), nullable=False, default="web")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.datetime.utcnow)
    revoked_at = Column(DateTime, nullable=True)
    last_ip = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)


# ─── Security Event Log ──────────────────────────────────────────────────────

class SecurityEvent(Base):
    """Structured security audit log for authentication and access events."""
    __tablename__ = "security_events"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String(100), nullable=False, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    details = Column(JSON, nullable=True)
    success = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), index=True)


class RateCounter(Base):
    """Fixed-window request counter, shared across serverless instances.

    Each row is one (limit-name, identity, time-bucket) tuple. Because the
    counter lives in the database rather than process memory, the limit holds
    consistently across Vercel function invocations. Rows are disposable —
    ``expires_at`` lets a periodic cleanup drop stale buckets.
    """
    __tablename__ = "rate_counters"

    bucket_key = Column(String(255), primary_key=True)
    count = Column(Integer, default=0, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
