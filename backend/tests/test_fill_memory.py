"""The evolved /api/fill memory pass: silent reuse, company-specific review,
AI fallback, and graceful degradation when embeddings are unavailable.

Isolated SQLite app; EmbeddingsService.embed_batch and OpenAIService.answer_question
are mocked, so no network/key is used.
"""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import SavedAnswer
from backend.auth.dependencies import get_verified_user_id
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_fill_memory.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

app = FastAPI()
app.include_router(fill.router, prefix="/api", tags=["fill"])

_EMBED = "backend.services.embeddings.EmbeddingsService.embed_batch"
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


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

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_verified_user_id] = _user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _seed(db, *, category, answer, embedding=(1.0, 0.0)):
    row = SavedAnswer(
        user_id=TEST_USER_ID,
        question_raw="seed",
        question_canonical="seed",
        answer=answer,
        category=category,
        embedding=list(embedding),
        embedding_model="text-embedding-3-small",
        source="user_edited",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _fill(client, label, **extra):
    body = {"fields": [{"id": "f1", "label": label}], **extra}
    return client.post("/api/fill", json=body)


def test_generic_memory_match_fills_silently_and_bumps_reuse(client, db_session):
    row = _seed(db_session, category="salary", answer="$130k")
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])):
        resp = _fill(client, "What is your expected salary?")
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "$130k"
    assert ans["source"] == "memory"
    assert ans["needsReview"] is False

    db_session.refresh(row)
    assert row.times_reused == 1


def test_company_specific_match_routes_to_review_without_bump(client, db_session):
    row = _seed(db_session, category="company_specific", answer="I admire your mission.")
    with patch(_EMBED, AsyncMock(return_value=[[1.0, 0.0]])):
        resp = _fill(client, "Why do you want to work at Acme?", company="Acme")
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "I admire your mission."
    assert ans["source"] == "memory"
    assert ans["needsReview"] is True

    db_session.refresh(row)
    assert row.times_reused == 0


def test_no_match_falls_back_to_ai_and_does_not_save(client, db_session):
    # Seeded vector is orthogonal to the query vector -> cosine 0 -> no match.
    _seed(db_session, category="salary", answer="$130k", embedding=(1.0, 0.0))
    with patch(_EMBED, AsyncMock(return_value=[[0.0, 1.0]])), \
         patch(_ANSWER, AsyncMock(return_value="My ideal environment is collaborative.")):
        resp = _fill(client, "Describe your ideal work environment.")
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "My ideal environment is collaborative."
    assert ans["source"] == "ai"
    assert ans["needsReview"] is True

    # AI answers are never auto-saved: still just the one seeded row.
    assert db_session.query(SavedAnswer).count() == 1


def test_embeddings_failure_degrades_to_ai(client, db_session):
    # A row that WOULD match, but embeddings error -> memory search skipped.
    _seed(db_session, category="salary", answer="$130k")
    with patch(_EMBED, AsyncMock(side_effect=RuntimeError("no embeddings"))), \
         patch(_ANSWER, AsyncMock(return_value="Generated.")):
        resp = _fill(client, "What is your expected salary?")
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["source"] == "ai"
    assert ans["answer"] == "Generated."


def test_ai_answer_kept_when_no_option_matches(client):
    # No saved answers -> straight to the AI pass. The field HAS options but the
    # AI answer matches none; it must NOT be snapped to options[0] ("Select…").
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, AsyncMock(return_value="Gold")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "Gold"  # not "Select…"
    assert ans["source"] == "ai"


def test_ai_answer_snaps_to_a_matching_option(client):
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, AsyncMock(return_value="silver")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "Silver"  # snapped to the real option, original casing
