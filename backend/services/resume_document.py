"""
Adapters between the stored resume profile and the structured ``ResumeDocument``.

``db_record_to_document`` builds a document from a ``ResumeProfileDB`` row using
the structured columns that were already parsed at upload time (no re-parse, no
LLM call). ``document_to_text`` flattens a document back to plain text for the
"Copy" button and for diffing/match-scoring.
"""

from __future__ import annotations

from typing import Any

from backend.schemas.resume_document import (
    ResumeDocument,
    ResumeHeader,
    Section,
    SectionItem,
)


def _get(obj: Any, key: str, default: Any = "") -> Any:
    """Read ``key`` from a dict or a pydantic/ORM object, tolerating either."""
    if isinstance(obj, dict):
        val = obj.get(key, default)
    else:
        val = getattr(obj, key, default)
    return default if val is None else val


def _str_list(value: Any) -> list[str]:
    if not value:
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def db_record_to_document(record: Any) -> ResumeDocument:
    """Build a ``ResumeDocument`` from a ``ResumeProfileDB`` row.

    Only sections that actually have content are emitted, in a conventional
    order. The theme is the default (clean, ATS-safe) template.
    """
    header = ResumeHeader(
        name=_get(record, "profile_name") or _get(record, "name") or "",
        email=_get(record, "email"),
        phone=_get(record, "phone"),
        location=_get(record, "location"),
        linkedin_url=_get(record, "linkedin_url"),
        github_url=_get(record, "github_url"),
        other_link=_get(record, "other_link"),
    )

    sections: list[Section] = []

    experience = _get(record, "experience", []) or []
    if experience:
        sections.append(
            Section(
                type="experience",
                title="WORK EXPERIENCE",
                items=[
                    SectionItem(
                        title=_get(e, "title"),
                        subtitle=_get(e, "company"),
                        location=_get(e, "location"),
                        start_date=_get(e, "start_date"),
                        end_date=_get(e, "end_date"),
                        bullets=_str_list(_get(e, "bullets", [])),
                    )
                    for e in experience
                ],
            )
        )

    education = _get(record, "education", []) or []
    if education:
        items: list[SectionItem] = []
        for ed in education:
            detail_bits = []
            gpa = _get(ed, "gpa")
            if gpa:
                detail_bits.append(f"GPA: {gpa}")
            coursework = _str_list(_get(ed, "coursework", []))
            bullets = _str_list(_get(ed, "achievements", []))
            if coursework:
                bullets = bullets + [f"Relevant coursework: {', '.join(coursework)}"]
            items.append(
                SectionItem(
                    title=_get(ed, "degree"),
                    subtitle=_get(ed, "school"),
                    start_date=_get(ed, "start_date"),
                    end_date=_get(ed, "end_date"),
                    detail="  ".join(detail_bits),
                    bullets=bullets,
                )
            )
        sections.append(Section(type="education", title="EDUCATION", items=items))

    projects = _get(record, "projects", []) or []
    if projects:
        sections.append(
            Section(
                type="projects",
                title="PROJECTS",
                items=[
                    SectionItem(
                        title=_get(p, "name"),
                        subtitle=_get(p, "organization"),
                        location=_get(p, "location"),
                        start_date=_get(p, "start_date"),
                        end_date=_get(p, "end_date"),
                        link=_get(p, "link"),
                        bullets=_str_list(_get(p, "bullets", [])),
                    )
                    for p in projects
                ],
            )
        )

    skills = _str_list(_get(record, "skills", []))
    if skills:
        sections.append(Section(type="skills", title="SKILLS", skills=skills))

    technologies = _get(record, "technologies", {}) or {}
    if isinstance(technologies, dict) and technologies:
        groups = {
            str(cat): _str_list(items)
            for cat, items in technologies.items()
            if _str_list(items)
        }
        if groups:
            sections.append(
                Section(type="technologies", title="TECHNOLOGIES", groups=groups)
            )

    return ResumeDocument(header=header, sections=sections)


