"""
Unit tests for the web "Generate Custom Resume" flow endpoints:
  POST /ai/job-analysis/{job_id}  (Step 1 — keywords + scores)
  POST /ai/rewrite/{job_id}       (Step 3 — tailor + before/after scores)
  POST /ai/cover-letter/{job_id}  (tone option, backward compatible)

The Anthropic call (`AnthropicService._generate`) is mocked, so no network/API key.
"""

from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob, ResumeProfileDB
from backend.auth.dependencies import get_current_user_id, get_verified_user_id
from backend.routers import ai

TEST_DATABASE_URL = "sqlite:///./test_ai_web_flow.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

ai_app = FastAPI()
ai_app.include_router(ai.router, prefix="/ai", tags=["ai"])

ANALYSIS_JSON = """
{
  "overall_score": 68,
  "ats_score": 60,
  "matched_keywords": ["Python", "SQL"],
  "missing_keywords": ["TypeScript", "AWS"],
  "strengths": ["Backend"],
  "weaknesses": ["No cloud"],
  "suggestions": ["Add a cloud project."]
}
"""

ANALYSIS_AFTER_JSON = """
{
  "overall_score": 82,
  "ats_score": 78,
  "matched_keywords": ["Python", "SQL", "TypeScript"],
  "missing_keywords": ["AWS"],
  "strengths": ["Backend"],
  "weaknesses": [],
  "suggestions": []
}
"""

# What the structured tailor LLM call returns: same shape, rewritten bullets +
# an added skill. Most fields are omitted and fall back to schema defaults; the
# merge re-attaches the original structure/facts, so only content is adopted.
EDITED_DOC_JSON = (
    '{"sections": ['
    '{"type": "experience", "items": [{"bullets": ["Built internal tools used by 500+ employees"]}]},'
    '{"type": "skills", "skills": ["Python", "SQL", "TypeScript"]}'
    ']}'
)


@pytest.fixture(autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _anthropic_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


@pytest.fixture
def db_session():
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db_session):
    def _get_db():
        try:
            yield db_session
        finally:
            pass

    async def _user():
        return TEST_USER_ID

    ai_app.dependency_overrides[get_db] = _get_db
    ai_app.dependency_overrides[get_current_user_id] = _user
    ai_app.dependency_overrides[get_verified_user_id] = _user
    with TestClient(ai_app) as c:
        yield c
    ai_app.dependency_overrides.clear()


def _seed(db_session, with_resume=True):
    job = ScrapedJob(
        title="Software Engineer",
        company="TestCo",
        url="https://example.com/job/1",
        description="We need Python, SQL, TypeScript and AWS.",
    )
    db_session.add(job)
    if with_resume:
        db_session.add(
            ResumeProfileDB(
                user_id=TEST_USER_ID,
                profile_name="Test User",
                is_primary=1,
                skills=["Python", "SQL"],
                experience=[
                    {
                        "title": "Software Engineer",
                        "company": "Acme",
                        "location": "NYC",
                        "start_date": "2020",
                        "end_date": "2023",
                        "bullets": ["Built internal tools"],
                    }
                ],
                raw_text="Python and SQL engineer.",
            )
        )
    db_session.commit()
    db_session.refresh(job)
    return job


class TestJobAnalysis:
    def test_returns_keywords_and_coverage(self, client, db_session):
        job = _seed(db_session)
        with patch(
            "backend.services.anthropic_service.AnthropicService._generate",
            new_callable=AsyncMock,
            return_value=ANALYSIS_JSON,
        ):
            resp = client.post(f"/ai/job-analysis/{job.id}", json={})
        assert resp.status_code == 200
        data = resp.json()
        assert data["overall_score"] == 68
        assert data["ats_score"] == 60
        assert data["match_label"] == "GOOD MATCH"
        assert data["matched_keywords"] == ["Python", "SQL"]
        assert data["missing_keywords"] == ["TypeScript", "AWS"]
        # coverage = round(100 * 2 / 4) = 50
        assert data["keyword_coverage"] == 50

    def test_404_for_missing_job(self, client):
        resp = client.post("/ai/job-analysis/9999", json={})
        assert resp.status_code == 404

    def test_400_when_no_resume(self, client, db_session):
        job = _seed(db_session, with_resume=False)
        with patch(
            "backend.services.anthropic_service.AnthropicService._generate",
            new_callable=AsyncMock,
            return_value=ANALYSIS_JSON,
        ):
            resp = client.post(f"/ai/job-analysis/{job.id}", json={})
        assert resp.status_code == 400


