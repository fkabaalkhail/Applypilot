"""
The resume-extraction mapping.

Every section a user has must survive the trip from the model's JSON into the
profile. This is where they used to be lost: the old prompt asked for eight keys
and ``analyze_resume`` read even fewer, so projects, technologies, GitHub links,
and every date were silently dropped before they reached the database.
"""

import datetime

import pytest

from backend.schemas.resume import ResumeProfile
from backend.services.resume_document import (
    db_record_to_document,
    document_to_profile,
)
from backend.services.resume_extraction import build_analysis_report, build_profile


FULL_RESPONSE = {
    "name": "Wissam Elmasry",
    "email": "elmasry.wissam@gmail.com",
    "phone": "(438) 372-5348",
    "location": "Gatineau, QC",
    "linkedin_url": "https://linkedin.com/in/wissam",
    "github_url": "https://github.com/WisHonor",
    "other_link": "https://tailrd.ca",
    "summary": "Software engineering student shipping production tooling.",
    "summary_title": "PROFILE",
    "skills": ["Python"],
    "technologies": {"Languages": ["Python", "Go"], "Cloud": ["AWS"]},
    "experience": [
        {
            "company": "Public Services and Procurement Canada",
            "title": "Software Developer & Tester",
            "location": "Gatineau, QC",
            "start_date": "Oct 2025",
            "end_date": "May 2026",
            "bullets": ["Built the intake pipeline", "Automated regression suite"],
        }
    ],
    "education": [
        {
            "school": "University of Ottawa",
            "degree": "BASc, Software Engineering",
            "start_date": "2024",
            "end_date": "Present",
            "gpa": "3.9",
            "achievements": ["Dean's List"],
            "coursework": ["Algorithms", "Operating Systems"],
        }
    ],
    "projects": [
        {
            "name": "Tailrd",
            "link": "https://tailrd.ca",
            "organization": "Personal",
            "start_date": "2025",
            "end_date": "Present",
            "bullets": ["Shipped a Chrome autofill extension"],
        }
    ],
    "custom_sections": [
        {
            "title": "certifications",
            "kind": "certifications",
            "items": [{"title": "AWS Solutions Architect", "subtitle": "Amazon"}],
        },
        {"title": "Awards", "bullets": ["Hackathon winner"]},
        {"title": "Interests", "text": "Chess and climbing."},
    ],
    "section_order": [
        "summary", "projects", "experience", "education",
        "custom:CERTIFICATIONS", "skills",
    ],
}


def test_every_section_survives_extraction():
    profile = build_profile(FULL_RESPONSE)

    assert [p.name for p in profile.projects] == ["Tailrd"]
    assert profile.projects[0].link == "https://tailrd.ca"
    assert profile.github_url == "https://github.com/WisHonor"
    assert profile.other_link == "https://tailrd.ca"
    assert profile.summary_title == "PROFILE"
    assert profile.technologies == {"Languages": ["Python", "Go"], "Cloud": ["AWS"]}
    assert [c.title for c in profile.custom_sections] == ["CERTIFICATIONS", "AWARDS", "INTERESTS"]
    assert profile.custom_sections[0].kind == "certifications"
    assert profile.custom_sections[1].bullets == ["Hackathon winner"]
    assert profile.custom_sections[2].text == "Chess and climbing."


def test_dates_survive_both_the_new_and_the_legacy_key():
    """The old prompt asked for `duration`/`year`; pydantic dropped the extras."""
    profile = build_profile(FULL_RESPONSE)
    assert (profile.experience[0].start_date, profile.experience[0].end_date) == ("Oct 2025", "May 2026")

    legacy = build_profile({
        "experience": [{"company": "Acme", "title": "Dev", "duration": "Oct 2025 – May 2026"}],
        "education": [{"school": "uOttawa", "degree": "BASc", "year": "2020 to 2024"}],
    })
    assert (legacy.experience[0].start_date, legacy.experience[0].end_date) == ("Oct 2025", "May 2026")
    assert (legacy.education[0].start_date, legacy.education[0].end_date) == ("2020", "2024")


def test_skills_absorb_every_technology_group():
    profile = build_profile(FULL_RESPONSE)
    assert profile.skills == ["Python", "Go", "AWS"]


def test_coursework_is_split_even_when_comma_joined():
    """Models return coursework as one comma-joined string despite the prompt."""
    profile = build_profile({"education": [{"school": "X", "coursework": ["Algorithms, OS"]}]})
    assert profile.education[0].coursework == ["Algorithms", "OS"]


def test_section_order_keeps_the_file_order_and_appends_the_rest():
    profile = build_profile(FULL_RESPONSE)
    order = profile.section_order

    assert order[:4] == ["summary", "projects", "experience", "education"]
    # The model listed only one custom section; the other two are still ordered.
    custom_ids = {f"custom:{c.id}" for c in profile.custom_sections}
    assert custom_ids <= set(order)
    assert "technologies" in order  # present but unlisted by the model


def test_section_order_never_names_an_empty_section():
    profile = build_profile({"experience": [], "section_order": ["experience", "projects"]})
    assert profile.section_order == []


@pytest.mark.parametrize("payload", [None, [], "nope", {}, {"experience": "not a list"}])
def test_extraction_degrades_instead_of_raising(payload):
    """A 90%-parsed resume beats a 500."""
    profile = build_profile(payload)
    assert isinstance(profile, ResumeProfile)
    assert profile.experience == []


def test_document_round_trip_is_identity():
    """profile → document → profile must not lose or reshape anything."""
    profile = build_profile(FULL_RESPONSE)
    restored = document_to_profile(db_record_to_document(profile), profile)
    assert restored.model_dump() == profile.model_dump()


