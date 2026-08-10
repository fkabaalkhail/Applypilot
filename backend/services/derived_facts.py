"""
Facts that are COMPUTED from the profile, not guessed.

Asking a language model is the right instrument for a preference ("are you
willing to relocate?") and the wrong one for arithmetic: "are you 18 or older?"
has an answer the profile already contains, and anything that infers it instead
of computing it can get it wrong.

Production, 2026-08-09: a Workday yes/no radio group whose label harvested as
the widget boilerplate "Yes Required" was indistinguishable from EVERY other
such group on the page, so the 18+ question was answered from whatever that
boilerplate label had attracted. Nothing on that path consulted the profile, so
nothing could notice.

These resolvers run in pass 1 and SHORT-CIRCUIT: a question they can answer is
settled before any later pass sees it. Each one returns a value or abstains,
abstaining is always allowed and never a guess. The same resolvers are re-used
by ``answer_gate`` to REFUTE an answer another pass produced, so the arithmetic
is stated once and enforced everywhere.

Pure: no DB, no network, no clock of its own (``today`` is injected).
"""

from __future__ import annotations

import re
from calendar import monthrange
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from backend.services.option_match import match_boolean_option, match_option

# A birth year that would make the applicant older than this is a typo, not a
# fact, better to abstain than to answer an age gate from a bad row.
MAX_REASONABLE_AGE = 110

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

_PRESENT = re.compile(r"\b(present|current|now|ongoing|to\s*date)\b", re.IGNORECASE)


# ── Dates ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DateSpan:
    """The window a partially-known date could fall in.

    A profile may hold "1998-04-23", "1998-04" or just "1998". Rather than
    inventing the missing precision, every parse widens into the span it
    actually pins down, and callers answer only when both ends agree. That is
    what lets "are you 18?" be answered honestly from a birth YEAR when the
    whole year is decisive, and abstain when it is not.
    """
    earliest: date
    latest: date

    @property
    def exact(self) -> bool:
        return self.earliest == self.latest


def parse_date_span(text: str) -> Optional[DateSpan]:
    """Parse a profile date into the span it pins down, or None.

    Accepted, because these are what the profile and résumé parser produce:
    ``YYYY-MM-DD`` / ``YYYY/MM/DD``, ``YYYY-MM``, ``YYYY``, ``Mon YYYY`` and
    ``Month YYYY``, and ``MM/YYYY``.

    Deliberately NOT accepted: ``03/04/1998``. There is no way to know whether
    that is March or April, and an age gate answered from a coin flip is worse
    than one left blank.
    """
    t = (text or "").strip()
    if not t:
        return None

    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", t)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= d <= monthrange(y, mo)[1]:
            return DateSpan(date(y, mo, d), date(y, mo, d))
        return None

    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})", t)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12:
            return _month_span(y, mo)
        return None

    m = re.fullmatch(r"(\d{1,2})[-/.](\d{4})", t)
    if m:
        mo, y = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12:
            return _month_span(y, mo)
        return None

    m = re.fullmatch(r"([A-Za-z]{3,9})\.?,?\s+(\d{4})", t)
    if m:
        mo = _MONTHS.get(m.group(1)[:3].lower())
        if mo:
            return _month_span(int(m.group(2)), mo)
        return None

    m = re.fullmatch(r"(\d{4})", t)
    if m:
        y = int(m.group(1))
        return DateSpan(date(y, 1, 1), date(y, 12, 31))

    return None


def _month_span(year: int, month: int) -> DateSpan:
    return DateSpan(date(year, month, 1), date(year, month, monthrange(year, month)[1]))


def age_on(born: date, today: date) -> int:
    """Completed years between two dates, the ordinary meaning of "age"."""
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def age_bounds(dob: str, today: date) -> Optional[tuple[int, int]]:
    """(youngest, oldest) the applicant could be, or None when unknowable.

    An exact DOB collapses this to a single number. A birth year gives a
    two-number window, which is still decisive for most gates.
    """
    span = parse_date_span(dob)
    if span is None:
        return None
    youngest = age_on(span.latest, today)
    oldest = age_on(span.earliest, today)
    if oldest < 0 or oldest > MAX_REASONABLE_AGE:
        return None
    return youngest, oldest


# ── Question shapes ──────────────────────────────────────────────────────────

