"""
Pydantic schemas for resume parsing and profile data.
"""

import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, Field, PlainSerializer


def _utc_iso(value: datetime) -> str:
    """Serialize a datetime as UTC ISO-8601 with an explicit offset.

    The DB columns store naive UTC (``datetime.utcnow``). Without the offset,
    ``new Date(...)`` in the browser reads the string as *local* time, so a
    just-created resume looks hours in the future ("-240m ago").
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


UtcDateTime = Annotated[datetime, PlainSerializer(_utc_iso, return_type=str)]

Severity = Literal["urgent", "critical", "optional"]


def _sid() -> str:
    """Short, stable id (matches the resume_document convention)."""
    return uuid.uuid4().hex[:8]


class EducationItem(BaseModel):
    """A single education entry."""
    school: str = ""
    degree: str = ""
    location: str = ""
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


class CustomSectionItem(BaseModel):
    """An entry inside a custom section. Mirrors ``resume_document.SectionItem``."""
    title: str = ""
    subtitle: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    detail: str = ""
    link: str = ""
    bullets: list[str] = []


class CustomSection(BaseModel):
    """Any section that is not experience/education/projects/skills/technologies.

    Certifications, awards, volunteering, publications, languages, leadership,
    interests, resumes carry all of these and each one used to be dropped on
    upload. The user's own heading is kept verbatim in ``title``.

    A section carries whichever of ``text`` / ``bullets`` / ``items`` matches how
    it was written; the renderer shows all three.
    """
    id: str = Field(default_factory=_sid)
    title: str = ""
    kind: Literal["certifications", "custom"] = "custom"
    text: str = ""
    bullets: list[str] = []
    items: list[CustomSectionItem] = []


class ResumeProfile(BaseModel):
    """Typed resume profile returned by the parser and the LLM analysis."""
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin_url: str = ""
    github_url: str = ""
    other_link: str = ""
    summary: str = ""
    summary_title: str = ""
    skills: list[str] = []  # flat list for backward compat
    experience: list[ExperienceItem] = []
    education: list[EducationItem] = []
    projects: list[ProjectItem] = []
    technologies: dict[str, list[str]] = {}  # category → skills
    custom_sections: list[CustomSection] = []
    # Section keys in the order they appeared in the uploaded file, e.g.
    # ["summary", "experience", "projects", "custom:a1b2", "education"].
    section_order: list[str] = []

    model_config = {"from_attributes": True}


class AnalysisIssue(BaseModel):
    """One concrete, evidence-backed finding about the resume."""
    id: str = Field(default_factory=_sid)
    title: str = ""
    severity: Severity = "optional"
    # How many places in the resume show this problem ("3 issues related").
    count: int = 1
    description: str = ""
    # Verbatim snippets from the resume that demonstrate the issue.
    evidence: list[str] = []
    # A concrete fix. Never contains an invented metric, quantification gaps
    # are written with a [placeholder] the candidate fills in.
    suggestion: str = ""
    # Which resume section it lives in ("Work Experience", "Skills", …).
    section: str = ""


class AnalysisCategory(BaseModel):
    """A scored dimension of resume quality, with its issues."""
    id: str = ""
    name: str = ""
    score: int = 0  # 0-100
    why_it_matters: str = ""
    issues: list[AnalysisIssue] = []


class AnalysisReport(BaseModel):
    """AI-generated quality assessment of a resume.

    Every field added after the first release defaults, so reports persisted by
    the old shallow analyzer still load.
    """
    overall_grade: str  # "EXCELLENT" | "GOOD" | "FAIR"
    urgent_fix_count: int
    critical_fix_count: int
    optional_fix_count: int
    summary: str
    highlights: list[str]
    letter_grade: str = ""  # "A+", "A", "B" …
    score: int = 0  # 0-100
    strengths: list[str] = []
    categories: list[AnalysisCategory] = []
    analyzed_at: UtcDateTime | None = None


class ResumeUploadResponse(BaseModel):
    """Response after uploading and parsing a resume."""
    id: int
    profile: ResumeProfile


class ResumeImproveResponse(BaseModel):
    """Preview of an AI improvement pass. Nothing is persisted until the client
    saves the returned profile via ``PUT /resumes/{id}``."""
    profile: ResumeProfile
    changes: list[str] = []


class ResumeListItem(BaseModel):
    """Summary item for the resume list view."""
    id: int
    name: str
    target_job_title: str | None
    is_primary: bool
    status: str
    created_at: UtcDateTime
    updated_at: UtcDateTime
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
    created_at: UtcDateTime
    updated_at: UtcDateTime


class ResumeUpdateRequest(BaseModel):
    """Request body for updating a resume."""
    name: str | None = None
    target_job_title: str | None = None
    profile: ResumeProfile | None = None
