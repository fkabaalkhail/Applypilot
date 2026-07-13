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

# Yale: "avoid contractions". Matched as whole words after apostrophes are normalized,
# so a possessive ("the team's roadmap") is never mistaken for one.
CONTRACTIONS: frozenset[str] = frozenset("""
don't doesn't didn't won't wouldn't can't couldn't shouldn't isn't aren't wasn't weren't
hasn't haven't hadn't it's i'm i've i'll i'd we're we've we'll we'd they're they've they'd
you're you've that's there's here's let's what's who's ain't
""".split())

# Past-tense openers that do not end in "-ed".
IRREGULAR_PAST: frozenset[str] = frozenset("""
led built wrote taught ran made grew drove won sold spoke chose took gave held kept met
drew began brought bought found got left paid put read ran said sent set showed sought
spent stood taught told thought understood undertook upheld withdrew rebuilt rewrote
oversaw overcame cut set forecast troubleshot swept dealt
""".split())

# Base (present-simple) forms. A past role opening with one of these has the tense wrong.
PRESENT_BASE: frozenset[str] = frozenset("""
build lead manage create develop design maintain own run write test analyze analyse support
coordinate mentor ship deploy optimize optimise drive oversee collaborate present teach
train research implement automate debug refactor migrate integrate review monitor plan
organize organise negotiate advise direct guide handle deliver produce launch scale improve
reduce increase streamline architect prototype evaluate validate investigate publish author
partner supervise coach facilitate exceed succeed
""".split())

# Words ending in "-ed" that are present-tense base forms, so "-ed" alone cannot mean past.
ED_NOT_PAST: frozenset[str] = frozenset(
    "exceed succeed proceed feed breed speed need seed embed precede concede recede "
    "supersede".split()
)

# Yale: never put a photo, age, date of birth, marital status, sex, or religion on a resume.
# Every pattern demands an explicit label so a legitimate line is never flagged.
PERSONAL_DATA_RE: dict[str, re.Pattern[str]] = {
    "photo": re.compile(r"\b(photo|photograph|headshot)\b", re.I),
    "date of birth": re.compile(r"\b(date of birth|d\.?o\.?b\.?)\b[:\s]", re.I),
    "age": re.compile(r"\bage\s*[:\-]\s*\d{1,2}\b|\b\d{1,2}\s+years?\s+old\b", re.I),
    "marital status": re.compile(r"\bmarital status\b", re.I),
    "sex or gender": re.compile(r"\b(sex|gender)\s*[:\-]", re.I),
    "religion": re.compile(r"\breligio(n|us affiliation)\b", re.I),
}

MONTHS: dict[str, int] = {
    m: i for i, m in enumerate(
        "jan feb mar apr may jun jul aug sep oct nov dec".split(), start=1
    )
}

# Yale's length rule is set by level, not by how much the candidate has done.
PAGE_TARGETS: dict[str, tuple[int, int]] = {
    "undergraduate": (1, 1),
    "masters": (1, 2),
    "phd": (2, 3),
    "professional": (1, 2),
}

# Yale: 3-5 bullets per experience (3-4 ideal).
MIN_BULLETS_PER_ENTRY = 3
MAX_BULLETS_PER_ENTRY = 5

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


def _normalize_apostrophes(text: str) -> str:
    """PDF extraction yields curly apostrophes; match on one shape only."""
    return text.replace("’", "'").replace("ʼ", "'")


def _entries_of(profile: Any) -> list[dict[str, Any]]:
    """Dated entries whose bullets carry the 3-5 rule and the tense rule."""
    out: list[dict[str, Any]] = []

    def bullets_of(entry: Any) -> list[str]:
        return [
            b.strip()
            for b in (getattr(entry, "bullets", None) or [])
            if isinstance(b, str) and b.strip()
        ]

    for entry in getattr(profile, "experience", None) or []:
        title = (getattr(entry, "title", "") or "").strip()
        company = (getattr(entry, "company", "") or "").strip()
        name = " at ".join(p for p in (title, company) if p) or "Untitled role"
        out.append({
            "label": "Work Experience", "name": name, "bullets": bullets_of(entry),
            "end": (getattr(entry, "end_date", "") or "").strip(),
        })
    for entry in getattr(profile, "projects", None) or []:
        out.append({
            "label": "Projects",
            "name": (getattr(entry, "name", "") or "").strip() or "Untitled project",
            "bullets": bullets_of(entry),
            "end": (getattr(entry, "end_date", "") or "").strip(),
        })
    return out


