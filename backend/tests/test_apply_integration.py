"""
Integration tests for the apply flow.

Tests the full apply lifecycle:
- Initiate → get profile → progress update → complete
- Resume version selection (tailored vs original)
- Progress updates and completion

Requirements: 6.1, 6.5, 6.7
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import (
    ScrapedJob, JobStatus, UserSettings, ResumeProfileDB,
    TailoredResume, ApplicationRecord,
)
from backend.routers import apply as apply_module
from backend.routers.apply import router as apply_router
from backend.auth.dependencies import get_current_user_id

# Create a test-specific app with only the apply router
TEST_DATABASE_URL = "sqlite:///./test_apply_integration.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

apply_app = FastAPI()
apply_app.include_router(apply_router, prefix="/apply", tags=["apply"])


@pytest.fixture(autouse=True)
def setup_test_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)
    # Clear in-memory sessions between tests
    apply_module._sessions.clear()


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
    """FastAPI test client with overridden DB and auth dependencies."""
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    async def _override_get_user_id():
        return TEST_USER_ID

    apply_app.dependency_overrides[get_db] = _override_get_db
    apply_app.dependency_overrides[get_current_user_id] = _override_get_user_id
    with TestClient(apply_app) as c:
        yield c
    apply_app.dependency_overrides.clear()


@pytest.fixture
def seed_data(db_session):
    """Create a job, user settings, and resume profile in the DB."""
    job = ScrapedJob(
        title="Senior Backend Engineer",
        company="Acme Corp",
        url="https://acme.com/jobs/123",
        description="Build scalable APIs",
        platform="linkedin",
    )
    db_session.add(job)

    settings = UserSettings(
        user_id=TEST_USER_ID,
        first_name="Fahad",
        last_name="Aba-Alkhail",
        email="fahadabraar@gmail.com",
        phone="6133168025",
        city="Ottawa",
        linkedin_url="https://linkedin.com/in/fahad",
        website="https://fahad.dev",
        prefilled_answers={"Are you authorized to work?": "Yes"},
    )
    db_session.add(settings)

    profile = ResumeProfileDB(
        user_id=TEST_USER_ID,
        profile_name="Fahad Aba-Alkhail",
        email="fahadabraar@gmail.com",
        raw_text="Experienced backend engineer with 5 years of Python and FastAPI.",
        skills=["Python", "FastAPI", "PostgreSQL"],
        experience=[{"company": "PrevCo", "role": "SWE", "years": 3}],
        education=[{"school": "University of Ottawa", "degree": "BSc CS"}],
    )
    db_session.add(profile)

    db_session.commit()
    db_session.refresh(job)
    return {"job": job, "settings": settings, "profile": profile}


class TestFullApplyFlow:
    """Test the complete apply lifecycle: initiate → profile → progress → complete."""

    def test_full_flow_original_resume(self, client, db_session, seed_data):
        """
        Full apply flow with original resume:
        1. POST /apply/initiate → session created, job status = "applying"
        2. GET /apply/{session_id}/profile → profile data returned
        3. POST /apply/{session_id}/progress → accepted
        4. POST /apply/{session_id}/complete → job status = "applied", record created

        Requirements: 6.1, 6.5
        """
        job = seed_data["job"]

        # Step 1: Initiate apply flow
        response = client.post("/apply/initiate", json={"job_id": job.id})
        assert response.status_code == 200
        data = response.json()
        session_id = data["session_id"]
        assert data["job_id"] == job.id
        assert data["resume_version"] == "original"
        assert data["cover_letter_ready"] is False

        # Verify job status changed to "applying"
        db_session.refresh(job)
        assert job.status == JobStatus.APPLYING

        # Step 2: Get fill profile
        response = client.get(f"/apply/{session_id}/profile")
        assert response.status_code == 200
        profile = response.json()
        assert profile["first_name"] == "Fahad"
        assert profile["last_name"] == "Aba-Alkhail"
        assert profile["email"] == "fahadabraar@gmail.com"
        assert profile["phone"] == "6133168025"
        assert profile["location"] == "Ottawa"
        assert profile["linkedin_url"] == "https://linkedin.com/in/fahad"
        assert profile["website"] == "https://fahad.dev"
        assert profile["skills"] == ["Python", "FastAPI", "PostgreSQL"]
        assert profile["resume_text"] == "Experienced backend engineer with 5 years of Python and FastAPI."
        assert profile["prefilled_answers"] == {"Are you authorized to work?": "Yes"}

        # Step 3: Send progress update
        progress_payload = {
            "total_fields": 10,
            "filled_fields": 5,
            "percentage": 50,
            "current_field": "phone",
            "status": "filling",
        }
        response = client.post(f"/apply/{session_id}/progress", json=progress_payload)
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

        # Step 4: Complete the application
        response = client.post(f"/apply/{session_id}/complete")
        assert response.status_code == 200
        result = response.json()
        assert result["status"] == "applied"
        assert result["job_id"] == job.id

        # Verify job status changed to "applied"
        db_session.refresh(job)
        assert job.status == JobStatus.APPLIED

        # Verify ApplicationRecord was created
        record = db_session.query(ApplicationRecord).filter(
            ApplicationRecord.job_id == job.id
        ).first()
        assert record is not None
        assert record.company == "Acme Corp"
        assert record.role == "Senior Backend Engineer"
        assert record.resume_version == "original"
        assert record.url == "https://acme.com/jobs/123"


class TestResumeVersionSelection:
    """Test that tailored resume is used when available."""

    def test_tailored_resume_used_when_accepted(self, client, db_session, seed_data):
        """
        When a tailored resume with status="accepted" exists,
        the profile endpoint returns the tailored text.

        Requirements: 6.7
        """
        job = seed_data["job"]

        # Add a tailored resume for this job
        tailored = TailoredResume(
            user_id=TEST_USER_ID,
            job_id=job.id,
            original_text="Original resume text",
            tailored_text="Tailored resume emphasizing API design and scalability.",
            diff_summary="Added emphasis on API design",
            status="accepted",
        )
        db_session.add(tailored)
        db_session.commit()

        # Initiate apply flow
        response = client.post("/apply/initiate", json={"job_id": job.id})
        assert response.status_code == 200
        data = response.json()
        session_id = data["session_id"]
        assert data["resume_version"] == "tailored"

        # Get profile - should have tailored text
        response = client.get(f"/apply/{session_id}/profile")
        assert response.status_code == 200
        profile = response.json()
        assert profile["resume_text"] == "Tailored resume emphasizing API design and scalability."

    def test_original_resume_used_when_no_tailored(self, client, db_session, seed_data):
        """
        When no tailored resume exists, the profile endpoint
        returns the original resume text.

        Requirements: 6.7
        """
        job = seed_data["job"]

        # Initiate apply flow (no tailored resume exists)
        response = client.post("/apply/initiate", json={"job_id": job.id})
        assert response.status_code == 200
        data = response.json()
        session_id = data["session_id"]
        assert data["resume_version"] == "original"

        # Get profile - should have original text
        response = client.get(f"/apply/{session_id}/profile")
        assert response.status_code == 200
        profile = response.json()
        assert profile["resume_text"] == "Experienced backend engineer with 5 years of Python and FastAPI."

    def test_draft_tailored_resume_not_used(self, client, db_session, seed_data):
        """
        A tailored resume with status="draft" should NOT be used.
        Only "accepted" tailored resumes are selected.

        Requirements: 6.7
        """
        job = seed_data["job"]

        # Add a tailored resume with draft status
        tailored = TailoredResume(
            user_id=TEST_USER_ID,
            job_id=job.id,
            original_text="Original resume text",
            tailored_text="Draft tailored text that should not be used.",
            diff_summary="Draft changes",
            status="draft",
        )
        db_session.add(tailored)
        db_session.commit()

        # Initiate apply flow
        response = client.post("/apply/initiate", json={"job_id": job.id})
        assert response.status_code == 200
        data = response.json()
        assert data["resume_version"] == "original"

        session_id = data["session_id"]
        response = client.get(f"/apply/{session_id}/profile")
        assert response.status_code == 200
        profile = response.json()
        # Should use original, not the draft tailored version
        assert profile["resume_text"] == "Experienced backend engineer with 5 years of Python and FastAPI."


class TestProgressUpdates:
    """Test progress update handling during apply flow."""

    def test_multiple_progress_updates(self, client, db_session, seed_data):
        """
        Multiple progress updates should be accepted during a session.

        Requirements: 6.5
        """
        job = seed_data["job"]

        # Initiate
        response = client.post("/apply/initiate", json={"job_id": job.id})
        session_id = response.json()["session_id"]

        # Send multiple progress updates
        updates = [
            {"total_fields": 10, "filled_fields": 2, "percentage": 20, "current_field": "name", "status": "filling"},
            {"total_fields": 10, "filled_fields": 5, "percentage": 50, "current_field": "email", "status": "filling"},
            {"total_fields": 10, "filled_fields": 8, "percentage": 80, "current_field": "experience", "status": "filling"},
            {"total_fields": 10, "filled_fields": 10, "percentage": 100, "current_field": "", "status": "complete"},
        ]

        for update in updates:
            response = client.post(f"/apply/{session_id}/progress", json=update)
            assert response.status_code == 200
            assert response.json()["status"] == "ok"

    def test_progress_update_invalid_session(self, client):
        """Progress update with invalid session returns 404."""
        progress_payload = {
            "total_fields": 10,
            "filled_fields": 5,
            "percentage": 50,
            "current_field": "phone",
            "status": "filling",
        }
        response = client.post("/apply/nonexistent-session/progress", json=progress_payload)
        assert response.status_code == 404


class TestErrorCases:
    """Test error handling in the apply flow."""

    def test_initiate_nonexistent_job(self, client):
        """Initiating apply for a non-existent job returns 404."""
        response = client.post("/apply/initiate", json={"job_id": 9999})
        assert response.status_code == 404
        assert "Job not found" in response.json()["detail"]

    def test_profile_invalid_session(self, client):
        """Getting profile for invalid session returns 404."""
        response = client.get("/apply/nonexistent-session/profile")
        assert response.status_code == 404

    def test_complete_invalid_session(self, client):
        """Completing an invalid session returns 404."""
        response = client.post("/apply/nonexistent-session/complete")
        assert response.status_code == 404

    def test_profile_without_user_settings(self, client, db_session):
        """Getting profile when no user settings exist returns 400."""
        # Create a job but no user settings
        job = ScrapedJob(
            title="Engineer",
            company="TestCo",
            url="https://test.com/job/1",
            description="Test",
        )
        db_session.add(job)
        db_session.commit()
        db_session.refresh(job)

        # Initiate
        response = client.post("/apply/initiate", json={"job_id": job.id})
        session_id = response.json()["session_id"]

        # Get profile without settings
        response = client.get(f"/apply/{session_id}/profile")
        assert response.status_code == 400
        assert "User settings not configured" in response.json()["detail"]
