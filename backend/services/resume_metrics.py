"""
Deterministic structural facts about a resume.

The quality analyzer used to be handed nothing but raw text, so its counts
("3 issues related") were guesses and its evidence was often paraphrased. This
module computes what can be *measured* — bullet lengths, action-verb coverage,
quantification coverage, the literal weak-verb and passive hits, date-format
consistency — and the prompt hands those facts to the model as ground truth.

Nothing here calls an LLM. ``build_digest`` returns a plain dict; ``render_digest``
formats it for a prompt.
"""

from __future__ import annotations

import re
from typing import Any

# Verbs that open a strong, achievement-oriented bullet. Deliberately broad —
# the point is coverage, not a stylebook.
STRONG_VERBS: frozenset[str] = frozenset("""
accelerated achieved acquired adapted addressed advanced advised analyzed architected
authored automated balanced boosted broadened budgeted built centralized chaired
championed clarified coached collaborated compiled completed composed conceived
conducted consolidated constructed converted coordinated created cultivated cut
debugged decreased defined delivered deployed designed developed devised diagnosed
directed doubled drafted drove earned edited eliminated enabled engineered enhanced
established evaluated executed expanded expedited facilitated forecast formulated
founded generated grew guided halved headed identified implemented improved increased
influenced initiated innovated inspected installed instituted instructed integrated
introduced invented investigated launched led leveraged maintained managed mapped
marketed maximized measured mediated mentored migrated minimized modeled modernized
monitored negotiated optimized orchestrated organized overhauled owned partnered
performed pioneered planned prepared presented prioritized processed produced
programmed promoted prototyped provisioned published quantified rearchitected rebuilt
reconciled recovered recruited redesigned reduced refactored refined reengineered
reinforced remediated reorganized repaired replaced reported researched resolved
restructured revamped reviewed revised saved scaled scoped secured shipped simplified
solved sourced spearheaded standardized streamlined strengthened structured supervised
supported surpassed surveyed sustained synthesized taught tested tracked trained
transformed translated tripled troubleshot uncovered unified upgraded validated
verified won wrote
""".split())

# Openers that describe a duty instead of an achievement.
WEAK_OPENERS: tuple[str, ...] = (
    "responsible for", "duties included", "tasked with", "worked on", "worked with",
    "helped", "helped with", "assisted", "assisted with", "involved in",
    "participated in", "in charge of", "handled", "dealt with", "took part in",
    "was responsible", "contributed to", "supported the", "familiar with",
    "exposure to", "gained experience",
)

FILLER_PHRASES: tuple[str, ...] = (
    "team player", "hard worker", "hard-working", "detail oriented",
    "detail-oriented", "self-starter", "go-getter", "think outside the box",
    "results-driven", "results driven", "proven track record", "dynamic individual",
    "excellent communication skills", "strong work ethic", "fast learner",
    "passionate about", "highly motivated", "synergy", "wide variety of",
)

PRONOUNS: tuple[str, ...] = ("i ", "i'", "my ", "me ", "we ", "our ", "mine ")

# "was <verb>ed", "were <verb>ed", "been <verb>ed", "is <verb>ed by" …
PASSIVE_RE = re.compile(
    r"\b(?:was|were|been|being|is|are|am)\s+(?:\w+ly\s+)?(\w+(?:ed|en))\b",
    re.IGNORECASE,
)

# Any real figure: 42, 42%, $1.2M, 3x, 1,200, 15 hours.
NUMBER_RE = re.compile(r"(?<![\w.])(?:\$\s?\d|\d+(?:[.,]\d+)*\s?(?:%|x\b|k\b|m\b|bn?\b)?|\d)")

# Common date shapes we can compare for consistency.
DATE_PATTERNS: dict[str, re.Pattern[str]] = {
    "Mon YYYY": re.compile(
        r"^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}$", re.I
    ),
    "MM/YYYY": re.compile(r"^\d{1,2}/\d{4}$"),
    "YYYY-MM": re.compile(r"^\d{4}-\d{1,2}$"),
    "YYYY": re.compile(r"^\d{4}$"),
    "Present": re.compile(r"^(present|current|now|ongoing)$", re.I),
}

_HEADING_RE = re.compile(r"^[A-Z][A-Z /&'\-\.]{2,40}$")