def _is_current(end_date: str) -> bool:
    return bool(end_date) and bool(DATE_PATTERNS["Present"].match(end_date))


def _tense_of(word: str) -> str | None:
    """The tense of a bullet's opening verb, or None when it carries no tense signal.

    Returns "past", "present", "continuous", or None. None is the honest answer for an
    opener we cannot classify — a guess here becomes a finding the candidate cannot act on.
    """
    w = word.lower()
    if not w:
        return None
    if w.endswith("ing"):
        return "continuous"
    if w in IRREGULAR_PAST:
        return "past"
    if w in ED_NOT_PAST:
        return "present" if w in PRESENT_BASE else None
    if w.endswith("ed"):
        return "past"
    if w in PRESENT_BASE:
        return "present"
    return None


def _degree_level(degree: str) -> str | None:
    """Map one degree string onto a Yale length bracket."""
    text = degree.lower()
    # Drop the dots BEFORE tokenizing, or "M.Eng" splits into "m" + "eng" and matches nothing.
    plain = text.replace(".", "")
    compact = plain.replace(" ", "")
    tokens = set(re.findall(r"[a-z]+", plain))

    if "doctor" in text or "phd" in compact or "dphil" in compact:
        return "phd"
    if "master" in text or tokens & {"ms", "msc", "mba", "meng", "ma", "mfa", "llm", "mph", "med"}:
        return "masters"
    if (
        "bachelor" in text
        or "associate" in text
        or "undergrad" in text
        or tokens & {"bs", "bsc", "ba", "beng", "bba", "bfa", "as", "aa", "ab"}
    ):
        return "undergraduate"
    return None


def _infer_level(profile: Any) -> str:
    """The candidate's level, from their highest degree.

    Tailrd's job catalogue is students and new grads, so an education section with an
    unparseable degree means "undergraduate", not "professional". Only a resume with no
    education at all is treated as a professional hire.
    """
    education = getattr(profile, "education", None) or []
    levels = {lvl for e in education if (lvl := _degree_level(getattr(e, "degree", "") or ""))}
    for candidate in ("phd", "masters", "undergraduate"):
        if candidate in levels:
            return candidate
    return "undergraduate" if education else "professional"


def _date_key(value: str) -> tuple[int, int | None] | None:
    """A comparable (year, month) for a date string. ``month`` is None when unwritten."""
    v = value.strip()
    if not v:
        return None
    if DATE_PATTERNS["Present"].match(v):
        return (9999, 12)
    if m := re.match(r"^([a-z]{3,9})\.?\s+(\d{4})$", v, re.I):
        month = MONTHS.get(m.group(1)[:3].lower())
        return (int(m.group(2)), month) if month else None
    if m := re.match(r"^(\d{1,2})/(\d{4})$", v):
        return (int(m.group(2)), int(m.group(1)))
    if m := re.match(r"^(\d{4})-(\d{1,2})$", v):
        return (int(m.group(1)), int(m.group(2)))
    if m := re.match(r"^(\d{4})$", v):
        return (int(m.group(1)), None)
    return None


def _is_strictly_later(a: tuple[int, int | None], b: tuple[int, int | None]) -> bool:
    """Is ``a`` unambiguously later than ``b``?

    When either side omits its month, only the years are compared — a resume that writes
    "2024" in one place and "May 2024" in another is untidy, not out of order, and this
    check must not invent a violation out of that.
    """
    if a[0] != b[0]:
        return a[0] > b[0]
    if a[1] is None or b[1] is None:
        return False
    return a[1] > b[1]


def _chronology_violations(profile: Any) -> list[str]:
    """Entries listed before something older than them. Yale: reverse chronological."""
    groups: list[tuple[str, list[tuple[str, str]]]] = [
        ("Work Experience", [
            ((getattr(e, "title", "") or getattr(e, "company", "") or "an entry"),
             getattr(e, "end_date", "") or "")
            for e in getattr(profile, "experience", None) or []
        ]),
        ("Education", [
            ((getattr(e, "degree", "") or getattr(e, "school", "") or "an entry"),
             getattr(e, "end_date", "") or "")
            for e in getattr(profile, "education", None) or []
        ]),
        ("Projects", [
            ((getattr(e, "name", "") or "an entry"), getattr(e, "end_date", "") or "")
            for e in getattr(profile, "projects", None) or []
        ]),
    ]

    violations: list[str] = []
    for label, entries in groups:
        dated = [(name, key) for name, raw in entries if (key := _date_key(raw))]
        for i in range(len(dated) - 1):
            name, key = dated[i]
            next_name, next_key = dated[i + 1]
            if _is_strictly_later(next_key, key):
                violations.append(
                    f'[{label}] "{next_name}" ends later than "{name}" but is listed after it'
                )
    return violations


