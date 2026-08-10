"""
POST /resumes/{id}/improve and the resume API's timestamp contract.

The point of these tests is the guarantee that makes the feature safe to ship:
a rewrite may change wording and section order, and nothing else. If the model
returns invented employers, dates, or degrees, they must not reach the response.

So these stub the *HTTP call to OpenAI*, not the service, the real
``improve_resume_structured`` and the real ``merge_rewrite`` run, because they
are the thing under test.
"""

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.auth.dependencies import (
    get_current_user_id,
    get_optional_user_id,
    get_verified_user_id,
)
from backend.db.database import Base, get_db
from backend.db.models import ResumeProfileDB
from backend.main import app

DATABASE_URL = "sqlite:///./test_resume_improve.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

USER_ID = 1


@pytest.fixture
def db_session():
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    async def _user_id():
        return USER_ID

    app.dependency_overrides[get_current_user_id] = _user_id
    app.dependency_overrides[get_verified_user_id] = _user_id
    app.dependency_overrides[get_optional_user_id] = _user_id
    # No `with` block: the app lifespan would run migrations against the real DB.
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def resume(db_session):
    record = ResumeProfileDB(
        user_id=USER_ID,
        name="Wissam_CV",
        profile_name="Wissam Elmasry",
        email="w@example.com",
        summary="",
        skills=["Python"],
        experience=[{
            "company": "Public Services and Procurement Canada",
            "title": "Software Developer & Tester",
            "location": "Gatineau, QC",
            "start_date": "Oct 2025",
            "end_date": "May 2026",
            "bullets": ["Responsible for the regression suite"],
        }],
        education=[],
        projects=[{
            "name": "Tailrd", "link": "https://tailrd.ca", "organization": "",
            "location": "", "start_date": "2025", "end_date": "",
            "bullets": ["Built a Chrome extension"],
        }],
        technologies={},
        custom_sections=[{
            "id": "cert1", "title": "CERTIFICATIONS", "kind": "certifications",
            "text": "", "bullets": [], "items": [{
                "title": "AWS Solutions Architect", "subtitle": "Amazon",
                "location": "", "start_date": "", "end_date": "",
                "detail": "", "link": "", "bullets": [],
            }],
        }],
        section_order=["experience", "projects", "custom:cert1", "skills"],
        raw_text="Wissam Elmasry\nResponsible for the regression suite",
        status="analyzed",
    )
    db_session.add(record)
    db_session.commit()
    db_session.refresh(record)
    return record


@pytest.fixture(autouse=True)
def openai_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


# What a badly-behaved model returns: new wording AND invented facts. Every
# factual field here differs from the stored resume.
MALICIOUS_RESPONSE = {
    "resume": {
        "header": {"name": "Someone Else", "email": "attacker@example.com"},
        "sections": [
            {
                "id": "experience", "type": "experience", "title": "WORK EXPERIENCE",
                "items": [{
                    "id": "experience-0",
                    "title": "Chief Technology Officer",
                    "subtitle": "Google",
                    "start_date": "Jan 2015", "end_date": "Present",
                    "bullets": ["Owned the regression suite, cutting failures by [X]%"],
                }],
            },
            {
                "id": "projects", "type": "projects", "title": "PROJECTS",
                "items": [{
                    "id": "projects-0", "title": "Renamed Project",
                    "bullets": ["Shipped a Chrome extension used by [N] people"],
                }],
            },
        ],
    },
    "section_order": ["projects", "experience"],
    "new_summary": {"title": "PROFESSIONAL SUMMARY", "text": "Engineer who ships."},
    "unresolved": ["the % of failures the regression suite removed"],
}


def _stub_openai(payload: dict):
    """Patch the one HTTP call, so the real service + merge logic still run."""
    return patch.object(
        __import__("backend.services.openai_service", fromlist=["OpenAIService"]).OpenAIService,
        "_generate",
        AsyncMock(return_value=json.dumps(payload)),
    )