class TestRewrite:
    def test_returns_structured_document_and_before_after_scores(self, client, db_session):
        job = _seed(db_session)
        # 3 LLM calls: analyze(before), structured tailor, analyze(after).
        with patch(
            "backend.services.anthropic_service.AnthropicService._generate",
            new_callable=AsyncMock,
            side_effect=[ANALYSIS_JSON, EDITED_DOC_JSON, ANALYSIS_AFTER_JSON],
        ):
            resp = client.post(
                f"/ai/rewrite/{job.id}",
                json={"sections": ["Skills"], "add_keywords": ["TypeScript"]},
            )
        assert resp.status_code == 200
        data = resp.json()

        # Structured document reflects the AI's bullet rewrite + added skill,
        # merged onto the original structure so facts/sections are preserved.
        sections = data["document"]["sections"]
        assert sections[0]["type"] == "experience"
        assert sections[0]["items"][0]["bullets"] == ["Built internal tools used by 500+ employees"]
        assert sections[0]["items"][0]["title"] == "Software Engineer"  # fact preserved
        assert sections[1]["skills"] == ["Python", "SQL", "TypeScript"]

        # Flattened text (for Copy) + before/after scores still provided.
        assert "Built internal tools used by 500+ employees" in data["tailored_text"]
        assert data["original_document"]["sections"][0]["items"][0]["title"] == "Software Engineer"
        assert data["diff_summary"]  # non-empty unified diff
        assert data["original_overall_score"] == 68
        assert data["new_overall_score"] == 82
        assert data["new_ats_score"] == 78
        assert data["version_id"] is not None


class TestCoverLetterTone:
    def test_tone_path_passes_through(self, client, db_session):
        job = _seed(db_session)
        mock = AsyncMock(return_value="Dear Hiring Team, ...")
        with patch("backend.services.anthropic_service.AnthropicService._generate", mock):
            resp = client.post(
                f"/ai/cover-letter/{job.id}", json={"tone": "enthusiastic"}
            )
        assert resp.status_code == 200
        assert resp.json()["text"].startswith("Dear Hiring Team")

    def test_no_body_still_works(self, client, db_session):
        job = _seed(db_session)
        with patch(
            "backend.services.anthropic_service.AnthropicService._generate",
            new_callable=AsyncMock,
            return_value="A letter.",
        ):
            resp = client.post(f"/ai/cover-letter/{job.id}")
        assert resp.status_code == 200
        assert resp.json()["text"] == "A letter."


class TestResumeVersions:
    DOC = {
        "header": {"name": "Jane Doe"},
        "sections": [{"type": "skills", "title": "SKILLS", "skills": ["Python", "AWS"]}],
        "theme": {},
    }

    def test_save_list_get_roundtrip(self, client, db_session):
        job = _seed(db_session)
        resume = db_session.query(ResumeProfileDB).first()

        save = client.post(
            "/ai/resume-versions",
            json={"resume_id": resume.id, "job_id": job.id, "source": "user", "label": "My edits", "document": self.DOC},
        )
        assert save.status_code == 200
        body = save.json()
        vid = body["id"]
        assert body["source"] == "user"
        assert body["document"]["sections"][0]["skills"] == ["Python", "AWS"]

        lst = client.get("/ai/resume-versions", params={"job_id": job.id})
        assert lst.status_code == 200
        assert any(v["id"] == vid for v in lst.json())

        got = client.get(f"/ai/resume-versions/{vid}")
        assert got.status_code == 200
        assert got.json()["document"]["header"]["name"] == "Jane Doe"

    def test_get_missing_returns_404(self, client):
        assert client.get("/ai/resume-versions/99999").status_code == 404


class TestEditSnippet:
    def test_edits_only_the_snippet(self, client, db_session):
        job = _seed(db_session)
        with patch(
            "backend.services.anthropic_service.AnthropicService._generate",
            new_callable=AsyncMock,
            return_value="Architected scalable APIs serving 1M requests/day.",
        ):
            resp = client.post("/ai/edit-snippet", json={"text": "built apis", "action": "impact", "job_id": job.id})
        assert resp.status_code == 200
        assert resp.json()["text"] == "Architected scalable APIs serving 1M requests/day."

    def test_empty_text_returns_422(self, client):
        assert client.post("/ai/edit-snippet", json={"text": "  ", "action": "rewrite"}).status_code == 422
