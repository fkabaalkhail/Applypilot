"""
POST /api/fill — AI form-filling endpoint.

Takes form fields + resume context, returns AI-generated answers.
Used by both the Plasmo extension and the React frontend.
"""

import logging
from typing import Optional

from pydantic import BaseModel
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import UserSettings, ResumeProfileDB
from backend.auth.dependencies import get_verified_user_id
from backend.services.llm import get_llm_service

logger = logging.getLogger(__name__)
router = APIRouter()


class FormField(BaseModel):
    """A single form field to fill."""
    id: str = ""
    label: str
    type: str = "text"  # text, select, radio, checkbox, textarea
    options: list[str] = []
    required: bool = False


class FillRequest(BaseModel):
    """Request body for /api/fill."""
    fields: list[FormField]
    resumeText: str = ""
    jobDescription: str = ""
    jobTitle: str = ""
    company: str = ""


class FieldAnswer(BaseModel):
    """AI-generated answer for a single field."""
    id: str
    label: str
    answer: str
    confidence: str = "high"  # high, medium, low


class FillResponse(BaseModel):
    """Response from /api/fill."""
    answers: list[FieldAnswer]
    errors: list[str] = []


def _rule_based_answer(label: str, options: list[str], settings) -> str | None:
    """Fast rule-based answers for common screening questions."""
    q = label.lower().strip()

    yes_no = None
    opt_lower = [o.lower().strip() for o in options]
    if "yes" in opt_lower and "no" in opt_lower:
        yes_no = True

    if any(kw in q for kw in ["sponsorship", "sponsor", "require employment"]):
        return "No" if yes_no else "no"
    if any(kw in q for kw in ["legally authorized", "authorized to work", "eligible to work"]):
        return "Yes" if yes_no else "yes"
    if any(kw in q for kw in ["18 years", "18 or older"]):
        return "Yes" if yes_no else "yes"
    if "relocat" in q:
        return "Yes" if yes_no else "yes"
    if "driver" in q and "licen" in q:
        return "Yes" if yes_no else "yes"
    if "background check" in q or "drug test" in q:
        return "Yes" if yes_no else "yes"

    # Profile-based answers
    if settings:
        if any(kw in q for kw in ["first name", "given name"]):
            return settings.first_name or None
        if any(kw in q for kw in ["last name", "surname", "family name"]):
            return settings.last_name or None
        if "email" in q:
            return settings.email or None
        if "phone" in q:
            return settings.phone or None
        if "city" in q or "location" in q:
            return settings.city or None
        if "linkedin" in q:
            return settings.linkedin_url or None

    return None


@router.post("/fill", response_model=FillResponse)
async def fill_form(
    request: FillRequest,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """
    Generate AI answers for a batch of form fields.

    Tries rule-based answers first, falls back to Claude for complex questions.
    """
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()

    # Get resume text from DB if not provided — scoped to user
    resume_text = request.resumeText
    if not resume_text:
        resume = (
            db.query(ResumeProfileDB)
            .filter(ResumeProfileDB.user_id == user_id)
            .order_by(ResumeProfileDB.created_at.desc())
            .first()
        )
        if resume:
            resume_text = resume.raw_text or ""

    answers: list[FieldAnswer] = []
    ai_fields: list[FormField] = []

    # Pass 1: rule-based answers
    for field in request.fields:
        rule_answer = _rule_based_answer(field.label, field.options, settings)
        if rule_answer:
            answers.append(FieldAnswer(id=field.id, label=field.label, answer=rule_answer))
        else:
            ai_fields.append(field)

    # Pass 2: AI answers for remaining fields
    errors: list[str] = []
    if ai_fields:
        try:
            llm = get_llm_service()
            context_parts = []
            if settings:
                context_parts.append(
                    f"APPLICANT: {settings.first_name or ''} {settings.last_name or ''}, "
                    f"Email: {settings.email or ''}, Phone: {settings.phone or ''}, "
                    f"City: {settings.city or ''}, Country: Canada"
                )
            if resume_text:
                context_parts.append(f"RESUME:\n{resume_text[:3000]}")
            if request.jobDescription:
                context_parts.append(f"JOB ({request.jobTitle} at {request.company}):\n{request.jobDescription[:2000]}")

            context = "\n\n".join(context_parts)

            for field in ai_fields:
                try:
                    q = field.label
                    if field.options:
                        q += f"\nOptions: {', '.join(field.options)}"
                    raw = await llm.answer_question(question=q, context=context)
                    answer = raw.strip().strip('"')

                    # Match to options if applicable
                    if field.options:
                        matched = _match_option(answer, field.options)
                        answer = matched or field.options[0]

                    answers.append(FieldAnswer(
                        id=field.id, label=field.label, answer=answer,
                        confidence="medium",
                    ))
                except Exception as e:
                    logger.warning("AI failed for field '%s': %s", field.label, e)
                    errors.append(f"Failed: {field.label}")
        except Exception as e:
            logger.error("AI connection failed: %s", e)
            errors.append(f"AI unavailable: {e}")

    return FillResponse(answers=answers, errors=errors)


def _match_option(answer: str, options: list[str]) -> str | None:
    """Match AI answer text to one of the available options."""
    a = answer.lower().strip()
    for opt in options:
        if opt.lower().strip() == a:
            return opt
    for opt in options:
        if opt.lower().strip() in a or a in opt.lower():
            return opt
    return None