# "at least 18", "minimum age of 21", "older than 18", "over the age of 18"
_AGE_MIN_RE = re.compile(
    r"\b(?:at\s+least|minimum(?:\s+age)?(?:\s+of)?|older\s+than|over(?:\s+the\s+age\s+of)?|above)\s+(\d{1,2})\b",
    re.IGNORECASE,
)
# "18+", "18 years of age", "18 years old", "18 or older", "18 and over".
# The trailing \b sits inside the word alternatives only: "18+?" has no
# boundary between "+" and "?", so a \b after the whole group rejects it.
_AGE_SUFFIX_RE = re.compile(
    r"\b(\d{1,2})\s*(?:\+|(?:years?\s+of\s+age|years?\s+old|or\s+older|or\s+above|or\s+over|and\s+older|and\s+over)\b)",
    re.IGNORECASE,
)
# "under 18", "younger than 18", "below 18", the same gate, asked backwards.
_AGE_UNDER_RE = re.compile(
    r"\b(?:under|younger\s+than|below|less\s+than)\s+(?:the\s+age\s+of\s+)?(\d{1,2})\b",
    re.IGNORECASE,
)
# Something must make the question a yes/no gate rather than a mention of age.
_GATE_SHAPE_RE = re.compile(
    r"\bare\s+you\b|\byou\s+are\b|\bdo\s+you\b|\bis\s+the\s+applicant\b|"
    r"\bconfirm\b|\bcertify\b|\bverify\b|\battest\b|\?",
    re.IGNORECASE,
)

_TOTAL_EXP_RE = re.compile(
    r"\b(?:total\s+|overall\s+|combined\s+)?years?\s+of\s+"
    r"(?:full[-\s]?time\s+|professional\s+|work(?:ing)?\s+|relevant\s+|industry\s+|paid\s+)?"
    r"experience\b",
    re.IGNORECASE,
)
# "years of experience with Kubernetes" is not a question about a career total.
_NARROWED_EXP_RE = re.compile(r"\bexperience\s+(?:with|in|using|on|of|as)\b", re.IGNORECASE)

_GRAD_YEAR_RE = re.compile(
    r"\b(?:graduation\s+year|year\s+of\s+graduation|(?:expected\s+)?graduation\s+date|"
    r"expected\s+graduation|when\s+(?:did|do|will)\s+you\s+graduate|year\s+graduated)\b",
    re.IGNORECASE,
)
_HIGHEST_DEGREE_RE = re.compile(
    r"\bhighest\s+(?:completed\s+)?(?:level\s+of\s+)?(?:education|degree|qualification)\b|"
    r"\b(?:level|type)\s+of\s+(?:education|degree)\b|\beducation\s+level\b|\bdegree\s+level\b",
    re.IGNORECASE,
)
# "Do you CURRENTLY work at Acme?", present tense only. The broader
# "have you ever worked here" question is answered from full history by the
# keyword rule in fill.py; this one must not borrow that answer.
_CURRENT_EMPLOYER_RE = re.compile(
    r"\b(?:currently\s+(?:work|employed|working)|are\s+you\s+(?:a\s+)?current(?:ly)?\s+"
    r"(?:an?\s+)?employee|presently\s+employed|do\s+you\s+work\s+(?:here|for\s+us|at\s+this))\b",
    re.IGNORECASE,
)

# Degree tiers, most senior first. The value is the tier rank; the key is the
# canonical wording used when the widget offers no options of its own.
#
# Matched on WORD BOUNDARIES, not as substrings. Two-letter abbreviations are
# what force that: "MA" as a substring is inside "diploma", so "High School
# Diploma" ranked as a master's degree and an applicant's education level was
# reported two tiers too high.
_DEGREE_TIERS: list[tuple[int, str, str]] = [
    (6, "Doctorate", r"doctorate|doctoral|ph\.?d|d\.?phil|\bmd\b|\bj\.?d\b"),
    (5, "Master's Degree", r"master'?s?\b|\bm\.?sc\b|\bm\.?s\.|\bmba\b|\bm\.?eng\b|\bm\.?a\.?\b"),
    (4, "Bachelor's Degree", r"bachelor'?s?\b|\bb\.?sc\b|\bb\.?s\.|\bb\.?a\.?\b|\bb\.?eng\b|undergraduate"),
    (3, "Associate Degree", r"associate'?s?\b|\ba\.?a\.?\b|\ba\.?s\.\b"),
    (2, "Diploma", r"diploma|certificate|college\s+diploma"),
    (1, "High School", r"high\s+school|secondary\s+school|\bged\b"),
]

_DEGREE_RES = [(rank, label, re.compile(pattern, re.IGNORECASE)) for rank, label, pattern in _DEGREE_TIERS]


def degree_tier(text: str) -> Optional[int]:
    """Rank a degree string, or None when it names no recognizable level."""
    t = text or ""
    for rank, _label, pattern in _DEGREE_RES:
        if pattern.search(t):
            return rank
    return None


def _tier_label(rank: int) -> str:
    for r, label, _ in _DEGREE_RES:
        if r == rank:
            return label
    return ""


# ── Profile accessors (duck-typed, so this module imports no router) ─────────

def _attr(profile: Any, name: str, default: Any = "") -> Any:
    value = getattr(profile, name, default) if profile is not None else default
    return default if value is None else value