def merge_rewrite(
    original: ResumeDocument,
    edited: ResumeDocument,
    section_order: list[str] | None = None,
    new_summary: dict | None = None,
) -> ResumeDocument:
    """Fold an LLM rewrite into the original document, structurally.

    Only *content* is taken from ``edited`` — section summary text, the skills
    list, technology groups, and item bullets. Every factual field
    (header/contact, section type + title, item title/company/dates/detail/link,
    and all ids) is taken from ``original``, so the model can never invent
    employers/dates or drop a section.

    Two structural moves ARE allowed, both safe:

    - ``section_order`` — reorder the (existing) sections by id. Ids not listed
      are appended in their original relative order, so nothing is ever lost;
      unknown ids are ignored.
    - ``new_summary`` — ``{"title", "text"}`` prepended as a ``summary`` section,
      but only when the original has no ``summary``/``custom`` section (the one
      place new prose is allowed: a summary of the candidate's real content).
    """
    edited_sections_by_id = {s.id: s for s in edited.sections}

    merged_sections: list[Section] = []
    for i, orig_sec in enumerate(original.sections):
        ed_sec = edited_sections_by_id.get(orig_sec.id)
        if ed_sec is None and i < len(edited.sections):
            ed_sec = edited.sections[i]

        new_sec = orig_sec.model_copy(deep=True)
        if ed_sec is not None:
            if ed_sec.text.strip():
                new_sec.text = ed_sec.text
            if ed_sec.skills:
                new_sec.skills = [s for s in ed_sec.skills if str(s).strip()]
            if ed_sec.groups:
                new_sec.groups = {
                    k: [v for v in vals if str(v).strip()]
                    for k, vals in ed_sec.groups.items()
                }

            ed_items_by_id = {it.id: it for it in ed_sec.items}
            for j, orig_item in enumerate(new_sec.items):
                ed_item = ed_items_by_id.get(orig_item.id)
                if ed_item is None and j < len(ed_sec.items):
                    ed_item = ed_sec.items[j]
                if ed_item is not None and ed_item.bullets:
                    orig_item.bullets = [
                        b for b in ed_item.bullets if str(b).strip()
                    ]
        merged_sections.append(new_sec)

    # Reorder (never drop): listed ids first in the given order, remainder in
    # original relative order.
    if section_order:
        listed = set(section_order)
        by_id = {s.id: s for s in merged_sections}
        ordered = [by_id[sid] for sid in section_order if sid in by_id]
        ordered += [s for s in merged_sections if s.id not in listed]
        merged_sections = ordered

    # Add a summary only when the original truly has none.
    has_summary = any(s.type in ("summary", "custom") for s in original.sections)
    if new_summary and not has_summary:
        text = str(new_summary.get("text", "")).strip()
        if text:
            merged_sections = [
                Section(
                    type="summary",
                    title=str(new_summary.get("title") or "PROFESSIONAL SUMMARY"),
                    text=text,
                )
            ] + merged_sections

    # Header and theme are never AI-editable in the rewrite path.
    return ResumeDocument(
        header=original.header.model_copy(deep=True),
        sections=merged_sections,
        theme=original.theme.model_copy(deep=True),
    )


def describe_changes(original: ResumeDocument, final: ResumeDocument) -> list[str]:
    """Human-readable, deterministic 'what changed' list.

    Ids are stable across ``merge_rewrite``, so we align sections/items by id and
    report only what actually differs. This is the source of truth for the UI's
    "See what's changed" list — the model is never asked to self-report.
    """
    changes: list[str] = []
    orig_ids = [s.id for s in original.sections]
    orig_id_set = set(orig_ids)

    # Reordering (compare the relative order of the sections that existed before).
    kept = [s.id for s in final.sections if s.id in orig_id_set]
    if kept != [i for i in orig_ids if i in set(kept)]:
        changes.append("Reordered sections to lead with the most relevant experience")

    # New sections (e.g. an added summary).
    for s in final.sections:
        if s.id not in orig_id_set and (s.text.strip() or s.items or s.skills):
            changes.append(f"Added a {(s.title or s.type).title()} section")

    # Reworded entries (match items by id).
    orig_bullets = {
        it.id: [b.strip() for b in it.bullets]
        for sec in original.sections
        for it in sec.items
    }
    reworded = 0
    for sec in final.sections:
        for it in sec.items:
            before = orig_bullets.get(it.id)
            if before is not None and [b.strip() for b in it.bullets] != before:
                reworded += 1
    if reworded:
        changes.append(
            f"Rewrote {reworded} entr{'y' if reworded == 1 else 'ies'} for stronger impact"
        )

    # Skills added.
    orig_skills = {s.strip().lower() for sec in original.sections for s in sec.skills}
    added = [
        s
        for sec in final.sections
        for s in sec.skills
        if s.strip().lower() not in orig_skills
    ]
    if added:
        preview = ", ".join(added[:4])
        changes.append(
            f"Added {len(added)} skill{'s' if len(added) > 1 else ''}: {preview}"
            f"{'…' if len(added) > 4 else ''}"
        )

    return changes


def document_to_text(doc: ResumeDocument) -> str:
    """Flatten a document to clean plain text (for Copy / diff / scoring)."""
    lines: list[str] = []
    h = doc.header
    if h.name:
        lines.append(h.name)
    contact = " | ".join(
        v for v in (h.location, h.email, h.phone) if v
    )
    if contact:
        lines.append(contact)
    links = " | ".join(
        v for v in (h.linkedin_url, h.github_url, h.other_link) if v
    )
    if links:
        lines.append(links)

    for section in doc.sections:
        lines.append("")
        lines.append((section.title or section.type).upper())

        if section.type == "summary" or section.type == "custom":
            if section.text:
                lines.append(section.text)

        if section.skills:
            lines.append(", ".join(section.skills))

        if section.groups:
            for category, items in section.groups.items():
                lines.append(f"{category}: {', '.join(items)}")

        for item in section.items:
            heading = " — ".join(v for v in (item.title, item.subtitle) if v)
            dates = " - ".join(v for v in (item.start_date, item.end_date) if v)
            head_line = "  ".join(v for v in (heading, dates) if v)
            if head_line:
                lines.append(head_line)
            if item.detail:
                lines.append(item.detail)
            for bullet in item.bullets:
                if bullet.strip():
                    lines.append(f"- {bullet.strip()}")

    return "\n".join(lines).strip()
