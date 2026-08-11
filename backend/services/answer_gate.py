"""
One gate every answer passes before it is returned to the client.

The grounding contract used to live entirely in ``prompts/answer_question.txt``.
A prompt can only constrain the model that reads it, so only the AI pass was
ever checked: a rule-based shortcut reached the page without anything looking
at it. That is not a contract that failed. It is a contract that was never
invoked on the non-model paths.

Production evidence, 2026-08:

  pass 1  "…employed by uOttawa in any capaCITY?"  → "Ottawa, ON"
          (the `"city" in question` shortcut, matching inside "capacity")

So the gate is applied by SOURCE-BLIND design: it takes an answer and the
question, and does not care which pass produced it.

Three checks, in order:

  1. the profile contradicts it   → drop. The deterministic resolvers that can
                                    COMPUTE an answer are re-used here to
                                    refute one, so the arithmetic lives in one
                                    place; identity and sponsorship facts the
                                    profile states outright are checked too.
  2. a constrained widget         → the value must be an option the widget
                                    actually offers, word for word.
  3. anything left                → kept, normalized to the option's own text.

A dropped value leaves the field blank. The client skips a field with no
answer, and the post-fill re-scan then offers it in the gap modal, the same
route ``__NO_ANSWER__`` has always taken.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from backend.services.derived_facts import resolve_derived_fact
from backend.services.option_match import match_option, option_polarity

NO_ANSWER = "__NO_ANSWER__"


@dataclass(frozen=True)
class GateResult:
    """`value` is None when the answer was dropped; `reason` says why.

    `reason` is a short stable slug, never the answer text. It is logged, and
    the privacy posture is that answers are never logged anywhere.
    """
    value: Optional[str]
    reason: str = ""


# ── Identity fields the profile owns outright ────────────────────────────────

# Qualifiers that make a name/email/phone question about SOMEONE ELSE. When one
# is present the identity check is skipped entirely: an emergency contact's
# phone number differing from the applicant's is correct, not a contradiction.
_OTHER_PERSON_RE = re.compile(
    r"\b(emergency|contact\s+person|next\s+of\s+kin|reference|referee|referral|referred|"
    r"supervisor|manager|employer|parent|guardian|spouse|partner|beneficiary|"
    r"maiden|previous|former|preferred|nickname|other)\b",
    re.IGNORECASE,
)

_IDENTITY_CHECKS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(first\s+name|given\s+name|forename)\b", re.I), "firstName", "name"),
    (re.compile(r"\b(last\s+name|surname|family\s+name)\b", re.I), "lastName", "name"),
    (re.compile(r"\be-?mail\b", re.I), "email", "email"),
    (re.compile(r"\bphone|mobile\s+number|telephone\b", re.I), "phone", "phone"),
]


def _norm_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _digits(text: str) -> str:
    return re.sub(r"\D+", "", text or "")


def _identity_conflict(label: str, answer: str, profile: Any) -> str:
    """A slug when the answer contradicts a profile identity value, else ""."""
    if profile is None or _OTHER_PERSON_RE.search(label):
        return ""
    for pattern, attr, kind in _IDENTITY_CHECKS:
        if not pattern.search(label):
            continue
        stored = str(getattr(profile, attr, "") or "").strip()
        if not stored:
            return ""  # the profile does not speak to it
        if kind == "phone":
            a, b = _digits(answer), _digits(stored)
            # Compare the last 10 digits so a country code on one side alone
            # is not read as a different number.
            if a and b and a[-10:] != b[-10:]:
                return f"contradicts_profile:{attr}"
            return ""
        if _norm_text(answer) != _norm_text(stored):
            return f"contradicts_profile:{attr}"
        return ""
    return ""


# ── Sponsorship / work authorization ─────────────────────────────────────────

_SPONSORSHIP_RE = re.compile(
    r"\b(?:require|need|request)\w*\s+(?:visa\s+|immigration\s+|employment\s+)?sponsorship\b|"
    r"\bsponsorship\s+(?:required|needed)\b",
    re.IGNORECASE,
)
_AUTHORIZED_RE = re.compile(
    r"\b(?:legally\s+)?(?:authorized|authorised|eligible|entitled)\s+to\s+work\b",
    re.IGNORECASE,
)
# A negated form flips the expected polarity, and working that out from prose is
# guesswork, skip the check rather than risk dropping a correct answer.
_NEGATED_RE = re.compile(r"\bwithout\b|\bnot\s+require\b|\bdo\s+not\b|\bn['’]t\b", re.IGNORECASE)


def _stated_polarity(value: str) -> Optional[bool]:
    """Read a stored free-form screening answer as yes/no, or None."""
    text = (value or "").strip()
    if not text:
        return None
    return option_polarity(text)


def _screening_topic(label: str, help_text: str) -> Optional[str]:
    """Which screening question this field IS: "sponsorship", "authorized", or None.

    The label decides. `help_text` is harvested from surrounding DOM, so on a
    real form it routinely carries the *neighbouring* question's wording — an
    "authorized to work?" field sitting next to a sponsorship question comes
    through with sponsorship text attached. Letting that pick the rule made the
    gate compare an authorization answer against `requiresSponsorship` and drop
    a correct "Yes", blanking the field on a live application (prod 2026-08-11).

    So help text is consulted only when the label names neither topic — which is
    what makes it useful for a bare "Sponsorship?" label — and never overrides a
    label that already says which question this is.
    """
    for text in (label, help_text):
        if not text:
            continue
        sponsorship = bool(_SPONSORSHIP_RE.search(text))
        authorized = bool(_AUTHORIZED_RE.search(text))
        # Both matching in one string means that string is describing two
        # questions at once; it cannot identify this field, so keep looking.
        if sponsorship and not authorized:
            return "sponsorship"
        if authorized and not sponsorship:
            return "authorized"
    return None


def _screening_conflict(label: str, answer: str, profile: Any, help_text: str = "") -> str:
    if profile is None or _NEGATED_RE.search(f"{label} {help_text}"):
        return ""
    answered = option_polarity(answer)
    if answered is None:
        return ""
    topic = _screening_topic(label, help_text)
    if topic == "sponsorship":
        stated = _stated_polarity(str(getattr(profile, "requiresSponsorship", "") or ""))
        if stated is not None and stated != answered:
            return "contradicts_profile:requiresSponsorship"
    elif topic == "authorized":
        stated = _stated_polarity(str(getattr(profile, "workAuthorization", "") or ""))
        if stated is not None and stated != answered:
            return "contradicts_profile:workAuthorization"
    return ""


# ── Agreement between a computed fact and a proposed answer ──────────────────

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _agrees(computed: str, answer: str, options: list[str]) -> bool:
    """Does `answer` say the same thing as the computed fact?

    Lenient on purpose: this decides whether to DROP a value, so anything that
    could plausibly be the same answer is treated as agreement. Only a clear
    disagreement, a different option, the opposite polarity, a different
    number, refutes.
    """
    if options:
        mapped = match_option(answer, options)
        if mapped is None:
            return True  # the option check below owns this failure
        return mapped == computed or _norm_text(mapped) == _norm_text(computed)
    if _norm_text(answer) == _norm_text(computed):
        return True
    p_computed, p_answer = option_polarity(computed), option_polarity(answer)
    if p_computed is not None and p_answer is not None:
        return p_computed == p_answer
    n_computed = _NUMBER_RE.search(computed)
    n_answer = _NUMBER_RE.search(answer)
    if n_computed and n_answer:
        return float(n_computed.group()) == float(n_answer.group())
    # Nothing comparable: do not claim a contradiction we cannot demonstrate.
    return True


# ── The gate ─────────────────────────────────────────────────────────────────

def validate_answer(
    answer: str,
    *,
    label: str,
    options: list[str],
    profile: Any,
    today: date,
    company: str = "",
    help_text: str = "",
    enforce_options: bool = True,
) -> GateResult:
    """Check one answer, whichever pass produced it.

    `enforce_options` exists for controls whose real choices are mounted lazily
    and were not harvested: `options` is then empty and there is nothing to
    enforce, which the empty-list check already handles, the flag is for a
    caller that knows the list it holds is only a partial view.
    """
    value = (answer or "").strip().strip('"').strip()
    if not value or value.upper() == NO_ANSWER:
        return GateResult(None, "no_answer")

    question = f"{label or ''} {help_text or ''}".strip()

    computed = resolve_derived_fact(
        label=label, options=options, profile=profile, today=today,
        company=company, help_text=help_text,
    )
    if computed is not None and not _agrees(computed.value, value, options):
        return GateResult(None, f"contradicts_profile:{computed.rule}")

    # Identity checks (name/email/phone) still read the combined text — a stray
    # neighbouring sentence cannot make an email look like someone else's. The
    # screening check gets label and help text separately, because for it the
    # two are not interchangeable: see _screening_topic.
    conflict = (
        _identity_conflict(question, value, profile)
        or _screening_conflict(label or "", value, profile, help_text or "")
    )
    if conflict:
        return GateResult(None, conflict)

    if options and enforce_options:
        matched = match_option(value, options)
        if matched is None:
            return GateResult(None, "not_an_offered_option")
        return GateResult(matched)

    return GateResult(value)
