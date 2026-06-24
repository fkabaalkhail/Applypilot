"""
Pydantic schemas for AI-generated content (tailored resumes, cover letters).
"""

import datetime
from pydantic import BaseModel

from backend.schemas.resume_document import ResumeDocument


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


# ---------------------------------------------------------------------------
# Web "Generate Custom Resume" flow (See Difference → Align → Review)
# ---------------------------------------------------------------------------


class JobAnalysisOut(BaseModel):
    """Resume↔job analysis for the rewrite flow's Step 1 (keyword comparison)."""
    overall_score: int  # 0-100
    ats_score: int  # 0-100
    match_label: str  # STRONG / GOOD / FAIR MATCH
    keyword_coverage: int  # 0-100, derived from matched/missing
    matched_keywords: list[str] = []
    missing_keywords: list[str] = []
    strengths: list[str] = []
    weaknesses: list[str] = []
    suggestions: list[str] = []


class RewriteIn(BaseModel):
    """Options chosen in the 'Align' step (all optional)."""
    resume_id: int | None = None
    sections: list[str] = []  # e.g. ["Skills", "Work Experience", "Projects"]
    add_keywords: list[str] = []


class RewriteOut(BaseModel):
    """Result of the tailoring pass, with before/after scores for Step 3.

    ``document`` is the structured, rewritten resume that the renderer/export
    consume (the single source of truth). ``tailored_text``/``original_text``
    are flattened plain text kept for the Copy button and diffing.
    """
    document: ResumeDocument
    original_document: ResumeDocument
    tailored_text: str
    original_text: str
    diff_summary: str
    original_overall_score: int
    new_overall_score: int
    new_ats_score: int
    new_keyword_coverage: int
    version_id: int | None = None


class CoverLetterIn(BaseModel):
    """Optional body for /ai/cover-letter/{job_id} (resume choice + tone)."""
    resume_id: int | None = None
    # professional | formal | enthusiastic | concise | technical
    tone: str | None = None
    # When regenerating in a new tone, the existing letter to rewrite.
    base_text: str | None = None


# ---------------------------------------------------------------------------
# Version history (Phase 4) + inline edit assistant (Phase 5)
# ---------------------------------------------------------------------------


class ResumeVersionIn(BaseModel):
    """Save a structured resume document as a version."""
    resume_id: int | None = None
    job_id: int | None = None
    label: str = ""
    source: str = "user"  # original | ai | user
    document: ResumeDocument


class ResumeVersionOut(BaseModel):
    """A stored resume version returned to the frontend."""
    id: int
    resume_id: int | None
    job_id: int | None
    label: str
    source: str
    document: ResumeDocument
    created_at: datetime.datetime


class SnippetEditIn(BaseModel):
    """Apply an AI action to a selected snippet of resume text."""
    text: str
    # rewrite | shorten | expand | professional | ats | impact | grammar
    action: str
    job_id: int | None = None


class SnippetEditOut(BaseModel):
    text: str
