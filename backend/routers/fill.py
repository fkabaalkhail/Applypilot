"""
POST /api/fill — AI form-filling endpoint.

Takes form fields + resume context, returns AI-generated answers.
Used by both the Plasmo extension and the React frontend.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import UserSettings, ResumeProfileDB
from backend.auth.dependencies import get_verified_user_id
from backend.services.usage_limiter import llm_guard
from backend.services.llm import get_llm_service
from backend.services.answer_gate import GateResult, validate_answer
from backend.services.derived_facts import resolve_derived_fact
from backend.services.option_match import (
    first_number as _first_number,
    match_option as _match_option,
    parse_range as _parse_range,
    shared_prefix_len as _shared_prefix_len,
)

logger = logging.getLogger(__name__)
router = APIRouter()

NO_ANSWER = "__NO_ANSWER__"

__all__ = ["router", "_first_number", "_match_option", "_parse_range", "_shared_prefix_len"]


class FormField(BaseModel):
    """A single form field to fill."""
    id: str = ""
    label: str
    type: str = "text"  # text, select, radio, checkbox, textarea
    options: list[str] = []
    required: bool = False
    helpText: str = ""   # surrounding help/section text harvested by the extension
    inputType: str = ""  # native input type hint ("date", "number", "email"…)


class WorkPeriod(BaseModel):
    """Structured dates for one role — what the derived-fact resolvers measure a
    career from. The flattened ``experience`` lines stay as they are: they are
    prose for the LLM's context, and parsing prose is not arithmetic."""
    startDate: str = ""
    endDate: str = ""


class EducationRecord(BaseModel):
    """Structured education, for graduation-year and degree-level questions."""
    degree: str = ""
    school: str = ""
    graduationYear: str = ""


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
    # Screening answers the applicant stated once on their profile (2026-08-09
    # profile-parity contract). Every one is a FACT the user supplied, not an
    # assumption, which is what makes it safe to answer from without an LLM.
    # Blank means "not answered" — every rule below abstains on a blank.
    willingToRelocate: str = ""
    workPreference: str = ""
    noticePeriod: str = ""
    earliestStartDate: str = ""
    yearsOfExperience: str = ""
    securityClearance: str = ""
    driversLicense: str = ""
    languages: str = ""
    skills: list[str] = []
    experience: list[str] = []   # pre-flattened "Title at Company (dates)" lines
    education: list[str] = []     # pre-flattened "Degree, School (year)" lines
    # Facts the profile can COMPUTE an answer from, kept structured so no
    # resolver has to parse the display strings above. All optional: a client
    # that sends none of them makes every derived resolver abstain, which is
    # the correct behaviour, not a degraded one.
    dateOfBirth: str = ""              # ISO "YYYY-MM-DD" (or "YYYY-MM" / "YYYY")
    workHistory: list[WorkPeriod] = []
    educationHistory: list[EducationRecord] = []


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
    source: str = "rule"  # rule | profile | ai
    needsReview: bool = False  # AI suggestions
    # Which pass produced this, for telemetry: "derived" | "rule" | "ai".
    # `source` is the older, coarser field the client already reads; keeping
    # both means nothing that consumes `source` has to change.
    fillPass: str = "rule"


class DroppedAnswer(BaseModel):
    """A value the gate refused. Carries no answer text — only why."""
    id: str
    label: str
    reason: str
    source: str


class FillResponse(BaseModel):
    """Response from /api/fill."""
    answers: list[FieldAnswer]
    errors: list[str] = []
    # Fields whose candidate answer was dropped by the gate. The client leaves
    # them blank and the post-fill re-scan offers them in the gap modal.
    dropped: list[DroppedAnswer] = []


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

    # Screening answers the applicant stated on their profile. These sit ABOVE
    # the generic name/city block on purpose: "preferred work location" and
    # "earliest start date" both carry that block's keywords, and the city
    # answer would win the race and then be filtered out as unmatchable.
    #
    # Each fires only when the profile actually holds the answer — a blank falls
    # through to the AI pass rather than being invented. That is the same line
    # test_assumption_rules_are_dropped draws: "are you willing to relocate?" is
    # a hardcoded guess when nobody said so, and a stated fact when they did.
    if profile is not None:
        if profile.willingToRelocate and any(kw in q for kw in [
            "relocat", "willing to move", "open to moving",
        ]):
            return profile.willingToRelocate
        if profile.workPreference and any(kw in q for kw in [
            "work preference", "work arrangement", "work setting", "work model",
            "work style", "work location preference", "preferred work location",
            "remote or", "remote/", "hybrid", "on-site", "onsite", "in-office",
            "remote work", "work remotely",
        ]):
            return profile.workPreference
        if profile.noticePeriod and any(kw in q for kw in [
            "notice period", "notice do you", "notice are you", "much notice",
            "required notice",
        ]):
            return profile.noticePeriod
        if profile.earliestStartDate and any(kw in q for kw in [
            "start date", "when can you start", "when could you start",
            "earliest you can", "available to start", "availability to start",
            "date available", "when are you available",
        ]):
            return profile.earliestStartDate
        # "years of experience WITH Kubernetes" is a question about one skill,
        # not a career total — the same narrowing guard derived_facts applies.
        if (
            profile.yearsOfExperience
            and any(kw in q for kw in ["years of experience", "years experience", "yrs of experience"])
            and not any(kw in q for kw in [
                "experience with", "experience in", "experience using",
                "experience as", "experience on",
            ])
        ):
            return profile.yearsOfExperience
        if profile.securityClearance and "clearance" in q:
            return profile.securityClearance
        if profile.driversLicense and "licen" in q and ("driver" in q or "driving" in q):
            return profile.driversLicense
        # A programming-language question is not a spoken-language question, and
        # answering it "English (Native)" is exactly the kind of confident
        # nonsense the grounding contract exists to stop.
        if (
            profile.languages
            and any(kw in q for kw in ["language", "fluent in", "do you speak"])
            and not any(kw in q for kw in [
                "programming", "coding", "code", "software", "technolog",
                "framework", "scripting",
            ])
        ):
            return profile.languages

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
    # Stated screening answers. Labelled with the same wording the profile
    # stores them under (the contract's prefilled_answers keys), so the prompt,
    # the storage and both UIs all name the same fact the same way. A blank is
    # omitted entirely — the model is never shown "unknown" as if it were data.
    for label, value in (
        ("Willing to relocate", p.willingToRelocate),
        ("Work preference", p.workPreference),
        ("Notice period", p.noticePeriod),
        ("Earliest start date", p.earliestStartDate),
        ("Years of experience", p.yearsOfExperience),
        ("Security clearance", p.securityClearance),
        ("Driver's licence", p.driversLicense),
        ("Languages", p.languages),
    ):
        if value:
            lines.append(f"{label}: {value}")
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


