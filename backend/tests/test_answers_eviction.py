"""
Finding and evicting a poisoned key through the API the panel uses.

GET /api/answers is what the extension's "Remembered answers" list renders, and
DELETE /api/answers/{id} is what its Delete button calls. A bad key is invisible
from the answer alone — "Yes Required" -> "Yes" reads as a sensible row until
you notice it will answer every yes/no question on a Workday form — so the
listing has to say which rows are suspect, or eviction has nowhere to aim.
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

TEST_DATABASE_URL = "sqlite:///./test_answers_eviction.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

app = FastAPI()
app.include_router(answers.router, prefix="/api", tags=["answers"])

_EMBED = "backend.services.embeddings.EmbeddingsService.embed"

# The three keys production actually banked on bmo.wd3.myworkdayjobs.com,
# 2026-08-09 (recorded verbatim in chrome-extension/src/shared/questionText.ts).
POISONED = [
    ("Select One Required", "Yes"),
    ("Yes Required", "Yes"),
    ("b0531cc2ff371001d8a97c876e680000-b0531cc2ff371001d8a9b9c2eef00002", "Person of Mixed Origin"),
]


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def override_deps():
    def _db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_verified_user_id] = lambda: TEST_USER_ID
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def seed(question, answer, embedding=None):
    db = TestingSessionLocal()
    row = SavedAnswer(
        user_id=TEST_USER_ID, question_raw=question,
        question_canonical=question.lower(), answer=answer,
        category="general", embedding=embedding or [1.0, 0.0],
        embedding_model="test", source="user_edited",
    )
    db.add(row)
    db.commit()
    row_id = row.id
    db.close()
    return row_id


def test_the_listing_flags_each_poisoned_key(client):
    for question, answer in POISONED:
        seed(question, answer)
    rows = {r["question_raw"]: r for r in client.get("/api/answers").json()}
    for question, _ in POISONED:
        assert rows[question]["suspect"] is True, question
    assert rows["Yes Required"]["suspect_reason"] == "widget_boilerplate"
    assert rows[POISONED[2][0]]["suspect_reason"] == "machine_id"


def test_a_real_question_is_not_flagged(client):
    seed("Are you at least 18 years of age?*", "Yes")
    row = client.get("/api/answers").json()[0]
    assert row["suspect"] is False
    assert row["suspect_reason"] == ""


def test_a_key_that_would_win_another_questions_recall_is_flagged(client):
    seed("Are you willing to relocate?", "Yes", [1.0, 0.0])
    seed("Would you consider relocating?", "No", [0.999, 0.02])
    rows = client.get("/api/answers").json()
    assert all(r["suspect"] for r in rows)
    assert {r["suspect_reason"] for r in rows} == {"attracts_other_questions"}


def test_the_listing_carries_what_eviction_needs_to_decide(client):
    seed("Are you willing to relocate?", "Yes")
    row = client.get("/api/answers").json()[0]
    for key in ("source", "created_at", "times_reused", "times_matched", "answer"):
        assert key in row, key


def test_delete_removes_the_row(client):
    row_id = seed("Yes Required", "Yes")
    assert client.delete(f"/api/answers/{row_id}").status_code == 204
    assert client.get("/api/answers").json() == []


def test_delete_only_touches_the_callers_own_rows(client):
    db = TestingSessionLocal()
    other = SavedAnswer(
        user_id=TEST_USER_ID + 1, question_raw="Yes Required",
        question_canonical="yes required", answer="Yes", category="general",
    )
    db.add(other)
    db.commit()
    other_id = other.id
    db.close()
    assert client.delete(f"/api/answers/{other_id}").status_code == 404


@pytest.mark.parametrize("question,_answer", POISONED)
def test_the_bank_refuses_to_store_such_a_key_again(client, question, _answer):
    """The extension declines these too, but this is the only write path, and
    older builds keep running for as long as users leave them installed."""
    with patch(_EMBED, AsyncMock(return_value=[1.0, 0.0])):
        resp = client.post("/api/answers", json={"question": question, "answer": "Yes"})
    assert resp.status_code == 422
    assert TestingSessionLocal().query(SavedAnswer).count() == 0


def test_a_real_question_still_saves(client):
    with patch(_EMBED, AsyncMock(return_value=[1.0, 0.0])):
        resp = client.post(
            "/api/answers",
            json={"question": "Are you willing to relocate?", "answer": "Yes"},
        )
    assert resp.status_code == 200
    assert resp.json()["question_raw"] == "Are you willing to relocate?"