# Section headings we recognize when scanning the raw text, so "which sections
# does this resume actually have, in what order" is a fact and not an opinion.
KNOWN_HEADINGS: dict[str, tuple[str, ...]] = {
    "Summary": ("summary", "profile", "objective", "about"),
    "Experience": ("experience", "employment", "work history", "professional"),
    "Education": ("education", "academic"),
    "Projects": ("project",),
    "Skills": ("skill", "competenc", "technolog", "technical"),
    "Certifications": ("certification", "certificate", "licens"),
    "Awards": ("award", "honor", "honour", "achievement"),
    "Volunteering": ("volunteer", "community"),
    "Publications": ("publication", "research", "paper"),
    "Languages": ("language",),
    "Leadership": ("leadership", "activit", "involvement"),
    "Interests": ("interest", "hobb"),
}


def _first_word(text: str) -> str:
    match = re.search(r"[A-Za-z][\w'-]*", text)
    return match.group(0).lower() if match else ""


def _bullets_of(profile: Any) -> list[tuple[str, str]]:
    """Every bullet in the profile as ``(section_label, text)``."""
    out: list[tuple[str, str]] = []

    def add(label: str, bullets: Any) -> None:
        if isinstance(bullets, list):
            for b in bullets:
                if isinstance(b, str) and b.strip():
                    out.append((label, b.strip()))

    for entry in getattr(profile, "experience", None) or []:
        add("Work Experience", getattr(entry, "bullets", None))
    for entry in getattr(profile, "projects", None) or []:
        add("Projects", getattr(entry, "bullets", None))
    for entry in getattr(profile, "education", None) or []:
        add("Education", getattr(entry, "achievements", None))
    for sec in getattr(profile, "custom_sections", None) or []:
        label = (getattr(sec, "title", "") or "Other").title()
        add(label, getattr(sec, "bullets", None))
        for item in getattr(sec, "items", None) or []:
            add(label, getattr(item, "bullets", None))
    return out


def _headings_in_order(raw_text: str) -> list[str]:
    """Section headings detected in the raw text, in document order, deduped."""
    found: list[str] = []
    for line in raw_text.splitlines():
        stripped = line.strip().rstrip(":")
        if not stripped or len(stripped) > 42:
            continue
        # A heading is either ALL-CAPS or a short Title Case line that matches a
        # known section word.
        looks_like_heading = _HEADING_RE.match(stripped) or len(stripped.split()) <= 4
        if not looks_like_heading:
            continue
        lower = stripped.lower()
        for canonical, needles in KNOWN_HEADINGS.items():
            if any(n in lower for n in needles) and canonical not in found:
                found.append(canonical)
                break
    return found


def _date_formats(profile: Any) -> list[str]:
    """The distinct date formats used across all dated entries."""
    values: list[str] = []
    for group, fields in (
        (getattr(profile, "experience", None) or [], ("start_date", "end_date")),
        (getattr(profile, "education", None) or [], ("start_date", "end_date")),
        (getattr(profile, "projects", None) or [], ("start_date", "end_date")),
    ):
        for entry in group:
            for field in fields:
                val = (getattr(entry, field, "") or "").strip()
                if val:
                    values.append(val)

    formats: list[str] = []
    for val in values:
        matched = next((n for n, p in DATE_PATTERNS.items() if p.match(val)), "other")
        if matched not in ("Present", "other") and matched not in formats:
            formats.append(matched)
    return formats


