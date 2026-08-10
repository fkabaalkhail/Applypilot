"""
Normalize raw LLM JSON into our typed resume schemas.

Kept apart from the LLM transport so the mapping, which is where resume content
was historically lost, can be tested directly against recorded model output.

Two entry points:
  ``build_profile(data)``          → ResumeProfile   (from analyze_resume)
  ``build_analysis_report(data)``  → AnalysisReport  (from analyze_resume_quality)

Both are total: any missing, misspelled, or wrong-typed key degrades to an empty
value rather than raising, because a resume that parses to 90% is worth vastly
more to the user than a 500.
"""

from __future__ import annotations

import datetime
import re
from typing import Any

from backend.schemas.resume import (
    AnalysisCategory,
    AnalysisIssue,
    AnalysisReport,
    CustomSection,
    CustomSectionItem,
    EducationItem,
    ExperienceItem,
    ProjectItem,
    ResumeProfile,
)

# The section keys we model explicitly. Anything else becomes "custom:<id>".
KNOWN_SECTION_KEYS = (
    "summary",
    "experience",
    "education",
    "projects",
    "skills",
    "technologies",
)

# Order used when the model gives us no usable section_order.
DEFAULT_SECTION_ORDER = (
    "summary",
    "experience",
    "education",
    "projects",
    "skills",
    "technologies",
)

_SEVERITIES = ("urgent", "critical", "optional")

_CATEGORY_NAMES = {
    "impact": "Impact & Achievements",
    "wording": "Wording & Language",
    "structure": "Structure & Flow",
    "brevity": "Brevity & Effectiveness",
    "ats": "ATS & Formatting",
    "keywords": "Skills & Keywords",
}

# "Oct 2025 – May 2026", "2020 to Present", "2019-2021"
_RANGE_SPLIT = re.compile(r"\s*(?:–|—|-|to|until|through)\s*", re.IGNORECASE)


