"""
POST /api/fill — AI form-filling endpoint.

Takes form fields + resume context, returns AI-generated answers.
Used by both the Plasmo extension and the React frontend.
"""

import logging
import re
from datetime import datetime, timezone
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

NO_ANSWER = "__NO_ANSWER__"


class FormField(BaseModel):
    """A single form field to fill."""
    id: str = ""
    label: str
    type: str = "text"  # text, select, radio, checkbox, textarea
    options: list[str] = []
    required: bool = False
    helpText: str = ""   # surrounding help/section text harvested by the extension
    inputType: str = ""  # native input type hint ("date", "number", "email"…)


class ApplicantProfile(BaseModel):
    """Non-sensitive slice of the extension's autofill profile. No EEO."""
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    addressStreet: str = ""
    addressCity: str = ""
    addressState: str = ""
    postalCode: str = ""
    country: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    currentCompany: str = ""
    currentTitle: str = ""
    workAuthorization: str = ""
    requiresSponsorship: str = ""
    salaryExpectation: str = ""
    skills: list[str] = []
    experience: list[str] = []   # pre-flattened "Title at Company (dates)" lines
    education: list[str] = []     # pre-flattened "Degree, School (year)" lines


class FillRequest(BaseModel):
    """Request body for /api/fill."""
    fields: list[FormField]
    resumeText: str = ""
    jobDescription: str = ""
    jobTitle: str = ""
    company: str = ""
    profile: Optional[ApplicantProfile] = None


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


def _rule_based_answer(label: str, options: list[str], settings, profile=None, company: str = "") -> str | None:
    """Fast rule-based answers for common screening questions.

    Prefers the request-supplied ApplicantProfile (the extension's Autofill
    Information) over the stored UserSettings for personal fields, and answers
    "have you worked here?" from the applicant's actual experience.

    A keyword shortcut (e.g. "relocate" → "yes", "location" → city) is only
    valid when the answer can actually land in the field. For a field with a
    specific options list that is not a Yes/No control, the shortcut answer is
    almost never one of the options — Lever's "What office(s) would you be
    willing to relocate to? (Select all that apply)" would otherwise get an
    unmatchable "yes". So when options are specific, we return the shortcut only
    if it snaps to an option, and otherwise defer to the option-aware AI pass.
    """
    answer = _raw_rule_based_answer(label, options, settings, profile, company)
    if answer is None:
        return None
    opt_lower = [o.lower().strip() for o in options]
    is_yes_no = "yes" in opt_lower and "no" in opt_lower
    if options and not is_yes_no:
        # Specific-option field: the shortcut is trustworthy only if it matches
        # an option; otherwise defer so the AI picks from the real options.
        return _match_option(answer, options)
    return answer


def _raw_rule_based_answer(label: str, options: list[str], settings, profile=None, company: str = "") -> str | None:
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

    # "Have you worked here / are you a current or former employee?" — answer from
    # the applicant's real experience: Yes only when this company is in it.
    if any(kw in q for kw in [
        "worked here", "work for us before", "current or former employee",
        "currently employed by", "former employee", "previously worked",
        "current employee", "employed by us", "worked for us", "worked at this",
    ]):
        exp = (profile.experience or []) if profile else []
        worked = bool(company and any(company.lower() in e.lower() for e in exp))
        return ("Yes" if yes_no else "yes") if worked else ("No" if yes_no else "no")

    # Profile-based answers — request profile first, stored settings as fallback.
    first = (profile.firstName if profile else "") or (settings.first_name if settings else "")
    last = (profile.lastName if profile else "") or (settings.last_name if settings else "")
    email = (profile.email if profile else "") or (settings.email if settings else "")
    phone = (profile.phone if profile else "") or (settings.phone if settings else "")
    city = ((profile.addressCity or profile.location) if profile else "") or (settings.city if settings else "")
    linkedin = (profile.linkedin if profile else "") or (settings.linkedin_url if settings else "")
    if any(kw in q for kw in ["first name", "given name"]):
        return first or None
    if any(kw in q for kw in ["last name", "surname", "family name"]):
        return last or None
    if "email" in q:
        return email or None
    if "phone" in q:
        return phone or None
    if "city" in q or "location" in q:
        return city or None
    if "linkedin" in q:
        return linkedin or None

    return None


