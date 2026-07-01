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
from backend.db.models import UserSettings, ResumeProfileDB, SavedAnswer
from backend.auth.dependencies import get_verified_user_id
from backend.services.usage_limiter import llm_guard
from backend.services.llm import get_llm_service
from backend.services.embeddings import EmbeddingsService
from backend.services.answer_memory import (
    canonicalize_question,
    categorize_question,
    best_match,
    MATCH_THRESHOLD,
)

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
    """An answer for a single field, tagged with how it was produced."""
    id: str
    label: str
    answer: str
    confidence: str = "high"  # high, medium, low
    source: str = "rule"  # rule | profile | memory | ai
    needsReview: bool = False  # AI suggestions + company-specific matches
    category: str = "general"
    canonicalQuestion: str = ""


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
    user_id: int = Depends(llm_guard),
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
    remaining: list[FormField] = []
    errors: list[str] = []

    # Pass 1: rule-based / profile answers — filled silently.
    for field in request.fields:
        rule_answer = _rule_based_answer(field.label, field.options, settings)
        if rule_answer:
            answers.append(FieldAnswer(
                id=field.id, label=field.label, answer=rule_answer, source="rule"
            ))
        else:
            remaining.append(field)

    # Pass 2: Question Memory — reuse previously approved answers by meaning.
    # Generic matches fill silently; company-specific matches are flagged for
    # review so one company's answer isn't pasted blind into another's form.
    ai_fields: list[tuple[FormField, str]] = []
    if remaining:
        canonicals = [
            canonicalize_question(f.label, request.company, request.jobTitle)
            for f in remaining
        ]
        saved_rows = db.query(SavedAnswer).filter(SavedAnswer.user_id == user_id).all()
        vectors = None
        if saved_rows:
            try:
                vectors = await EmbeddingsService().embed_batch(canonicals)
            except Exception as e:  # missing key, network — degrade to AI
                logger.warning("Memory search unavailable: %s", e)
                vectors = None

        reused = False
        for idx, field in enumerate(remaining):
            canonical = canonicals[idx]
            matched = None
            if vectors is not None:
                cand, score = best_match(vectors[idx], saved_rows)
                if cand is not None and score >= MATCH_THRESHOLD:
                    matched = cand
            if matched is not None:
                needs_review = matched.category == "company_specific"
                if not needs_review:
                    matched.times_reused = (matched.times_reused or 0) + 1
                    reused = True
                answers.append(FieldAnswer(
                    id=field.id, label=field.label, answer=matched.answer,
                    confidence="high", source="memory", needsReview=needs_review,
                    category=matched.category, canonicalQuestion=canonical,
                ))
            else:
                ai_fields.append((field, canonical))
        if reused:
            db.commit()

    # Pass 3: AI generation for anything still unanswered. Suggestions are
    # returned for review (needsReview) and never auto-saved — POST /api/answers
    # is the only write path, used after the user accepts/edits.
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

            for field, canonical in ai_fields:
                try:
                    q = field.label
                    if field.options:
                        q += f"\nOptions: {', '.join(field.options)}"
                    raw = await llm.answer_question(question=q, context=context)
                    answer = raw.strip().strip('"')

                    # Match to options if applicable. Keep the AI's raw answer
                    # when nothing matches — the client fuzzy-matches (writeSelect
                    # / fillAriaCombobox); snapping to options[0] used to silently
                    # select a "Select…" placeholder.
                    if field.options:
                        matched_opt = _match_option(answer, field.options)
                        if matched_opt:
                            answer = matched_opt

                    answers.append(FieldAnswer(
                        id=field.id, label=field.label, answer=answer,
                        confidence="medium", source="ai", needsReview=True,
                        category=categorize_question(field.label),
                        canonicalQuestion=canonical,
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
