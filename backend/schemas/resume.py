"""
Pydantic schemas for resume parsing and profile data.
"""

from datetime import datetime
from pydantic import BaseModel
from typing import Optional


class EducationItem(BaseModel):
    """A single education entry."""
    school: str = ""
    degree: str = ""
    start_date: str = ""
    end_date: str = ""
    gpa: str = ""
    achievements: list[str] = []
    coursework: list[str] = []


class ExperienceItem(BaseModel):
    """A single work experience entry."""
    company: str = ""
    title: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    bullets: list[str] = []


class ProjectItem(BaseModel):
    """A single project entry."""
    name: str = ""
    link: str = ""
    organization: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    bullets: list[str] = []


class ResumeProfile(BaseModel):
    """Typed resume profile returned by the parser and Ollama analysis."""
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin_url: str = ""
    github_url: str = ""
    other_link: str = ""
    skills: list[str] = []  # flat list for backward compat
    experience: list[ExperienceItem] = []
    education: list[EducationItem] = []
    projects: list[ProjectItem] = []
    technologies: dict[str, list[str]] = {}  # category → skills

    model_config = {"from_attributes": True}


class AnalysisReport(BaseModel):
    """AI-generated quality assessment of a resume."""
    overall_grade: str  # "EXCELLENT" | "GOOD" | "FAIR"
    urgent_fix_count: int
    critical_fix_count: int
    optional_fix_count: int
    summary: str
    highlights: list[str]


class ResumeUploadResponse(BaseModel):
    """Response after uploading and parsing a resume."""
    id: int
    profile: ResumeProfile


class ResumeListItem(BaseModel):
    """Summary item for the resume list view."""
    id: int
    name: str
    target_job_title: str | None
    is_primary: bool
    status: str
    created_at: datetime
    updated_at: datetime
    # True when the original PDF/DOCX is stored and can be auto-uploaded by the
    # Chrome extension (GET /resumes/{id}/file).
    has_file: bool = False


class ResumeDetailResponse(BaseModel):
    """Full resume detail including profile and analysis."""
    id: int
    name: str
    target_job_title: str | None
    is_primary: bool
    profile: ResumeProfile
    analysis_report: AnalysisReport | None
    created_at: datetime
    updated_at: datetime


class ResumeUpdateRequest(BaseModel):
    """Request body for updating a resume."""
    name: str | None = None
    target_job_title: str | None = None
    profile: ResumeProfile | None = None
