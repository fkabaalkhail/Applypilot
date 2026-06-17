"""
Application profile endpoint for the Chrome extension.

GET /api/user/application-profile — the canonical, ready-to-fill profile the
extension autofills from. It merges the three places a user's data can live:

    1. ResumeProfileDB  — data parsed from the uploaded resume (what the web
                          app's Profile page shows). This is the primary source.
    2. UserSettings     — manually-entered form-filling fields + screening answers.
    3. User             — account name/email as a final fallback.

The response uses camelCase keys so it maps 1:1 onto the extension's
`UserApplicationProfile` type (see chrome-extension/src/shared/types.ts). Before
this endpoint existed the extension fell back to GET /settings, which a resume
upload never populates — so signed-in users saw an empty profile.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ResumeProfileDB, User, UserSettings
from backend.auth.dependencies import get_verified_user

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Response schema (camelCase to match the extension) ──────────────────────

class EducationEntry(BaseModel):
    school: str = ""
    degree: str = ""
    graduationYear: str = ""


class ExperienceEntry(BaseModel):
    company: str = ""
    title: str = ""
    startDate: str = ""
    endDate: str = ""
    description: str = ""


class ApplicationProfileOut(BaseModel):
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    currentCompany: str = ""
    currentTitle: str = ""
    workAuthorization: str = ""
    requiresSponsorship: str = ""
    education: list[EducationEntry] = []
    experience: list[ExperienceEntry] = []
    skills: list[str] = []
    coverLetter: str = ""


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _first_non_empty(*values: object) -> str:
    """First value that is a non-blank string, else ""."""
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _split_name(full_name: str) -> tuple[str, str]:
    """'Wissam Elmasry' -> ('Wissam', 'Elmasry'); single token -> (token, '')."""
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _mine_screening(prefilled: dict | None) -> tuple[str, str]:
    """
    Pull work-authorization and sponsorship answers out of the free-form
    prefilled_answers question→answer map. Mirrors the client-side logic that
    used to live in chrome-extension/src/api/client.ts (mapSettingsToProfile).
    """
    work_authorization = ""
    requires_sponsorship = ""
    for question, answer in (prefilled or {}).items():
        if not isinstance(answer, str):
            continue
        q = question.lower()
        if not requires_sponsorship and "sponsor" in q:
            requires_sponsorship = answer
        elif not work_authorization and ("authoriz" in q or "eligible" in q):
            work_authorization = answer
    return work_authorization, requires_sponsorship


def _flatten_skills(skills: object, technologies: object) -> list[str]:
    """Combine the flat skills list with the categorized technologies, deduped."""
    out: list[str] = []
    seen: set[str] = set()

    def add(item: object) -> None:
        if isinstance(item, str):
            s = item.strip()
            key = s.lower()
            if s and key not in seen:
                seen.add(key)
                out.append(s)

    if isinstance(skills, list):
        for s in skills:
            add(s)
    if isinstance(technologies, dict):
        for values in technologies.values():
            if isinstance(values, list):
                for s in values:
                    add(s)
    return out


def _map_experience(raw: object) -> list[ExperienceEntry]:
    items: list[ExperienceEntry] = []
    if not isinstance(raw, list):
        return items
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        bullets = entry.get("bullets") or []
        description = "\n".join(b for b in bullets if isinstance(b, str)) if isinstance(bullets, list) else ""
        items.append(
            ExperienceEntry(
                company=_first_non_empty(entry.get("company")),
                title=_first_non_empty(entry.get("title")),
                startDate=_first_non_empty(entry.get("start_date")),
                endDate=_first_non_empty(entry.get("end_date")),
                description=description,
            )
        )
    return items


def _map_education(raw: object) -> list[EducationEntry]:
    items: list[EducationEntry] = []
    if not isinstance(raw, list):
        return items
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        items.append(
            EducationEntry(
                school=_first_non_empty(entry.get("school")),
                degree=_first_non_empty(entry.get("degree")),
                # The extension models a single "graduation year"; the resume
                # stores a free-form end date, which is the closest fit.
                graduationYear=_first_non_empty(entry.get("end_date")),
            )
        )
    return items


# ─── Endpoint ────────────────────────────────────────────────────────────────

@router.get("/user/application-profile", response_model=ApplicationProfileOut)
def get_application_profile(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """
    Return the current user's ready-to-fill application profile, merged from
    their resume, settings, and account. 404 only when none of those exist.
    """
    resume = (
        db.query(ResumeProfileDB)
        .filter(ResumeProfileDB.user_id == user.id)
        .order_by(ResumeProfileDB.is_primary.desc(), ResumeProfileDB.created_at.desc())
        .first()
    )
    settings = db.query(UserSettings).filter(UserSettings.user_id == user.id).first()

    if resume is None and settings is None:
        raise HTTPException(
            status_code=404,
            detail="No application profile yet. Upload a resume or fill in your settings first.",
        )

    # Name: prefer the resume's parsed name, then settings, then the account.
    resume_first, resume_last = _split_name(resume.profile_name if resume else "")
    first_name = _first_non_empty(
        resume_first,
        settings.first_name if settings else "",
        user.first_name,
    )
    last_name = _first_non_empty(
        resume_last,
        settings.last_name if settings else "",
        user.last_name,
    )

    experience = _map_experience(resume.experience if resume else None)
    education = _map_education(resume.education if resume else None)
    skills = _flatten_skills(
        resume.skills if resume else None,
        resume.technologies if resume else None,
    )

    current_company = experience[0].company if experience else ""
    current_title = _first_non_empty(
        experience[0].title if experience else "",
        settings.job_title if settings else "",
    )

    work_authorization, requires_sponsorship = _mine_screening(
        settings.prefilled_answers if settings else None
    )

    return ApplicationProfileOut(
        firstName=first_name,
        lastName=last_name,
        email=_first_non_empty(
            resume.email if resume else "",
            settings.email if settings else "",
            user.email,
        ),
        phone=_first_non_empty(
            resume.phone if resume else "",
            settings.phone if settings else "",
        ),
        location=_first_non_empty(
            resume.location if resume else "",
            settings.city if settings else "",
            settings.location if settings else "",
        ),
        linkedin=_first_non_empty(
            resume.linkedin_url if resume else "",
            settings.linkedin_url if settings else "",
        ),
        github=_first_non_empty(resume.github_url if resume else ""),
        portfolio=_first_non_empty(
            resume.other_link if resume else "",
            settings.website if settings else "",
        ),
        currentCompany=current_company,
        currentTitle=current_title,
        workAuthorization=work_authorization,
        requiresSponsorship=requires_sponsorship,
        education=education,
        experience=experience,
        skills=skills,
        coverLetter="",
    )
