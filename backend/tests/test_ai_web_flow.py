"""
Unit tests for the web "Generate Custom Resume" flow endpoints:
  POST /ai/job-analysis/{job_id}  (Step 1 — keywords + scores)
  POST /ai/rewrite/{job_id}       (Step 3 — tailor + before/after scores)
  POST /ai/cover-letter/{job_id}  (tone option, backward compatible)

The Gemini call (`GeminiService._generate`) is mocked, so no network/API key.
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


@pytest.fixture(autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _gemini_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


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
            "backend.services.gemini_service.GeminiService._generate",
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
            "backend.services.gemini_service.GeminiService._generate",
            new_callable=AsyncMock,
            return_value=ANALYSIS_JSON,
        ):
            resp = client.post(f"/ai/job-analysis/{job.id}", json={})
        assert resp.status_code == 400


class TestRewrite:
    def test_returns_tailored_text_and_before_after_scores(self, client, db_session):
        job = _seed(db_session)
        # 3 LLM calls: analyze(before), tailor, analyze(after).
        with patch(
            "backend.services.gemini_service.GeminiService._generate",
            new_callable=AsyncMock,
            side_effect=[ANALYSIS_JSON, "TAILORED RESUME TEXT", ANALYSIS_AFTER_JSON],
        ):
            resp = client.post(
                f"/ai/rewrite/{job.id}",
                json={"sections": ["Skills"], "add_keywords": ["TypeScript"]},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["tailored_text"] == "TAILORED RESUME TEXT"
        assert data["diff_summary"]  # non-empty unified diff
        assert data["original_overall_score"] == 68
        assert data["new_overall_score"] == 82
        assert data["new_ats_score"] == 78


class TestCoverLetterTone:
    def test_tone_path_passes_through(self, client, db_session):
        job = _seed(db_session)
        mock = AsyncMock(return_value="Dear Hiring Team, ...")
        with patch("backend.services.gemini_service.GeminiService._generate", mock):
            resp = client.post(
                f"/ai/cover-letter/{job.id}", json={"tone": "enthusiastic"}
            )
        assert resp.status_code == 200
        assert resp.json()["text"].startswith("Dear Hiring Team")

    def test_no_body_still_works(self, client, db_session):
        job = _seed(db_session)
        with patch(
            "backend.services.gemini_service.GeminiService._generate",
            new_callable=AsyncMock,
            return_value="A letter.",
        ):
            resp = client.post(f"/ai/cover-letter/{job.id}")
        assert resp.status_code == 200
        assert resp.json()["text"] == "A letter."
