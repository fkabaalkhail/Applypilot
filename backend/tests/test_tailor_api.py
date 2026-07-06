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
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
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
        # omitted add_keywords -> all missing keywords surfaced in the tailor prompt
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "surface these job terms: AWS, TypeScript." in tailor_prompt

    def test_explicit_keywords_used_exactly(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "JD", "add_keywords": ["AWS"],
            })
        assert resp.status_code == 200
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "surface these job terms: AWS." in tailor_prompt
        assert resp.json()["missing_keywords"] == ["AWS", "TypeScript"]

    def test_explicit_empty_keywords_skip_weaving(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "JD", "add_keywords": [],
            })
        assert resp.status_code == 200
        tailor_prompt = gen.call_args_list[1].args[0]
        assert "surface these job terms:" not in tailor_prompt

    def test_wrapped_contract_surfaces_gaps_changes_and_figures(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        wrapped = (
            '{"resume":{"sections":['
            '{"type":"experience","items":[{"bullets":["Owned billing; cut costs 45%"]}]},'
            '{"type":"skills","skills":["Python","AWS"]}'
            ']},"section_order":[],"new_summary":null,'
            '"gaps":["Role wants Kubernetes; not shown"]}'
        )
        gen = AsyncMock(side_effect=[BEFORE, wrapped, AFTER])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "Kubernetes role",
            })
        assert resp.status_code == 200
        data = resp.json()
        assert data["gaps"] == ["Role wants Kubernetes; not shown"]
        assert data["figures_to_verify"] == ["45%"]        # 45% absent from source → flagged
        assert any("entr" in c.lower() or "skill" in c.lower() for c in data["changes"])

    def test_503_on_llm_connection_error(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        import httpx
        gen = AsyncMock(side_effect=httpx.ConnectError("boom"))
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/tailor-resume", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 503

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        resp = client.post("/api/tailor-resume", json={"job_description": "JD"})
        assert resp.status_code == 400


ANALYSIS = ('{"overall_score":72,"ats_score":68,"match_label":"GOOD MATCH",'
            '"matched_keywords":["Python"],"missing_keywords":["AWS"],'
            '"strengths":["Ships fast"],"weaknesses":["No cloud"],'
            '"suggestions":["Add AWS projects"]}')


class TestCustomResumeAnalysis:
    def test_returns_job_analysis(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[ANALYSIS])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/custom-resume-analysis", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python and AWS.",
            })
        assert resp.status_code == 200
        data = resp.json()
        assert data["overall_score"] == 72
        assert data["ats_score"] == 68
        assert data["matched_keywords"] == ["Python"]
        assert data["missing_keywords"] == ["AWS"]
        assert data["suggestions"] == ["Add AWS projects"]

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        resp = client.post("/api/custom-resume-analysis", json={
            "job_title": "Engineer", "company": "Acme", "job_description": "JD",
        })
        assert resp.status_code == 400


class TestCustomResume:
    def test_returns_rewrite_and_saves_version_with_null_job_id(self, client, db_session, monkeypatch):
        from backend.db.models import ResumeVersion
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=[BEFORE, EDITED, AFTER])
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/custom-resume", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python, AWS and TypeScript.",
                "sections": ["Skills"], "add_keywords": ["AWS"],
            })
        assert resp.status_code == 200
        data = resp.json()
        assert "document" in data and "original_document" in data
        assert data["original_overall_score"] == 60
        assert data["new_overall_score"] == 80
        assert data["version_id"] is not None
        saved = db_session.query(ResumeVersion).filter_by(id=data["version_id"]).one()
        assert saved.job_id is None
        assert saved.source == "ai"
        assert saved.label == "AI · Engineer"

    def test_503_on_llm_connection_error(self, client, db_session, monkeypatch):
        import httpx
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(side_effect=httpx.ConnectError("boom"))
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/custom-resume", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 503

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        resp = client.post("/api/custom-resume", json={"job_description": "JD"})
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

    def test_slugs_pdf_suffixed_filename(self, client):
        doc = {"header": {"name": "Jane"}, "sections": [], "theme": {}}
        resp = client.post("/api/render-resume", json={"document": doc, "filename": "My Resume.pdf"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "my-resume.pdf"

    def test_invalid_theme_returns_422(self, client):
        doc = {"header": {"name": "Jane"}, "sections": [],
               "theme": {"accent_color": "not-a-real-color"}}
        resp = client.post("/api/render-resume", json={"document": doc})
        assert resp.status_code == 422
