# Feature: job-dashboard-apply, Property 7: Apply Flow Resume Version Selection
"""
Property-based test for apply flow resume version selection.

Property 7: For any apply session, if a tailored resume exists for the target job
(status = "accepted"), the fill profile shall contain the tailored resume text;
otherwise it shall contain the original resume text. The selected version shall
never be empty.

**Validates: Requirements 6.7**
"""

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import (
    ScrapedJob, UserSettings, ResumeProfileDB, TailoredResume,
)
from backend.routers import apply as apply_module
from backend.routers.apply import router as apply_router

# Create a test-specific app with only the apply router
TEST_DATABASE_URL = "sqlite:///./test_apply_properties.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

apply_app = FastAPI()
apply_app.include_router(apply_router, prefix="/apply", tags=["apply"])


# Strategy for generating non-empty resume text
non_empty_text = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z")),
    min_size=5,
    max_size=200,
).filter(lambda s: s.strip() != "")


@pytest.fixture
def setup_test_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)
    # Clear in-memory sessions between tests
    apply_module._sessions.clear()


@pytest.fixture
def db_session(setup_test_db):
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

    apply_app.dependency_overrides[get_db] = _override_get_db
    with TestClient(apply_app) as c:
        yield c
    apply_app.dependency_overrides.clear()


@settings(max_examples=20, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    original_resume_text=non_empty_text,
    tailored_resume_text=non_empty_text,
    has_tailored=st.booleans(),
)
def test_apply_flow_resume_version_selection(
    original_resume_text: str,
    tailored_resume_text: str,
    has_tailored: bool,
    db_session,
    client,
):
    """
    Property 7: Apply Flow Resume Version Selection

    For any apply session:
    - If a tailored resume with status "accepted" exists → fill profile contains tailored text
    - If no tailored resume exists → fill profile contains original resume text
    - The resume_text field is never empty

    **Validates: Requirements 6.7**
    """
    # Clear sessions from previous hypothesis iterations
    apply_module._sessions.clear()

    # Set up a job in the database
    job = ScrapedJob(
        title="Software Engineer",
        company="TestCo",
        url=f"https://example.com/job/{id(original_resume_text)}",
        description="Build software",
    )
    db_session.add(job)
    db_session.flush()

    # Set up user settings (required for profile endpoint)
    settings_obj = UserSettings(
        first_name="Test",
        last_name="User",
        email="test@example.com",
        phone="555-0100",
        city="Ottawa",
        linkedin_url="https://linkedin.com/in/testuser",
        website="https://testuser.dev",
    )
    db_session.add(settings_obj)

    # Set up resume profile with original text
    profile = ResumeProfileDB(
        profile_name="Test User",
        email="test@example.com",
        raw_text=original_resume_text,
        skills=["Python", "FastAPI"],
        experience=[],
        education=[],
    )
    db_session.add(profile)

    # Optionally add a tailored resume with status "accepted"
    if has_tailored:
        tailored = TailoredResume(
            job_id=job.id,
            original_text=original_resume_text,
            tailored_text=tailored_resume_text,
            diff_summary="Some changes",
            status="accepted",
        )
        db_session.add(tailored)

    db_session.commit()
    db_session.refresh(job)

    # Step 1: Initiate the apply flow
    initiate_response = client.post("/apply/initiate", json={"job_id": job.id})
    assert initiate_response.status_code == 200
    session_data = initiate_response.json()
    session_id = session_data["session_id"]

    # Verify resume_version field in session
    if has_tailored:
        assert session_data["resume_version"] == "tailored"
    else:
        assert session_data["resume_version"] == "original"

    # Step 2: Get the fill profile
    profile_response = client.get(f"/apply/{session_id}/profile")
    assert profile_response.status_code == 200
    fill_profile = profile_response.json()

    # Property assertions:
    # 1. Resume text is never empty
    assert fill_profile["resume_text"] != ""
    assert fill_profile["resume_text"].strip() != ""

    # 2. Correct version is selected
    if has_tailored:
        assert fill_profile["resume_text"] == tailored_resume_text
    else:
        assert fill_profile["resume_text"] == original_resume_text

    # Cleanup: remove test data for next hypothesis iteration
    db_session.query(TailoredResume).delete()
    db_session.query(ResumeProfileDB).delete()
    db_session.query(UserSettings).delete()
    db_session.query(ScrapedJob).delete()
    db_session.commit()
