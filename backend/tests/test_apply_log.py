"""
Tests for POST /apply/log — the extension's submit-tracking endpoint.

Runs against an isolated in-memory SQLite app (never the Neon lifespan), the
same pattern as test_apply_integration.py, so it is safe to run standalone.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob, JobStatus, ApplicationRecord
from backend.routers import apply as apply_module
from backend.routers.apply import router as apply_router
from backend.auth.dependencies import get_current_user_id, get_verified_user_id

TEST_DATABASE_URL = "sqlite:///./test_apply_log.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

log_app = FastAPI()
log_app.include_router(apply_router, prefix="/apply", tags=["apply"])


@pytest.fixture(autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)
    apply_module._sessions.clear()


@pytest.fixture
def db_session():
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    async def _override_get_user_id():
        return TEST_USER_ID

    log_app.dependency_overrides[get_db] = _override_get_db
    log_app.dependency_overrides[get_current_user_id] = _override_get_user_id
    log_app.dependency_overrides[get_verified_user_id] = _override_get_user_id
    with TestClient(log_app) as c:
        yield c
    log_app.dependency_overrides.clear()


def test_log_creates_external_application(client, db_session):
    """An external submit (no internal job_id) creates an ApplicationRecord."""
    resp = client.post(
        "/apply/log",
        json={
            "company": "Acme Corp",
            "role": "Backend Engineer",
            "url": "https://boards.greenhouse.io/acme/jobs/123",
            "ats_type": "greenhouse",
            "resume_version": "original",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["created"] is True
    assert body["company"] == "Acme Corp"
    assert body["status"] == "applied"
    assert body["job_id"] is None

    rows = db_session.query(ApplicationRecord).filter_by(user_id=TEST_USER_ID).all()
    assert len(rows) == 1
    assert rows[0].ats_type == "greenhouse"
    assert rows[0].url == "https://boards.greenhouse.io/acme/jobs/123"


def test_log_dedupes_by_url(client, db_session):
    """Re-logging the same URL refreshes applied_at instead of duplicating."""
    payload = {"company": "Acme", "role": "Eng", "url": "https://x.io/jobs/1"}
    first = client.post("/apply/log", json=payload)
    assert first.json()["created"] is True

    second = client.post("/apply/log", json={**payload, "company": "Acme Inc"})
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert second.json()["company"] == "Acme Inc"  # updated in place

    rows = db_session.query(ApplicationRecord).filter_by(user_id=TEST_USER_ID).all()
    assert len(rows) == 1  # still one row


def test_log_requires_some_context(client):
    """An empty payload is rejected — no phantom blank records."""
    resp = client.post("/apply/log", json={"company": "", "role": "", "url": ""})
    assert resp.status_code == 422


def test_log_with_job_id_marks_job_applied(client, db_session):
    """When a known internal job_id is supplied, the job flips to APPLIED."""
    job = ScrapedJob(
        title="Data Scientist",
        company="Globex",
        url="https://globex.com/jobs/9",
        description="ML work",
        platform="linkedin",
        status=JobStatus.NEW,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    resp = client.post(
        "/apply/log",
        json={"company": "Globex", "role": "Data Scientist",
              "url": "https://globex.com/jobs/9", "job_id": job.id},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["job_id"] == job.id

    db_session.refresh(job)
    assert job.status == JobStatus.APPLIED


def test_log_dedupes_by_job_id_even_with_a_different_url(client, db_session):
    """A job_id that already has a record is refreshed, not duplicated — even when
    the ATS page URL differs from the record's stored URL (mark-applied case)."""
    job = ScrapedJob(
        title="X", company="Y", url="https://y.com/j",
        description="d", platform="linkedin", status=JobStatus.NEW,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    # A record already exists for this job (as POST /jobs/{id}/mark-applied makes).
    db_session.add(
        ApplicationRecord(user_id=TEST_USER_ID, job_id=job.id, company="Y", role="X", url="https://y.com/j")
    )
    db_session.commit()

    resp = client.post(
        "/apply/log",
        json={
            "company": "Y", "role": "X",
            "url": "https://boards.greenhouse.io/y/jobs/999",  # different ATS page URL
            "job_id": job.id,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["created"] is False  # deduped by job_id despite the different URL

    rows = db_session.query(ApplicationRecord).filter_by(user_id=TEST_USER_ID, job_id=job.id).all()
    assert len(rows) == 1