def _repeated_openers(bullets: list[tuple[str, str]]) -> list[str]:
    """Opening verbs used three or more times — the tell of a templated resume."""
    counts: dict[str, int] = {}
    for _, text in bullets:
        word = _first_word(text)
        if word:
            counts[word] = counts.get(word, 0) + 1
    repeated = [(w, n) for w, n in counts.items() if n >= 3]
    repeated.sort(key=lambda pair: (-pair[1], pair[0]))
    return [f"{w} ({n}x)" for w, n in repeated]


def _unevidenced_skills(profile: Any, bullets: list[tuple[str, str]]) -> list[str]:
    """Skills the candidate lists but never demonstrates in a bullet.

    Skills shorter than three characters ("C", "R", "Go") are skipped: substring matching
    on them produces noise, not findings.
    """
    blob = " ".join(text for _, text in bullets).lower()
    blob += " " + (getattr(profile, "summary", "") or "").lower()
    return [
        skill
        for raw in (getattr(profile, "skills", None) or [])
        if isinstance(raw, str) and len(skill := raw.strip()) >= 3 and skill.lower() not in blob
    ]


def build_digest(raw_text: str, profile: Any) -> dict[str, Any]:
    """Measure the resume. Every value here is a fact, not a judgement."""
    bullets = _bullets_of(profile)
    total = len(bullets)

    quantified = [b for _, b in bullets if NUMBER_RE.search(b)]
    strong = [b for _, b in bullets if _first_word(b) in STRONG_VERBS]

    weak_hits: list[str] = []
    passive_hits: list[str] = []
    pronoun_hits: list[str] = []
    contraction_hits: list[str] = []
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
        words_in = set(re.findall(r"[a-z']+", _normalize_apostrophes(lower)))
        if words_in & CONTRACTIONS:
            contraction_hits.append(f"[{label}] {text}")
        words = len(text.split())
        if words > 32:
            long_bullets.append(f"[{label}] ({words} words) {text}")
        elif words < 6:
            short_bullets.append(f"[{label}] ({words} words) {text}")
        if not NUMBER_RE.search(text):
            unquantified.append(f"[{label}] {text}")

    # Per-entry rules: 3-5 bullets each, and a tense that matches whether the role ended.
    no_bullets: list[str] = []
    too_few_bullets: list[str] = []
    too_many_bullets: list[str] = []
    continuous_hits: list[str] = []
    tense_hits: list[str] = []

    for entry in _entries_of(profile):
        count = len(entry["bullets"])
        where = f'[{entry["label"]}] {entry["name"]}'
        if count == 0:
            no_bullets.append(where)
        elif count < MIN_BULLETS_PER_ENTRY:
            too_few_bullets.append(f"{where} ({count} bullet(s))")
        elif count > MAX_BULLETS_PER_ENTRY:
            too_many_bullets.append(f"{where} ({count} bullets)")

        dated = bool(entry["end"])
        current = _is_current(entry["end"])
        for text in entry["bullets"]:
            tense = _tense_of(_first_word(text))
            if tense == "continuous":
                continuous_hits.append(f"{where}: {text}")
                continue
            if not dated or tense is None:
                continue
            if current and tense == "past":
                tense_hits.append(f"{where} is current, but this bullet is past tense: {text}")
            elif not current and tense == "present":
                tense_hits.append(f"{where} has ended, but this bullet is present tense: {text}")

    text_lower = raw_text.lower()
    filler_hits = [p for p in FILLER_PHRASES if p in text_lower]
    personal_data = [
        label for label, pattern in PERSONAL_DATA_RE.items() if pattern.search(raw_text)
    ]

    word_count = len(raw_text.split())
    date_formats = _date_formats(profile)

    level = _infer_level(profile)
    min_pages, max_pages = PAGE_TARGETS[level]
    estimated_pages = max(1, round(word_count / 600))

    contact = {
        "email": bool((getattr(profile, "email", "") or "").strip()),
        "phone": bool((getattr(profile, "phone", "") or "").strip()),
        "location": bool((getattr(profile, "location", "") or "").strip()),
        "linkedin": bool((getattr(profile, "linkedin_url", "") or "").strip()),
    }

    def pct(n: int) -> int:
        return round(100 * n / total) if total else 0

    return {
        "level": level,
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
        "entries": {
            "no_bullets": no_bullets,
            "too_few_bullets": too_few_bullets[:8],
            "too_many_bullets": too_many_bullets[:8],
        },
        "language": {
            "weak_openers": weak_hits[:8],
            "passive_voice": passive_hits[:8],
            "first_person": pronoun_hits[:6],
            "contractions": contraction_hits[:6],
            "present_continuous": continuous_hits[:8],
            "tense_mismatches": tense_hits[:8],
            "repeated_openers": _repeated_openers(bullets),
            "filler_phrases": filler_hits,
        },
        "structure": {
            "reverse_chronological": not (violations := _chronology_violations(profile)),
            "order_violations": violations,
        },
        "keywords": {
            "skills_not_evidenced": _unevidenced_skills(profile, bullets)[:15],
        },
        "formatting": {
            "word_count": word_count,
            "estimated_pages": estimated_pages,
            "page_target": f"{min_pages}-{max_pages}" if min_pages != max_pages else str(min_pages),
            "length_ok": min_pages <= estimated_pages <= max_pages,
            "date_formats_used": date_formats,
            "date_format_consistent": len(date_formats) <= 1,
            "contact": contact,
            "missing_contact": [k for k, present in contact.items() if not present],
            "personal_data": personal_data,
        },
    }


