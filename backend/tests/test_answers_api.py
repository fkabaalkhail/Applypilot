"""Endpoint tests for the Question Memory CRUD: POST/GET/DELETE /api/answers.

Isolated SQLite app (no production lifespan); EmbeddingsService.embed is mocked
so no network/key is needed for the happy path, and the missing-key degradation
path is exercised explicitly.
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
from backend.routers import answers

TEST_DATABASE_URL = "sqlite:///./test_answers_api.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

app = FastAPI()
app.include_router(answers.router, prefix="/api", tags=["answers"])


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


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


def _embed_returning(vec):
    """Patch EmbeddingsService.embed to return `vec`; key present so __init__ ok."""
    return patch.multiple(
        "backend.services.embeddings.EmbeddingsService",
        embed=AsyncMock(return_value=vec),
    )


def test_post_creates_row_with_category_and_embedding(client, db_session, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    with _embed_returning([0.1, 0.2]):
        resp = client.post("/api/answers", json={
            "question": "What is your expected salary?",
            "answer": "$120k",
            "company": "Acme",
            "jobTitle": "Engineer",
        })
    assert resp.status_code == 200
    data = resp.json()
    assert data["category"] == "salary"
    assert data["question_canonical"] == "what is your expected salary?"
    assert data["source"] == "user_edited"

    row = db_session.query(SavedAnswer).filter_by(user_id=TEST_USER_ID).one()
    assert row.embedding == [0.1, 0.2]
    assert row.embedding_model == "text-embedding-3-small"
    assert row.answer == "$120k"


def test_post_dedupes_same_question_and_bumps_reuse(client, db_session, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    payload = {"question": "What is your expected salary?", "answer": "$100k",
               "company": "Acme", "jobTitle": "Engineer"}
    with _embed_returning([0.1, 0.2]):
        client.post("/api/answers", json=payload)
        resp = client.post("/api/answers", json={**payload, "answer": "$120k"})
    assert resp.status_code == 200

    rows = db_session.query(SavedAnswer).filter_by(user_id=TEST_USER_ID).all()
    assert len(rows) == 1
    assert rows[0].answer == "$120k"
    assert rows[0].times_reused == 1


def test_get_lists_user_answers(client, db_session, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    with _embed_returning([0.1, 0.2]):
        client.post("/api/answers", json={"question": "When can you start?", "answer": "Immediately"})
    resp = client.get("/api/answers")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["category"] == "availability"
    assert items[0]["answer"] == "Immediately"


def test_delete_removes_owned_answer(client, db_session, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    with _embed_returning([0.1, 0.2]):
        created = client.post("/api/answers", json={"question": "Q?", "answer": "A"}).json()
    resp = client.delete(f"/api/answers/{created['id']}")
    assert resp.status_code == 204
    assert db_session.query(SavedAnswer).count() == 0


def test_delete_other_users_answer_is_404(client, db_session):
    other = SavedAnswer(user_id=999, question_raw="Q?", question_canonical="q?", answer="A")
    db_session.add(other)
    db_session.commit()
    resp = client.delete(f"/api/answers/{other.id}")
    assert resp.status_code == 404
    assert db_session.query(SavedAnswer).count() == 1


def test_post_without_embeddings_still_saves(client, db_session, monkeypatch):
    # No key -> EmbeddingsService() raises -> route degrades, saves without a vector.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    resp = client.post("/api/answers", json={
        "question": "Are you authorized to work in the US?", "answer": "Yes",
    })
    assert resp.status_code == 200
    assert resp.json()["category"] == "work_authorization"
    row = db_session.query(SavedAnswer).filter_by(user_id=TEST_USER_ID).one()
    assert row.embedding == []
    assert row.embedding_model == ""