def _work_spans(profile: Any, today: date) -> list[tuple[date, date]]:
    """Concrete (start, end) windows from the structured work history.

    A row whose start date cannot be parsed contributes nothing, measuring a
    career from a date we could not read is exactly the guess this module
    exists to avoid. A blank or "Present" end date is read as today, which is
    what a résumé means by it.
    """
    spans: list[tuple[date, date]] = []
    for row in _attr(profile, "workHistory", []) or []:
        start_text = str(_attr(row, "startDate", "") or (row.get("startDate", "") if isinstance(row, dict) else ""))
        end_text = str(_attr(row, "endDate", "") or (row.get("endDate", "") if isinstance(row, dict) else ""))
        start = parse_date_span(start_text)
        if start is None:
            continue
        if not end_text.strip() or _PRESENT.search(end_text):
            end_date = today
        else:
            end_span = parse_date_span(end_text)
            if end_span is None:
                continue
            end_date = min(end_span.latest, today)
        if end_date < start.earliest:
            continue
        spans.append((start.earliest, end_date))
    return spans


def total_experience_years(profile: Any, today: date) -> Optional[int]:
    """Completed years of work experience, counting overlapping roles once.

    None when the profile holds no datable role. Two jobs held at the same time
    are one span of time, not two, merging the intervals is the difference
    between "4 years" and a confidently doubled "8".
    """
    spans = sorted(_work_spans(profile, today))
    if not spans:
        return None
    merged: list[list[date]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    days = sum((end - start).days for start, end in merged)
    return int(days // 365.25)


def _education_rows(profile: Any) -> list[Any]:
    return list(_attr(profile, "educationHistory", []) or [])


def _row_field(row: Any, name: str) -> str:
    if isinstance(row, dict):
        return str(row.get(name, "") or "")
    return str(getattr(row, name, "") or "")


def latest_graduation_year(profile: Any) -> Optional[int]:
    years: list[int] = []
    for row in _education_rows(profile):
        m = re.search(r"\b(19|20)\d{2}\b", _row_field(row, "graduationYear"))
        if m:
            years.append(int(m.group()))
    return max(years) if years else None


def highest_degree_rank(profile: Any) -> Optional[int]:
    ranks = [degree_tier(_row_field(row, "degree")) for row in _education_rows(profile)]
    present = [r for r in ranks if r is not None]
    return max(present) if present else None


# ── The resolvers ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Derived:
    """A computed answer and the rule that computed it (for telemetry)."""
    value: str
    rule: str


def _is_yes_no(options: list[str]) -> bool:
    lowered = [o.lower().strip() for o in options]
    return "yes" in lowered and "no" in lowered


def _boolean_answer(value: bool, options: list[str]) -> Optional[str]:
    """Render a computed yes/no into something the widget will accept.

    With no options it is plain "Yes"/"No" (free text, or a control whose
    choices weren't harvested). With options it must be one of them, word for
    word, including when they are worded as prose ("I am 18 years of age or
    older"), which a literal "Yes" would never match.
    """
    if not options:
        return "Yes" if value else "No"
    return match_boolean_option(value, options)


def _resolve_age_gate(q: str, options: list[str], profile: Any, today: date) -> Optional[Derived]:
    """A minimum-age gate, answered from the date of birth."""
    # "under 18" is checked FIRST: "Are you under 18 years of age?" also
    # satisfies the "18 years of age" suffix pattern, so testing that first
    # reads the question as its own opposite.
    m = _AGE_UNDER_RE.search(q)
    inverted = m is not None
    if m is None:
        m = _AGE_MIN_RE.search(q) or _AGE_SUFFIX_RE.search(q)
    if m is None:
        return None
    if not (_GATE_SHAPE_RE.search(q) or _is_yes_no(options)):
        return None  # mentions an age but isn't asking a yes/no question

    threshold = int(m.group(1))
    if not 13 <= threshold <= 80:
        return None  # not an employment age gate, a count of something else

    bounds = age_bounds(str(_attr(profile, "dateOfBirth", "")), today)
    if bounds is None:
        return None  # no usable DOB, abstain, never assume
    youngest, oldest = bounds
    if youngest >= threshold:
        meets = True
    elif oldest < threshold:
        meets = False
    else:
        return None  # a birth year that straddles the birthday, genuinely unknown

    value = _boolean_answer(meets != inverted, options)
    return Derived(value, "age_gate") if value else None


def _resolve_age_value(q: str, options: list[str], profile: Any, today: date) -> Optional[Derived]:
    """"What is your age?", a number, not a gate."""
    if not re.search(r"\b(?:what\s+is\s+your\s+age|your\s+age|age\s+in\s+years|how\s+old\s+are\s+you)\b", q, re.IGNORECASE):
        return None
    if _AGE_MIN_RE.search(q) or _AGE_SUFFIX_RE.search(q) or _AGE_UNDER_RE.search(q):
        return None  # a gate, handled above
    bounds = age_bounds(str(_attr(profile, "dateOfBirth", "")), today)
    if bounds is None or bounds[0] != bounds[1]:
        return None  # only an exact DOB gives an exact age
    value = str(bounds[0])
    if options:
        matched = match_option(value, options)
        return Derived(matched, "age_value") if matched else None
    return Derived(value, "age_value")


def _resolve_total_experience(q: str, options: list[str], profile: Any, today: date) -> Optional[Derived]:
    """Total years of experience, computed from the work history."""
    if not _TOTAL_EXP_RE.search(q) or _NARROWED_EXP_RE.search(q):
        return None
    years = total_experience_years(profile, today)
    if years is None:
        return None
    value = str(years)
    if options:
        matched = match_option(value, options)
        return Derived(matched, "total_experience") if matched else None
    return Derived(value, "total_experience")


def _resolve_graduation_year(q: str, options: list[str], profile: Any, _today: date) -> Optional[Derived]:
    if not _GRAD_YEAR_RE.search(q):
        return None
    year = latest_graduation_year(profile)
    if year is None:
        return None
    value = str(year)
    if options:
        matched = match_option(value, options)
        return Derived(matched, "graduation_year") if matched else None
    return Derived(value, "graduation_year")


def _resolve_highest_degree(q: str, options: list[str], profile: Any, _today: date) -> Optional[Derived]:
    """The applicant's highest completed level of education.

    With options, the answer is the option at the SAME tier, "Bachelor of
    Science in Computer Science" and "Bachelor's Degree" share no phrase a
    text matcher would accept, but they are plainly the same level.
    """
    if not _HIGHEST_DEGREE_RE.search(q):
        return None
    rank = highest_degree_rank(profile)
    if rank is None:
        return None
    if options:
        same_tier = [o for o in options if degree_tier(o) == rank]
        if len(same_tier) != 1:
            return None  # ambiguous or unoffered, let a later pass try
        return Derived(same_tier[0], "highest_degree")
    label = _tier_label(rank)
    return Derived(label, "highest_degree") if label else None


def _resolve_current_employer(
    q: str, options: list[str], profile: Any, _today: date, company: str
) -> Optional[Derived]:
    """"Do you currently work at {company}?", compared to the current employer.

    Abstains when the profile names no current employer: "no" would then be a
    guess that happens to be right most of the time, which is exactly the habit
    this module is removing.
    """
    if not _CURRENT_EMPLOYER_RE.search(q):
        return None
    current = str(_attr(profile, "currentCompany", "")).strip()
    if not current:
        return None
    # Whose employment is being asked about: a company named in the question
    # itself wins over the job's company (a question can name a parent group).
    target = _company_in_question(q) or (company or "").strip()
    if not target:
        return None
    value = _boolean_answer(_same_company(current, target), options)
    return Derived(value, "current_employer") if value else None


_COMPANY_IN_Q_RE = re.compile(
    r"\b(?:work(?:ing)?\s+(?:at|for)|employed\s+(?:at|by)|employee\s+of)\s+"
    r"([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,3})"
)


def _company_in_question(q: str) -> str:
    m = _COMPANY_IN_Q_RE.search(q)
    return m.group(1).strip() if m else ""


_CORP_SUFFIX_RE = re.compile(
    r"\b(inc|inc\.|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|s\.a|group|holdings)\b",
    re.IGNORECASE,
)


def _same_company(a: str, b: str) -> bool:
    """Same employer, ignoring corporate suffixes and punctuation."""
    def norm(text: str) -> str:
        text = _CORP_SUFFIX_RE.sub(" ", text.lower())
        return re.sub(r"[^a-z0-9]+", " ", text).strip()

    na, nb = norm(a), norm(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


# Order matters only where two shapes could both match; each resolver is
# otherwise independent and abstains loudly.
_RESOLVERS = (
    _resolve_age_gate,
    _resolve_age_value,
    _resolve_total_experience,
    _resolve_graduation_year,
    _resolve_highest_degree,
)


def resolve_derived_fact(
    label: str,
    options: list[str],
    profile: Any,
    today: date,
    company: str = "",
    help_text: str = "",
) -> Optional[Derived]:
    """The computed answer for this question, or None to fall through.

    Called from pass 1 BEFORE the keyword rules and before the AI pass, so a
    question with a computable answer is never handed to the model to guess at.
    """
    q = f"{label or ''} {help_text or ''}".strip()
    if not q:
        return None
    for resolver in _RESOLVERS:
        found = resolver(q, options, profile, today)
        if found is not None:
            return found
    return _resolve_current_employer(q, options, profile, today, company)
