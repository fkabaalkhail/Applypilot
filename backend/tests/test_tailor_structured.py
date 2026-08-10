import json

import pytest

from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.openai_service import OpenAIService, TailorStructuredResult


def _doc():
    return ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Responsible for APIs"])]),
        Section(id="prj", type="projects", title="PROJECTS",
                items=[SectionItem(id="p1", title="Proj", bullets=["Built a thing"])]),
    ])


@pytest.mark.asyncio
async def test_parses_wrapped_contract_and_reorders(monkeypatch):
    svc = OpenAIService.__new__(OpenAIService)  # skip __init__ (no API key needed)
    payload = {
        "resume": {"header": {}, "sections": [
            {"id": "exp", "type": "experience", "title": "WORK EXPERIENCE",
             "items": [{"id": "i1", "title": "Engineer", "subtitle": "Acme", "bullets": ["Built and scaled REST APIs"]}]},
            {"id": "prj", "type": "projects", "title": "PROJECTS",
             "items": [{"id": "p1", "title": "Proj", "bullets": ["Built a thing"]}]},
        ]},
        "section_order": ["prj", "exp"],
        "new_summary": {"title": "PROFESSIONAL SUMMARY", "text": "Backend engineer."},
        "gaps": ["Role wants Kubernetes; not found in your experience"],
    }

    async def fake_generate(prompt, system=None, **kwargs):
        return json.dumps(payload)
    monkeypatch.setattr(svc, "_generate", fake_generate)

    out = await svc.tailor_resume_structured(_doc(), "Kubernetes backend role")
    assert isinstance(out, TailorStructuredResult)

    sections = out.document.sections
    assert sections[0].type == "summary"                       # summary prepended
    non_summary = [s.id for s in sections if s.type != "summary"]
    assert non_summary == ["prj", "exp"]                       # reordered by section_order

    by_id = {s.id: s for s in sections}
    assert by_id["exp"].items[0].bullets == ["Built and scaled REST APIs"]  # bullets reworded
    assert by_id["exp"].items[0].subtitle == "Acme"            # employer locked
    assert by_id["prj"].items[0].bullets == ["Built a thing"]  # unchanged
    assert out.gaps == ["Role wants Kubernetes; not found in your experience"]


@pytest.mark.asyncio
async def test_accepts_bare_document_for_back_compat(monkeypatch):
    svc = OpenAIService.__new__(OpenAIService)
    bare = {"header": {}, "sections": [
        {"id": "exp", "type": "experience", "title": "WORK EXPERIENCE",
         "items": [{"id": "i1", "title": "Engineer", "subtitle": "Acme", "bullets": ["Shipped the API"]}]},
        {"id": "prj", "type": "projects", "title": "PROJECTS",
         "items": [{"id": "p1", "title": "Proj", "bullets": ["Built a thing"]}]},
    ]}

    async def fake_generate(prompt, system=None, **kwargs):
        return json.dumps(bare)
    monkeypatch.setattr(svc, "_generate", fake_generate)

    out = await svc.tailor_resume_structured(_doc(), "jd")
    by_id = {s.id: s for s in out.document.sections}
    assert by_id["exp"].items[0].bullets == ["Shipped the API"]
    assert out.gaps == []


@pytest.mark.asyncio
async def test_parse_failure_falls_back_to_original(monkeypatch):
    svc = OpenAIService.__new__(OpenAIService)

    async def fake_generate(prompt, system=None, **kwargs):
        return "not json"
    monkeypatch.setattr(svc, "_generate", fake_generate)

    doc = _doc()
    out = await svc.tailor_resume_structured(doc, "jd")
    assert out.document == doc and out.gaps == []
