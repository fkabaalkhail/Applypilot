"""Endpoint tests for the extension's /api/tailor-resume + /api/render-resume."""
import base64
from unittest.mock import patch, AsyncMock

from backend.db.models import ResumeProfileDB

TEST_USER_ID = 1

BEFORE = ('{"overall_score":60,"ats_score":55,"matched_keywords":["Python"],'
          '"missing_keywords":["AWS","TypeScript"]}')
EDITED = '{"sections":[{"type":"skills","skills":["Python","AWS","TypeScript"]}]}'
AFTER = ('{"overall_score":80,"ats_score":78,"matched_keywords":["Python","AWS","TypeScript"],'
         '"missing_keywords":[]}')


def _seed_resume(db):
    db.add(ResumeProfileDB(
        user_id=TEST_USER_ID, profile_name="Jane Doe", is_primary=1,
        skills=["Python"],
        experience=[{"title": "Engineer", "company": "Acme", "start_date": "2020",
                     "end_date": "2023", "bullets": ["Built tools"]}],
        raw_text="Python engineer.",
    ))
    db.commit()


class TestTailorResume:
    def test_auto_weaves_all_missing_keywords(self, client, db_session, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.anthropic_service.AnthropicService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python, AWS and TypeScript.",
            })
        assert resp.status_code == 200
        data = resp.json()
        assert data["original_overall_score"] == 60
        assert data["new_overall_score"] == 80
        assert data["new_ats_score"] == 78
        # chip set is the BEFORE candidate set (stable across regenerates)
        assert data["missing_keywords"] == ["AWS", "TypeScript"]
        assert data["document"]["sections"][0]["skills"] == ["Python", "AWS", "TypeScript"]
        # omitted add_keywords -> all missing keywords woven into the tailor prompt
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "weave in these keywords: AWS, TypeScript." in tailor_prompt

    def test_explicit_keywords_used_exactly(self, client, db_session, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.anthropic_service.AnthropicService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "JD", "add_keywords": ["AWS"],
            })
        assert resp.status_code == 200
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "weave in these keywords: AWS." in tailor_prompt

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        resp = client.post("/api/tailor-resume", json={"job_description": "JD"})
        assert resp.status_code == 400


class TestRenderResume:
    def test_returns_base64_pdf(self, client):
        doc = {"header": {"name": "Jane Doe"},
               "sections": [{"type": "skills", "title": "SKILLS", "skills": ["Python", "AWS"]}],
               "theme": {}}
        resp = client.post("/api/render-resume", json={"document": doc, "filename": "resume-acme"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["content_type"] == "application/pdf"
        assert data["name"] == "resume-acme.pdf"
        assert base64.b64decode(data["data_base64"])[:5] == b"%PDF-"