def test_improve_rewrites_wording_but_locks_every_fact(client, resume):
    with _stub_openai(MALICIOUS_RESPONSE):
        response = client.post(f"/resumes/{resume.id}/improve")

    assert response.status_code == 200
    profile = response.json()["profile"]
    exp = profile["experience"][0]

    # Wording moved…
    assert exp["bullets"] == ["Owned the regression suite, cutting failures by [X]%"]
    # …facts did not.
    assert exp["company"] == "Public Services and Procurement Canada"
    assert exp["title"] == "Software Developer & Tester"
    assert exp["start_date"] == "Oct 2025"
    assert exp["end_date"] == "May 2026"
    assert profile["projects"][0]["name"] == "Tailrd"
    assert profile["name"] == "Wissam Elmasry"  # header is never AI-editable


def test_improve_applies_the_reorder_and_the_new_summary(client, resume):
    with _stub_openai(MALICIOUS_RESPONSE):
        profile = client.post(f"/resumes/{resume.id}/improve").json()["profile"]

    assert profile["summary"] == "Engineer who ships."
    order = profile["section_order"]
    assert order.index("projects") < order.index("experience")


def test_improve_returns_changes_and_the_metrics_it_refused_to_invent(client, resume):
    with _stub_openai(MALICIOUS_RESPONSE):
        changes = client.post(f"/resumes/{resume.id}/improve").json()["changes"]

    assert any("Rewrote" in c for c in changes)
    assert any(c.startswith("Needs your input: ") for c in changes)


def test_improve_never_drops_a_custom_section(client, resume):
    """The model returned no certifications section; it must survive anyway."""
    with _stub_openai(MALICIOUS_RESPONSE):
        profile = client.post(f"/resumes/{resume.id}/improve").json()["profile"]

    assert [c["title"] for c in profile["custom_sections"]] == ["CERTIFICATIONS"]
    assert profile["custom_sections"][0]["items"][0]["title"] == "AWS Solutions Architect"


def test_improve_survives_an_unparseable_model_response(client, resume):
    with patch.object(
        __import__("backend.services.openai_service", fromlist=["OpenAIService"]).OpenAIService,
        "_generate",
        AsyncMock(return_value="I'm sorry, I can't do that."),
    ):
        response = client.post(f"/resumes/{resume.id}/improve")

    assert response.status_code == 200
    profile = response.json()["profile"]
    assert profile["experience"][0]["bullets"] == ["Responsible for the regression suite"]


def test_improve_does_not_persist_until_the_client_saves(client, resume, db_session):
    with _stub_openai(MALICIOUS_RESPONSE):
        client.post(f"/resumes/{resume.id}/improve")

    db_session.refresh(resume)
    assert resume.experience[0]["bullets"] == ["Responsible for the regression suite"]
    assert resume.summary == ""


def test_improve_404s_for_a_resume_the_caller_does_not_own(client):
    assert client.post("/resumes/99999/improve").status_code == 404


# ── Round-trip + timestamps ─────────────────────────────────────────────────

def test_get_returns_every_section_including_custom(client, resume):
    profile = client.get(f"/resumes/{resume.id}").json()["profile"]
    assert [p["name"] for p in profile["projects"]] == ["Tailrd"]
    assert [c["title"] for c in profile["custom_sections"]] == ["CERTIFICATIONS"]
    assert profile["section_order"] == ["experience", "projects", "custom:cert1", "skills"]


def test_timestamps_are_serialized_as_utc(client, resume):
    """Naive UTC without an offset parses as *local* time in the browser, which
    is what made a fresh upload render as '-240m ago'."""
    body = client.get(f"/resumes/{resume.id}").json()
    assert body["created_at"].endswith("Z")
    assert body["updated_at"].endswith("Z")

    listed = client.get("/resumes").json()[0]
    assert listed["created_at"].endswith("Z")


def test_update_without_custom_sections_does_not_wipe_them(client, resume, db_session):
    """An older client (the extension) sends a profile with no custom_sections;
    writing the schema default would silently delete the user's data."""
    body = client.get(f"/resumes/{resume.id}").json()["profile"]
    del body["custom_sections"]
    del body["summary"]

    response = client.put(f"/resumes/{resume.id}", json={"profile": body})
    assert response.status_code == 200

    db_session.refresh(resume)
    assert resume.custom_sections[0]["title"] == "CERTIFICATIONS"
