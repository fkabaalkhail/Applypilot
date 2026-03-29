"""
Pydantic schemas for resume parsing and profile data.
"""

from pydantic import BaseModel, EmailStr
from typing import Optional


class ExperienceItem(BaseModel):
    """A single work experience entry."""
    title: str
    company: str
    duration: str
    bullets: list[str] = []


class EducationItem(BaseModel):
    """A single education entry."""
    degree: str
    school: str
    year: str


class ResumeProfile(BaseModel):
    """Typed resume profile returned by the parser and Ollama analysis."""
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin_url: str = ""
    skills: list[str] = []
    experience: list[ExperienceItem] = []
    education: list[EducationItem] = []

    model_config = {"from_attributes": True}


class ResumeUploadResponse(BaseModel):
    """Response after uploading and parsing a resume."""
    id: int
    profile: ResumeProfile