def _profile_context(p: ApplicantProfile) -> str:
    """Human-readable applicant context from the structured profile."""
    lines: list[str] = []
    name = f"{p.firstName} {p.lastName}".strip()
    if name:
        lines.append(f"Name: {name}")
    if p.email:
        lines.append(f"Email: {p.email}")
    if p.phone:
        lines.append(f"Phone: {p.phone}")
    loc = ", ".join(x for x in [p.addressCity or p.location, p.addressState, p.postalCode, p.country] if x)
    if loc:
        lines.append(f"Location: {loc}")
    if p.currentTitle or p.currentCompany:
        role = f"{p.currentTitle} at {p.currentCompany}".strip()
        lines.append(f"Current role: {role}")
    if p.workAuthorization:
        lines.append(f"Work authorization: {p.workAuthorization}")
    if p.requiresSponsorship:
        lines.append(f"Requires visa sponsorship: {p.requiresSponsorship}")
    if p.salaryExpectation:
        lines.append(f"Salary expectation: {p.salaryExpectation}")
    for link in (p.linkedin, p.github, p.portfolio):
        if link:
            lines.append(link)
    if p.skills:
        lines.append("Skills: " + ", ".join(p.skills[:30]))
    if p.experience:
        lines.append("Experience:\n" + "\n".join(f"- {e}" for e in p.experience[:8]))
    if p.education:
        lines.append("Education:\n" + "\n".join(f"- {e}" for e in p.education[:5]))
    return "\n".join(lines)


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
        rule_answer = _rule_based_answer(field.label, field.options, settings, request.profile, request.company)
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
            # Today's date lets the model compute durations ("Present" roles,
            # years-of-experience questions) instead of guessing them.
            context_parts = [f"TODAY'S DATE: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"]
            if request.profile is not None:
                context_parts.append("APPLICANT:\n" + _profile_context(request.profile))
            elif settings:
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
                    if field.inputType:
                        q += f"\nField type: {field.inputType}"
                    if field.helpText:
                        q += f"\nHelp text: {field.helpText}"
                    if field.options:
                        q += f"\nOptions: {', '.join(field.options)}"
                    raw = await llm.answer_question(question=q, context=context)
                    answer = raw.strip().strip('"').strip()

                    # Grounding sentinel: the model has no supported answer —
                    # leave the field blank (emit nothing). The client skips
                    # fields with no answer, so a skipped field stays empty.
                    if not answer or answer.upper() == NO_ANSWER:
                        continue

                    # Match to options if applicable. Keep the AI's raw answer
                    # when nothing matches — the client fuzzy-matches (writeSelect
                    # / fillAriaCombobox); snapping to options[0] used to silently
                    # select a "Select…" placeholder. A LONG unmatched answer is
                    # the exception: a conversational sentence can never land in
                    # a choice control, so leave the field for the user instead.
                    if field.options:
                        matched_opt = _match_option(answer, field.options)
                        if matched_opt:
                            answer = matched_opt
                        elif len(answer) > 80:
                            continue

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


def _first_number(text: str) -> Optional[float]:
    """The first number (comma thousands-separators tolerated) in text, or None."""
    m = re.search(r"\d+(?:\.\d+)?", text.replace(",", ""))
    return float(m.group()) if m else None


def _parse_range(text: str) -> Optional[tuple[float, float]]:
    """Parse a bucketed-range option ("2-3 years", "$90,000-$110,000", "6+
    years", "Under 1 year") into an inclusive (min, max) — Infinity for an
    open end — or None when the text isn't a recognizable numeric range."""
    cleaned = re.sub(r"[,$€£¥]", "", text)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)", cleaned, re.IGNORECASE)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r"(\d+(?:\.\d+)?)\s*\+", cleaned)
    if m:
        return float(m.group(1)), float("inf")
    m = re.search(r"(?:under|less than|<)\s*(\d+(?:\.\d+)?)", cleaned, re.IGNORECASE)
    if m:
        return float("-inf"), float(m.group(1))
    return None


def _match_option(answer: str, options: list[str]) -> str | None:
    """Match AI answer text to one of the available options."""
    a = answer.lower().strip()
    for opt in options:
        if opt.lower().strip() == a:
            return opt
    a_words = [w for w in re.split(r"[^a-z0-9]+", a) if w]
    for opt in options:
        o = opt.lower().strip()
        if len(a_words) <= 1:
            # Single-word answers must match a whole word of the option —
            # "cat" must never fuzzy-match "category" (mirrors the extension's
            # matchOption in writeEngine.ts).
            if a_words and a_words[0] in re.split(r"[^a-z0-9]+", o):
                return opt
        elif o in a or a in o:
            return opt
    # Bucketed numeric options ("2-3 years", "$90,000-$110,000") share no
    # literal substring with a conversational answer ("about 3 years") even
    # though the AI is told to answer with exact option text — check whether
    # the answer's number actually falls inside an option's range.
    target_num = _first_number(answer)
    if target_num is not None:
        for opt in options:
            rng = _parse_range(opt)
            if rng and rng[0] <= target_num <= rng[1]:
                return opt
    # A bucketed-range option set the range tier couldn't place the answer in
    # must fail here: the buckets normalize to the same tokens ("years", "000"),
    # so token overlap would just pick the first bucket — confidently wrong.
    if sum(1 for opt in options if _parse_range(opt) is not None) >= 2:
        return None
    # Morphological near-miss: a >=5-char shared token prefix ("canada" ↔
    # "canadian"). Mirrors the extension's matchOption tier (writeEngine.ts).
    answer_tokens = [w for w in re.split(r"[^a-z0-9]+", a) if len(w) > 2]
    best: tuple[str, float] | None = None
    for opt in options:
        tokens = [w for w in re.split(r"[^a-z0-9]+", opt.lower()) if len(w) > 2]
        if not tokens:
            continue
        overlap = sum(
            1 for w in tokens
            if any(_shared_prefix_len(w, t) >= 5 or w == t for t in answer_tokens)
        )
        # Below half the option's tokens is incidental overlap, not a match —
        # selecting on it is how wrong options get picked (writeEngine parity).
        score = overlap / len(tokens)
        if overlap and score >= 0.5:
            if best is None or score > best[1]:
                best = (opt, score)
    if best:
        return best[0]
    return None


def _shared_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i
