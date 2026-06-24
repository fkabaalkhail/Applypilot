"""
Structured resume document — the single source of truth for the AI Resume
Rewriter.

One schema drives the renderer (live preview), the PDF export, and the DOCX
export, so all three are guaranteed identical. The AI rewrite edits only the
text *content* of a document; the section structure and the visual ``theme`` are
preserved, which is what keeps the downloaded file matching the preview.
"""

import uuid
from typing import Literal

from pydantic import BaseModel, Field

SectionType = Literal[
    "summary",
    "experience",
    "education",
    "projects",
    "skills",
    "technologies",
    "certifications",
    "custom",
]


def _sid() -> str:
    """Short, stable id so the renderer/editor can key off sections + items."""
    return uuid.uuid4().hex[:8]


class SectionItem(BaseModel):
    """A single entry within a section (a job, a degree, a project, a cert…).

    Which fields are populated depends on the parent section's ``type``, but the
    shape is uniform so the renderer and the LLM round-trip stay simple.
    """

    id: str = Field(default_factory=_sid)
    title: str = ""        # role / degree / project name / certification name
    subtitle: str = ""     # company / school / issuing organization
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    detail: str = ""       # GPA, degree note, one-line project blurb, etc.
    link: str = ""
    bullets: list[str] = []


class Section(BaseModel):
    """An ordered resume section. Content lives in the field matching ``type``."""

    id: str = Field(default_factory=_sid)
    type: SectionType
    title: str = ""                     # display heading, e.g. "WORK EXPERIENCE"
    text: str = ""                      # used by `summary` / `custom`
    items: list[SectionItem] = []       # experience / education / projects / certifications
    skills: list[str] = []              # used by `skills`
    groups: dict[str, list[str]] = {}   # used by `technologies` (category -> items)


class Theme(BaseModel):
    """Visual settings we own (the spec's 'layout schema', reinterpreted).

    The AI never touches this — it is what guarantees a clean, consistent,
    ATS-safe layout regardless of what the original file looked like.
    """

    template_id: str = "classic"
    font_family: str = "Calibri, 'Segoe UI', Helvetica, Arial, sans-serif"
    base_font_pt: float = 10.5
    name_font_pt: float = 22.0
    heading_font_pt: float = 12.0
    section_spacing_pt: int = 12
    line_height: float = 1.28
    accent_color: str = "#1f2937"
    text_color: str = "#1f2937"
    columns: int = 1                    # 1 or 2
    page_size: Literal["letter", "a4"] = "letter"


class ResumeHeader(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin_url: str = ""
    github_url: str = ""
    other_link: str = ""


class ResumeDocument(BaseModel):
    """The whole resume: contact header + ordered sections + theme."""

    header: ResumeHeader = Field(default_factory=ResumeHeader)
    sections: list[Section] = []
    theme: Theme = Field(default_factory=Theme)

    model_config = {"from_attributes": True}