# Open-ended long-answer cues. A textarea carrying one of these (or a genuine
# ?-question) is COMPOSED from real experience + the job posting rather than
# extracted; every other field keeps the strict answer_question.txt grounding.
_ESSAY_CUES = (
    "why", "motivat", "interest", "excit", "passion",
    "tell us about yourself", "about yourself", "describe a",
    "a time when", "a time you", "challenge", "proud", "accomplish",
    "strength", "weakness", "goal", "see yourself", "what do you know",
    "in your own words", "what makes you", "why should we", "drawn to",
    "fit for this", "cover letter",
)


def is_essay_question(field: FormField) -> bool:
    """True when a field is an open-ended essay prompt worth AI-composing.

    Only long free-text controls are ever candidates — choice/short controls
    (select, radio, checkbox, number) keep the strict grounding path, so a
    factual screening question can never be routed into generative mode.
    """
    if field.type != "textarea" or field.options:
        return False
    text = f"{field.label} {field.helpText}".lower()
    if any(cue in text for cue in _ESSAY_CUES):
        return True
    label = field.label.strip()
    return label.endswith("?") and len(label.split()) >= 4


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
    dropped: list[DroppedAnswer] = []
    today = datetime.now(timezone.utc).date()

    def gated(field: FormField, value: str, source: str) -> Optional[GateResult]:
        """Run one candidate answer through the gate, recording a drop.

        Every pass calls this — that is the whole point of the gate. Returns
        None when the value was refused, in which case the field is left for
        the next pass (or, after pass 3, left blank for the gap modal).
        """
        verdict = validate_answer(
            value,
            label=field.label,
            options=field.options,
            profile=request.profile,
            today=today,
            company=request.company,
            help_text=field.helpText,
        )
        if verdict.value is None:
            dropped.append(DroppedAnswer(
                id=field.id, label=field.label, reason=verdict.reason, source=source
            ))
            logger.info(
                "fill: dropped %s answer for %r — %s",
                source, field.label[:80], verdict.reason,
            )
            return None
        return verdict

    # Pass 1: facts computed from the profile, then rule-based / profile
    # shortcuts. Both fill silently, and both are gated.
    #
    # The derived resolvers run FIRST and short-circuit: a question whose answer
    # the profile already contains ("are you 18 or older?") is settled here, so
    # it is never handed to the LLM to be guessed at.
    for field in request.fields:
        derived = resolve_derived_fact(
            label=field.label,
            options=field.options,
            profile=request.profile,
            today=today,
            company=request.company,
            help_text=field.helpText,
        )
        if derived is not None:
            verdict = gated(field, derived.value, "derived")
            if verdict is not None:
                answers.append(FieldAnswer(
                    id=field.id, label=field.label, answer=verdict.value,
                    source="profile", fillPass="derived",
                ))
                continue

        rule_answer = _rule_based_answer(field.label, field.options, settings, request.profile, request.company)
        if rule_answer:
            verdict = gated(field, rule_answer, "rule")
            if verdict is not None:
                answers.append(FieldAnswer(
                    id=field.id, label=field.label, answer=verdict.value,
                    source="rule", fillPass="rule",
                ))
                continue
        remaining.append(field)

    # Pass 2: AI generation for everything pass 1 left unanswered. Suggestions
    # are returned for review (needsReview) and are never persisted — each fill
    # re-derives its answers, so nothing carries over between applications.
    if remaining:
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

            for field in remaining:
                try:
                    q = field.label
                    if field.inputType:
                        q += f"\nField type: {field.inputType}"
                    if field.helpText:
                        q += f"\nHelp text: {field.helpText}"
                    if field.options:
                        q += f"\nOptions: {', '.join(field.options)}"
                    if is_essay_question(field):
                        raw = await llm.compose_answer(question=q, context=context)
                    else:
                        raw = await llm.answer_question(question=q, context=context)

                    # The gate owns every outcome here, including the grounding
                    # sentinel (__NO_ANSWER__ → dropped as "no_answer") and the
                    # option check. An essay is exempt from the option check
                    # only in the sense that a textarea has no options.
                    verdict = gated(field, raw, "ai")
                    if verdict is None:
                        continue

                    answers.append(FieldAnswer(
                        id=field.id, label=field.label, answer=verdict.value,
                        confidence="medium", source="ai", needsReview=True,
                        fillPass="ai",
                    ))
                except Exception as e:
                    logger.warning("AI failed for field '%s': %s", field.label, e)
                    errors.append(f"Failed: {field.label}")
        except Exception as e:
            logger.error("AI connection failed: %s", e)
            errors.append(f"AI unavailable: {e}")

    return FillResponse(answers=answers, errors=errors, dropped=dropped)