def _bullet_list(label: str, values: list[str]) -> str:
    if not values:
        return f"{label}: none\n"
    lines = "\n".join(f'  - "{v}"' for v in values)
    return f"{label} ({len(values)}):\n{lines}\n"


def _length_note(digest: dict[str, Any]) -> str:
    """How this resume's length reads against the Yale target for its level."""
    fmt = digest["formatting"]
    pages = fmt["estimated_pages"]
    target = fmt["page_target"]
    min_pages, max_pages = PAGE_TARGETS[digest["level"]]
    if pages > max_pages:
        return f"OVER the {target}-page target"
    if pages < min_pages:
        return f"UNDER the {target}-page target"
    return f"within the {target}-page target"


def render_digest(digest: dict[str, Any]) -> str:
    """Format a digest as prompt-ready ground truth."""
    counts = digest["counts"]
    bullets = digest["bullets"]
    entries = digest["entries"]
    lang = digest["language"]
    structure = digest["structure"]
    keywords = digest["keywords"]
    fmt = digest["formatting"]

    out = [
        "MEASURED FACTS (computed from the resume — treat as ground truth):",
        f"Candidate level (from their degrees): {digest['level']}",
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
            f"Length: {fmt['word_count']} words (~{fmt['estimated_pages']} page(s)) — "
            f"{_length_note(digest)}"
        ),
        (
            f"Date formats used: {', '.join(fmt['date_formats_used']) or 'none'}"
            f" ({'consistent' if fmt['date_format_consistent'] else 'INCONSISTENT'})"
        ),
        (
            "Entries in reverse-chronological order: "
            f"{'yes' if structure['reverse_chronological'] else 'NO'}"
        ),
        f"Missing contact fields: {', '.join(fmt['missing_contact']) or 'none'}",
        (
            "Personal data that must never appear on a resume: "
            f"{', '.join(fmt['personal_data']) or 'none found'}"
        ),
        "",
        _bullet_list("Bullets with no metric", bullets["unquantified"]),
        _bullet_list("Bullets over 32 words", bullets["too_long"]),
        _bullet_list("Bullets under 6 words", bullets["too_short"]),
        _bullet_list("Bullets opening with a duty phrase", lang["weak_openers"]),
        _bullet_list("Bullets in passive voice", lang["passive_voice"]),
        _bullet_list("Bullets using first person", lang["first_person"]),
        _bullet_list("Bullets using a contraction", lang["contractions"]),
        _bullet_list(
            "Bullets opening in the present continuous (use present simple, or past tense)",
            lang["present_continuous"],
        ),
        _bullet_list("Bullets whose tense contradicts the entry's dates", lang["tense_mismatches"]),
        _bullet_list("Opening verbs used 3+ times", lang["repeated_openers"]),
        _bullet_list("Entries with no bullets at all", entries["no_bullets"]),
        _bullet_list("Entries with fewer than 3 bullets", entries["too_few_bullets"]),
        _bullet_list("Entries with more than 5 bullets", entries["too_many_bullets"]),
        _bullet_list("Entries listed out of reverse-chronological order", structure["order_violations"]),
        _bullet_list("Skills listed but never evidenced in a bullet", keywords["skills_not_evidenced"]),
        _bullet_list("Filler phrases found in the document", lang["filler_phrases"]),
    ]
    return "\n".join(out)
