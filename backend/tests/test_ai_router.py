"""
Unit tests for the AI router endpoints.

Tests cover:
- 404 for non-existent jobs on all endpoints
- 400 when no resume profile exists
- 503 when AI is unreachable

Requirements: 3.7
"""

from unittest.mock import patch, AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob, ResumeProfileDB
from backend.routers import ai

# Create a test-specific app with only the AI router (avoids production lifespan issues)
TEST_DATABASE_URL = "sqlite:///./test_ai_router.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

ai_app = FastAPI()
ai_app.include_router(ai.router, prefix="/ai", tags=["ai"])


@pytest.fixture(autouse=True)
def setup_test_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db_session():
    """Yield a test DB session."""
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db_session):
    """FastAPI test client with overridden DB dependency."""
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    ai_app.dependency_overrides[get_db] = _override_get_db
    with TestClient(ai_app) as c:
        yield c
    ai_app.dependency_overrides.clear()


class TestMatchBreakdown:
    """Tests for POST /ai/match-breakdown/{job_id}."""

    def test_returns_404_for_nonexistent_job(self, client):
        """Non-existent job_id should return 404."""
        response = client.post("/ai/match-breakdown/9999")
        assert response.status_code == 404
        assert "Job not found" in response.json()["detail"]

    def test_returns_400_when_no_resume_profile(self, client, db_session):
        """Should return 400 when no resume profile exists."""
        # Create a job but no resume profile
        job = ScrapedJob(
            title="Software Engineer",
            company="TestCo",
            url="https://example.com/job/1",
            description="Build things",
        )
        db_session.add(job)
        db_session.commit()
        db_session.refresh(job)

        response = client.post(f"/ai/match-breakdown/{job.id}")
        assert response.status_code == 400
        assert "No resume profile found" in response.json()["detail"]

    def test_returns_503_when_ai_unreachable(self, client, db_session):
        """Should return 503 when AI service is unreachable."""
        # Create job and resume profile
        job = ScrapedJob(
            title="Software Engineer",
            company="TestCo",
            url="https://example.com/job/2",
            description="Build things",
        )
        db_session.add(job)

        profile = ResumeProfileDB(
            profile_name="Test User",
            email="test@example.com",
            raw_text="Experienced software engineer with 5 years...",
        )
        db_session.add(profile)
        db_session.commit()
        db_session.refresh(job)

        with patch(
            "backend.routers.ai.MatchEngine.compute_breakdown",
            new_callable=AsyncMock,
            side_effect=httpx.ConnectError("Connection refused"),
        ):
            response = client.post(f"/ai/match-breakdown/{job.id}")
            assert response.status_code == 503
            assert "AI service unavailable" in response.json()["detail"]


class TestCoverLetter:
    """Tests for POST /ai/cover-letter/{job_id}."""

    def test_returns_404_for_nonexistent_job(self, client):
        """Non-existent job_id should return 404."""
        response = client.post("/ai/cover-letter/9999")
        assert response.status_code == 404
        assert "Job not found" in response.json()["detail"]


class TestTailorResume:
    """Tests for POST /ai/tailor-resume/{job_id}."""

    def test_returns_404_for_nonexistent_job(self, client):
        """Non-existent job_id should return 404."""
        response = client.post("/ai/tailor-resume/9999")
        assert response.status_code == 404
        assert "Job not found" in response.json()["detail"]


class TestAnalyzeFit:
    """Tests for POST /ai/analyze-fit/{job_id}."""

    def test_returns_404_for_nonexistent_job(self, client):
        """Non-existent job_id should return 404."""
        response = client.post("/ai/analyze-fit/9999")
        assert response.status_code == 404
        assert "Job not found" in response.json()["detail"]
