"""Endpoint tests for the extension's /api/cover-letter + /api/render-cover-letter."""
import base64
from unittest.mock import patch, AsyncMock

from backend.db.models import CoverLetter, ResumeProfileDB

TEST_USER_ID = 1


def _seed_resume(db):
    db.add(ResumeProfileDB(
        user_id=TEST_USER_ID, profile_name="Jane Doe", is_primary=1,
        skills=["Python"], raw_text="Python engineer with 5 years experience.",
    ))
    db.commit()


class TestGenerateCoverLetter:
    def test_fresh_generate_uses_cover_letter_prompt(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(return_value="Dear Hiring Team at Acme, ...")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme",
                "job_description": "We need Python.",
            })
        assert resp.status_code == 200
        assert resp.json()["text"].startswith("Dear Hiring Team")
        prompt = gen.call_args.args[0]
        assert "Write a professional cover letter" in prompt
        assert "Rewrite the following cover letter" not in prompt

    def test_rewrite_uses_base_text_prompt(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        gen = AsyncMock(return_value="Revised letter ...")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
                "tone": "enthusiastic", "base_text": "My first draft letter.",
            })
        assert resp.status_code == 200
        prompt = gen.call_args.args[0]
        assert "Rewrite the following cover letter" in prompt
        assert "My first draft letter." in prompt

    def test_503_on_llm_connection_error(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        import httpx
        gen = AsyncMock(side_effect=httpx.ConnectError("boom"))
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 503

    def test_400_when_no_resume(self, client, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        resp = client.post("/api/cover-letter", json={"job_description": "JD"})
        assert resp.status_code == 400

    def test_ephemeral_writes_no_cover_letter_row(self, client, db_session, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        _seed_resume(db_session)
        before = db_session.query(CoverLetter).filter(CoverLetter.user_id == TEST_USER_ID).count()
        gen = AsyncMock(return_value="A letter.")
        with patch("backend.services.openai_service.OpenAIService._generate", gen):
            resp = client.post("/api/cover-letter", json={
                "job_title": "Engineer", "company": "Acme", "job_description": "JD",
            })
        assert resp.status_code == 200
        after = db_session.query(CoverLetter).filter(CoverLetter.user_id == TEST_USER_ID).count()
        assert after == before


class TestRenderCoverLetter:
    def test_returns_base64_pdf(self, client):
        resp = client.post("/api/render-cover-letter", json={
            "text": "Dear Hiring Team,\n\nI am excited to apply.\n\nSincerely,\nJane",
            "filename": "cover-letter-acme",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["content_type"] == "application/pdf"
        assert data["name"] == "cover-letter-acme.pdf"
        assert base64.b64decode(data["data_base64"])[:5] == b"%PDF-"

    def test_slugs_pdf_suffixed_filename(self, client):
        resp = client.post("/api/render-cover-letter", json={"text": "Hi", "filename": "My Letter.pdf"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "my-letter.pdf"