def build_digest(raw_text: str, profile: Any) -> dict[str, Any]:
    """Measure the resume. Every value here is a fact, not a judgement."""
    bullets = _bullets_of(profile)
    total = len(bullets)

    quantified = [b for _, b in bullets if NUMBER_RE.search(b)]
    strong = [b for _, b in bullets if _first_word(b) in STRONG_VERBS]

    weak_hits: list[str] = []
    passive_hits: list[str] = []
    pronoun_hits: list[str] = []
    long_bullets: list[str] = []
    short_bullets: list[str] = []
    unquantified: list[str] = []

    for label, text in bullets:
        lower = text.lower()
        if any(lower.startswith(o) for o in WEAK_OPENERS):
            weak_hits.append(f"[{label}] {text}")
        if PASSIVE_RE.search(text):
            passive_hits.append(f"[{label}] {text}")
        if any(lower.startswith(p) for p in PRONOUNS) or " i " in f" {lower} ":
            pronoun_hits.append(f"[{label}] {text}")
        words = len(text.split())
        if words > 32:
            long_bullets.append(f"[{label}] ({words} words) {text}")
        elif words < 6:
            short_bullets.append(f"[{label}] ({words} words) {text}")
        if not NUMBER_RE.search(text):
            unquantified.append(f"[{label}] {text}")

    text_lower = raw_text.lower()
    filler_hits = [p for p in FILLER_PHRASES if p in text_lower]

    word_count = len(raw_text.split())
    date_formats = _date_formats(profile)

    contact = {
        "email": bool((getattr(profile, "email", "") or "").strip()),
        "phone": bool((getattr(profile, "phone", "") or "").strip()),
        "location": bool((getattr(profile, "location", "") or "").strip()),
        "linkedin": bool((getattr(profile, "linkedin_url", "") or "").strip()),
    }

    def pct(n: int) -> int:
        return round(100 * n / total) if total else 0

    return {
        "sections_in_order": _headings_in_order(raw_text),
        "has_summary": bool((getattr(profile, "summary", "") or "").strip()),
        "counts": {
            "experience_entries": len(getattr(profile, "experience", None) or []),
            "education_entries": len(getattr(profile, "education", None) or []),
            "project_entries": len(getattr(profile, "projects", None) or []),
            "skills": len(getattr(profile, "skills", None) or []),
            "custom_sections": len(getattr(profile, "custom_sections", None) or []),
            "bullets": total,
        },
        "bullets": {
            "quantified_pct": pct(len(quantified)),
            "strong_verb_pct": pct(len(strong)),
            "mean_words": round(
                sum(len(b.split()) for _, b in bullets) / total, 1
            ) if total else 0.0,
            "unquantified": unquantified[:12],
            "too_long": long_bullets[:6],
            "too_short": short_bullets[:6],
        },
        "language": {
            "weak_openers": weak_hits[:8],
            "passive_voice": passive_hits[:8],
            "first_person": pronoun_hits[:6],
            "filler_phrases": filler_hits,
        },
        "formatting": {
            "word_count": word_count,
            "estimated_pages": max(1, round(word_count / 600)),
            "date_formats_used": date_formats,
            "date_format_consistent": len(date_formats) <= 1,
            "contact": contact,
            "missing_contact": [k for k, present in contact.items() if not present],
        },
    }


def _bullet_list(label: str, values: list[str]) -> str:
    if not values:
        return f"{label}: none\n"
    lines = "\n".join(f'  - "{v}"' for v in values)
    return f"{label} ({len(values)}):\n{lines}\n"


def render_digest(digest: dict[str, Any]) -> str:
    """Format a digest as prompt-ready ground truth."""
    counts = digest["counts"]
    bullets = digest["bullets"]
    lang = digest["language"]
    fmt = digest["formatting"]

    out = [
        "MEASURED FACTS (computed from the resume — treat as ground truth):",
        f"Sections present, in order: {', '.join(digest['sections_in_order']) or 'none detected'}",
        f"Has a summary section: {'yes' if digest['has_summary'] else 'no'}",
        (
            f"Entries: {counts['experience_entries']} experience, "
            f"{counts['education_entries']} education, {counts['project_entries']} projects, "
            f"{counts['custom_sections']} other sections, {counts['skills']} skills"
        ),
        f"Bullets: {counts['bullets']} total, mean {bullets['mean_words']} words",
        f"Bullets containing a number/metric: {bullets['quantified_pct']}%",
        f"Bullets opening with a strong action verb: {bullets['strong_verb_pct']}%",
        (
            f"Length: {fmt['word_count']} words (~{fmt['estimated_pages']} page(s)); "
            f"date formats used: {', '.join(fmt['date_formats_used']) or 'none'}"
            f" ({'consistent' if fmt['date_format_consistent'] else 'INCONSISTENT'})"
        ),
        f"Missing contact fields: {', '.join(fmt['missing_contact']) or 'none'}",
        "",
        _bullet_list("Bullets with no metric", bullets["unquantified"]),
        _bullet_list("Bullets over 32 words", bullets["too_long"]),
        _bullet_list("Bullets under 6 words", bullets["too_short"]),
        _bullet_list("Bullets opening with a duty phrase", lang["weak_openers"]),
        _bullet_list("Bullets in passive voice", lang["passive_voice"]),
        _bullet_list("Bullets using first person", lang["first_person"]),
        _bullet_list("Filler phrases found in the document", lang["filler_phrases"]),
    ]
    return "\n".join(out)