def test_document_emits_every_section_in_stored_order():
    profile = build_profile(FULL_RESPONSE)
    doc = db_record_to_document(profile)

    assert [s.id for s in doc.sections][:4] == ["summary", "projects", "experience", "education"]
    assert {s.type for s in doc.sections} >= {"summary", "projects", "certifications", "custom"}
    # A flat-bullet custom section becomes one untitled item so the renderer,
    # the PDF, and the rewriter all see the same shape.
    awards = next(s for s in doc.sections if s.title == "AWARDS")
    assert awards.items[0].bullets == ["Hackathon winner"]


def test_document_survives_a_stale_section_order():
    profile = build_profile(FULL_RESPONSE)
    profile.section_order = ["experience", "does-not-exist"]
    doc = db_record_to_document(profile)

    ids = [s.id for s in doc.sections]
    assert ids[0] == "experience"
    assert "projects" in ids and "summary" in ids  # nothing dropped


# ── Analysis report ─────────────────────────────────────────────────────────

REPORT_RESPONSE = {
    "overall_grade": "GOOD",
    "letter_grade": "B+",
    "score": 76,
    "summary": "Your resume reads as an early-career developer.",
    "strengths": ["Broad technical stack", ""],
    "highlights": ["Bullets lack metrics"],
    "categories": [
        {
            "id": "impact", "name": "Impact & Achievements", "score": 60,
            "why_it_matters": "Outcomes decide callbacks.",
            "issues": [
                {"title": "Duty-only bullets", "severity": "urgent", "count": 3,
                 "description": "d", "evidence": ["Responsible for testing"],
                 "suggestion": "Cut regression time from [X] to [Y].", "section": "Work Experience"},
                {"title": "Unverifiable figure", "severity": "critical", "count": 1,
                 "evidence": ["Improved efficiency by 75%"], "section": "Work Experience"},
            ],
        },
        {
            "id": "ats", "name": "ATS & Formatting", "score": 95,
            "issues": [{"title": "Add a portfolio link", "severity": "optional", "count": 2}],
        },
    ],
}


def test_report_counts_are_recomputed_from_the_issues():
    """Headline numbers can never disagree with the list beneath them."""
    report = build_analysis_report(REPORT_RESPONSE)
    assert report.urgent_fix_count == 3
    assert report.critical_fix_count == 1
    assert report.optional_fix_count == 2


def test_report_ranks_worst_category_first_and_issues_by_severity():
    report = build_analysis_report(REPORT_RESPONSE)
    assert [c.id for c in report.categories] == ["impact", "ats"]
    assert [i.severity for i in report.categories[0].issues] == ["urgent", "critical"]


def test_report_fills_grade_and_timestamp_and_drops_blank_strengths():
    report = build_analysis_report(REPORT_RESPONSE)
    assert report.letter_grade == "B+"
    assert report.overall_grade == "GOOD"
    assert report.strengths == ["Broad technical stack"]
    assert isinstance(report.analyzed_at, datetime.datetime)


def test_report_derives_grade_when_the_model_omits_it():
    report = build_analysis_report({"score": 88, "summary": "s", "categories": []})
    assert report.letter_grade == "A"
    assert report.overall_grade == "EXCELLENT"


def test_report_falls_back_to_model_counts_without_categories():
    """An older, category-less response still renders."""
    report = build_analysis_report({
        "overall_grade": "FAIR", "urgent_fix_count": 5, "critical_fix_count": 1,
        "optional_fix_count": 0, "summary": "s", "highlights": ["h"],
    })
    assert (report.urgent_fix_count, report.critical_fix_count) == (5, 1)
    assert report.highlights == ["h"]


def test_report_degrades_instead_of_raising():
    report = build_analysis_report("garbage")
    assert report.overall_grade == "FAIR"
    assert report.categories == []


# ── Service wiring ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_analyze_resume_maps_the_full_model_response(monkeypatch):
    """The end of the bug: the service used to read 8 of these keys."""
    import json
    from unittest.mock import AsyncMock

    from backend.services.openai_service import OpenAIService

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    service = OpenAIService()
    monkeypatch.setattr(service, "_generate", AsyncMock(return_value=json.dumps(FULL_RESPONSE)))

    profile = await service.analyze_resume("irrelevant, the model is stubbed")

    assert [p.name for p in profile.projects] == ["Tailrd"]
    assert profile.technologies["Cloud"] == ["AWS"]
    assert profile.github_url == "https://github.com/WisHonor"
    assert profile.experience[0].start_date == "Oct 2025"
    assert len(profile.custom_sections) == 3


@pytest.mark.parametrize(
    "filename, placeholders",
    [
        ("analyze_resume.txt", ["{{RESUME_TEXT}}"]),
        ("analyze_resume_quality.txt", ["{{RESUME_TEXT}}", "{{METRICS}}"]),
        ("improve_resume.txt", ["{{RESUME_JSON}}", "{{FINDINGS}}"]),
        ("tailor_resume.txt", ["{{RESUME_TEXT}}", "{{JOB_DESCRIPTION}}"]),
        ("tailor_resume_guided.txt",
         ["{{RESUME_TEXT}}", "{{JOB_DESCRIPTION}}", "{{FOCUS}}"]),
        ("tailor_resume_structured.txt",
         ["{{RESUME_JSON}}", "{{JOB_DESCRIPTION}}", "{{EMPHASIS}}"]),
    ],
)
def test_prompt_templates_declare_the_placeholders_the_service_substitutes(filename, placeholders):
    """A renamed placeholder would ship a prompt with a literal {{TOKEN}} in it."""
    from backend.services.openai_service import _load_prompt

    template = _load_prompt(filename)
    for placeholder in placeholders:
        assert placeholder in template, f"{filename} is missing {placeholder}"
