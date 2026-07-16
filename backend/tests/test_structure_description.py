"""structure-description: mini-model routing + description_sections caching."""

import json

from backend.db.models import ScrapedJob


def _mk_job(db_session, url="https://x.test/sd-1", description=None):
    row = ScrapedJob(
        title="EPM Consultant", company="Acme", url=url,
        location="Ottawa, ON, CA", country="CA", work_type="onsite",
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0,
        description=description or (
            "Responsibilities:\n- Support EPM applications\n- Build planning models\n"
            "Requirements:\n- 3-5 years experience\n- Excel proficiency\n"
        ),
    )
    db_session.add(row)
    db_session.commit()
    return row


STRUCT = {
    "sections": [{"title": "Responsibilities", "icon": "clipboard-list",
                  "items": ["Support EPM applications"]}],
    "skills": ["Excel", "EPM"],
    "experience_years": "3-5",
    "education": "",
}


def test_structure_calls_mini_model_json_mode_and_caches(client, db_session, monkeypatch):
    job = _mk_job(db_session)
    seen = {}

    async def fake_generate(self, prompt, model=None, json_mode=False, **kwargs):
        seen["model"] = model
        seen["json_mode"] = json_mode
        return json.dumps(STRUCT)

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", fake_generate
    )
    res = client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200, res.text
    assert seen == {"model": "gpt-4o-mini", "json_mode": True}
    assert res.json()["skills"] == ["Excel", "EPM"]
    db_session.refresh(job)
    assert job.description_sections["skills"] == ["Excel", "EPM"]


def test_structure_served_from_cache_without_llm(client, db_session, monkeypatch):
    job = _mk_job(db_session, url="https://x.test/sd-2")
    job.description_sections = STRUCT
    db_session.commit()

    async def boom(self, *args, **kwargs):
        raise AssertionError("LLM must not be called on cache hit")

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", boom
    )
    res = client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200, res.text
    assert res.json()["sections"][0]["title"] == "Responsibilities"


def test_structure_migrates_legacy_company_description_cache(client, db_session, monkeypatch):
    job = _mk_job(db_session, url="https://x.test/sd-3")
    job.company_description = json.dumps(STRUCT)
    db_session.commit()

    async def boom(self, *args, **kwargs):
        raise AssertionError("LLM must not be called on legacy cache hit")

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", boom
    )
    res = client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200, res.text
    db_session.refresh(job)
    assert job.description_sections["skills"] == ["Excel", "EPM"]