def _s(value: Any) -> str:
    """Coerce to a clean string. None/False/numbers all become sane text."""
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _str_list(value: Any) -> list[str]:
    """Coerce to a list of non-empty strings, tolerating a bare string."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, (list, tuple)):
        return []
    return [_s(v) for v in value if _s(v)]


def _comma_list(value: Any) -> list[str]:
    """Like ``_str_list`` but also splits entries that arrived comma-joined.

    Models routinely return coursework as one string ("Algorithms, OS") despite
    being asked for one entry each.
    """
    out: list[str] = []
    for entry in _str_list(value):
        out.extend(part.strip() for part in entry.split(",") if part.strip())
    return out


def _dicts(value: Any) -> list[dict]:
    """Only the dict entries of a list; anything else is ignored."""
    if not isinstance(value, (list, tuple)):
        return []
    return [v for v in value if isinstance(v, dict)]


def _split_range(value: str) -> tuple[str, str]:
    """Split a legacy single-string date range into (start, end)."""
    text = _s(value)
    if not text:
        return "", ""
    parts = [p.strip() for p in _RANGE_SPLIT.split(text) if p.strip()]
    if len(parts) >= 2:
        return parts[0], parts[-1]
    return text, ""


def _dates(entry: dict, legacy_key: str = "") -> tuple[str, str]:
    """Read start/end dates, falling back to a legacy combined field.

    Older prompts asked for ``duration`` (experience) and ``year`` (education).
    Those keys silently vanished when pydantic dropped the extras, which is how
    every uploaded resume lost its dates.
    """
    start = _s(entry.get("start_date"))
    end = _s(entry.get("end_date"))
    if not start and not end and legacy_key:
        start, end = _split_range(entry.get(legacy_key, ""))
    return start, end


def _experience(raw: Any) -> list[ExperienceItem]:
    items: list[ExperienceItem] = []
    for e in _dicts(raw):
        start, end = _dates(e, "duration")
        item = ExperienceItem(
            company=_s(e.get("company")),
            title=_s(e.get("title")),
            location=_s(e.get("location")),
            start_date=start,
            end_date=end,
            bullets=_str_list(e.get("bullets") or e.get("description")),
        )
        if item.company or item.title or item.bullets:
            items.append(item)
    return items


def _education(raw: Any) -> list[EducationItem]:
    items: list[EducationItem] = []
    for e in _dicts(raw):
        start, end = _dates(e, "year")
        item = EducationItem(
            school=_s(e.get("school")),
            degree=_s(e.get("degree")),
            location=_s(e.get("location")),
            start_date=start,
            end_date=end,
            gpa=_s(e.get("gpa")),
            achievements=_str_list(e.get("achievements")),
            coursework=_comma_list(e.get("coursework")),
        )
        if item.school or item.degree:
            items.append(item)
    return items


def _projects(raw: Any) -> list[ProjectItem]:
    items: list[ProjectItem] = []
    for p in _dicts(raw):
        start, end = _dates(p, "duration")
        item = ProjectItem(
            name=_s(p.get("name") or p.get("title")),
            link=_s(p.get("link") or p.get("url")),
            organization=_s(p.get("organization")),
            location=_s(p.get("location")),
            start_date=start,
            end_date=end,
            bullets=_str_list(p.get("bullets") or p.get("description")),
        )
        if item.name or item.bullets:
            items.append(item)
    return items


def _technologies(raw: Any) -> dict[str, list[str]]:
    if not isinstance(raw, dict):
        return {}
    groups: dict[str, list[str]] = {}
    for category, values in raw.items():
        name = _s(category)
        entries = _str_list(values)
        if name and entries:
            groups[name] = entries
    return groups


def _custom_sections(raw: Any) -> list[CustomSection]:
    sections: list[CustomSection] = []
    for c in _dicts(raw):
        items = [
            CustomSectionItem(
                title=_s(i.get("title")),
                subtitle=_s(i.get("subtitle")),
                location=_s(i.get("location")),
                start_date=_s(i.get("start_date")),
                end_date=_s(i.get("end_date")),
                detail=_s(i.get("detail")),
                link=_s(i.get("link")),
                bullets=_str_list(i.get("bullets")),
            )
            for i in _dicts(c.get("items"))
        ]
        items = [i for i in items if i.title or i.subtitle or i.bullets or i.detail]

        kind = _s(c.get("kind")).lower()
        section = CustomSection(
            title=_s(c.get("title")).upper(),
            kind="certifications" if kind == "certifications" else "custom",
            text=_s(c.get("text")),
            bullets=_str_list(c.get("bullets")),
            items=items,
        )
        # An id survives from a round-trip through the API; otherwise generate.
        existing_id = _s(c.get("id"))
        if existing_id:
            section.id = existing_id
        if section.title and (section.text or section.bullets or section.items):
            sections.append(section)
    return sections


def _merge_skills(skills: Any, technologies: dict[str, list[str]]) -> list[str]:
    """Flat skills list = declared skills ∪ every technology group, deduped."""
    out: list[str] = []
    seen: set[str] = set()
    for value in [*_str_list(skills), *(v for vals in technologies.values() for v in vals)]:
        key = value.lower()
        if key not in seen:
            seen.add(key)
            out.append(value)
    return out


def normalize_section_order(
    raw: Any,
    *,
    has_summary: bool,
    profile_sections: dict[str, bool],
    custom_sections: list[CustomSection],
) -> list[str]:
    """Resolve the model's section_order into keys we can look up.

    Custom sections arrive as ``custom:<TITLE>``; we rewrite them to
    ``custom:<id>``. Keys for empty sections are dropped, and any section with
    content that the model forgot to list is appended in the conventional order,
    so a section can never disappear because of a bad ordering.
    """
    by_title = {c.title.upper(): c.id for c in custom_sections}
    present = dict(profile_sections)
    present["summary"] = has_summary

    ordered: list[str] = []
    for entry in _str_list(raw):
        key = entry.strip()
        lower = key.lower()
        if lower in KNOWN_SECTION_KEYS:
            if present.get(lower) and lower not in ordered:
                ordered.append(lower)
            continue
        if lower.startswith("custom:"):
            label = key.split(":", 1)[1].strip().upper()
            cid = by_title.get(label)
            if cid:
                token = f"custom:{cid}"
                if token not in ordered:
                    ordered.append(token)
            continue
        # A bare heading the model forgot to prefix ("CERTIFICATIONS").
        cid = by_title.get(key.upper())
        if cid and f"custom:{cid}" not in ordered:
            ordered.append(f"custom:{cid}")

    for key in DEFAULT_SECTION_ORDER:
        if present.get(key) and key not in ordered:
            ordered.append(key)
    for section in custom_sections:
        token = f"custom:{section.id}"
        if token not in ordered:
            ordered.append(token)

    return ordered


def build_profile(data: Any) -> ResumeProfile:
    """Map an ``analyze_resume`` response into a ResumeProfile, losing nothing."""
    if not isinstance(data, dict):
        return ResumeProfile()

    technologies = _technologies(data.get("technologies"))
    experience = _experience(data.get("experience"))
    education = _education(data.get("education"))
    projects = _projects(data.get("projects"))
    custom_sections = _custom_sections(data.get("custom_sections"))
    skills = _merge_skills(data.get("skills"), technologies)
    summary = _s(data.get("summary"))

    section_order = normalize_section_order(
        data.get("section_order"),
        has_summary=bool(summary),
        profile_sections={
            "experience": bool(experience),
            "education": bool(education),
            "projects": bool(projects),
            "skills": bool(skills),
            "technologies": bool(technologies),
        },
        custom_sections=custom_sections,
    )

    return ResumeProfile(
        name=_s(data.get("name")),
        email=_s(data.get("email")),
        phone=_s(data.get("phone")),
        location=_s(data.get("location")),
        linkedin_url=_s(data.get("linkedin_url")),
        github_url=_s(data.get("github_url")),
        other_link=_s(data.get("other_link")),
        summary=summary,
        summary_title=_s(data.get("summary_title")) or ("PROFESSIONAL SUMMARY" if summary else ""),
        skills=skills,
        experience=experience,
        education=education,
        projects=projects,
        technologies=technologies,
        custom_sections=custom_sections,
        section_order=section_order,
    )


def _issues(raw: Any) -> list[AnalysisIssue]:
    issues: list[AnalysisIssue] = []
    for i in _dicts(raw):
        severity = _s(i.get("severity")).lower()
        if severity not in _SEVERITIES:
            severity = "optional"
        try:
            count = max(1, int(i.get("count", 1)))
        except (TypeError, ValueError):
            count = 1
        title = _s(i.get("title"))
        if not title:
            continue
        issues.append(
            AnalysisIssue(
                title=title,
                severity=severity,  # type: ignore[arg-type]
                count=count,
                description=_s(i.get("description")),
                evidence=_str_list(i.get("evidence")),
                suggestion=_s(i.get("suggestion")),
                section=_s(i.get("section")),
            )
        )
    # Most severe first, then the widest-spread.
    order = {s: n for n, s in enumerate(_SEVERITIES)}
    issues.sort(key=lambda x: (order[x.severity], -x.count))
    return issues


def _categories(raw: Any) -> list[AnalysisCategory]:
    categories: list[AnalysisCategory] = []
    for c in _dicts(raw):
        cid = _s(c.get("id")).lower()
        name = _s(c.get("name")) or _CATEGORY_NAMES.get(cid, "")
        if not name:
            continue
        try:
            score = max(0, min(100, int(c.get("score", 0))))
        except (TypeError, ValueError):
            score = 0
        categories.append(
            AnalysisCategory(
                id=cid or name.lower().replace(" ", "-"),
                name=name,
                score=score,
                why_it_matters=_s(c.get("why_it_matters")),
                issues=_issues(c.get("issues")),
            )
        )
    # Categories needing the most work lead the report.
    categories.sort(
        key=lambda c: (
            -sum(1 for i in c.issues if i.severity == "urgent"),
            -sum(1 for i in c.issues if i.severity == "critical"),
            c.score,
        )
    )
    return categories


def _letter_grade(score: int) -> str:
    for threshold, letter in (
        (90, "A+"), (85, "A"), (80, "A-"), (75, "B+"), (70, "B"),
        (65, "B-"), (60, "C+"), (55, "C"),
    ):
        if score >= threshold:
            return letter
    return "D"


def build_analysis_report(data: Any) -> AnalysisReport:
    """Map an ``analyze_resume_quality`` response into an AnalysisReport.

    Fix counts are recomputed from the issues rather than trusted, so the
    headline numbers can never disagree with the list the user reads below them.
    """
    if not isinstance(data, dict):
        data = {}

    categories = _categories(data.get("categories"))

    tally = {s: 0 for s in _SEVERITIES}
    for category in categories:
        for issue in category.issues:
            tally[issue.severity] += issue.count

    try:
        score = max(0, min(100, int(data.get("score", 0))))
    except (TypeError, ValueError):
        score = 0
    if not score and categories:
        score = round(sum(c.score for c in categories) / len(categories))

    grade = _s(data.get("overall_grade")).upper()
    if grade not in ("EXCELLENT", "GOOD", "FAIR"):
        grade = "EXCELLENT" if score >= 80 else "GOOD" if score >= 65 else "FAIR"

    # Fall back to the model's own counts only when it returned no categories
    # (an older or degraded response).
    def count_of(key: str, severity: str) -> int:
        if categories:
            return tally[severity]
        try:
            return max(0, int(data.get(key, 0)))
        except (TypeError, ValueError):
            return 0

    highlights = _str_list(data.get("highlights"))
    if not highlights:
        highlights = [i.title for c in categories for i in c.issues][:8]

    return AnalysisReport(
        overall_grade=grade,
        letter_grade=_s(data.get("letter_grade")) or _letter_grade(score),
        score=score,
        urgent_fix_count=count_of("urgent_fix_count", "urgent"),
        critical_fix_count=count_of("critical_fix_count", "critical"),
        optional_fix_count=count_of("optional_fix_count", "optional"),
        summary=_s(data.get("summary")),
        highlights=highlights,
        strengths=_str_list(data.get("strengths")),
        categories=categories,
        analyzed_at=datetime.datetime.now(datetime.timezone.utc),
    )
