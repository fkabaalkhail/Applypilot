"""The /api/fill AI pass against constrained widgets.

A select/radio takes one of ITS options or nothing. These pin what the AI pass
does with an answer the model phrased conversationally: snap it to the real
option when it genuinely names one (including range buckets, where a plain
contains-check cannot tell "2-3 years" from "4-5 years"), and drop it with a
reason when it names none, never silently fall back to options[0].

Isolated SQLite app; OpenAIService.answer_question is mocked, so no network/key.
"""
from unittest.mock import patch, AsyncMock

from backend.tests.conftest import ANSWER_BATCH, COMPOSE_BATCH, batch_returning, questions_asked

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.services.usage_limiter import llm_guard
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_fill_ai_option_matching.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1

app = FastAPI()
app.include_router(fill.router, prefix="/api", tags=["fill"])

_ANSWER = ANSWER_BATCH


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def override_deps():
    def _db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[llm_guard] = lambda: TEST_USER_ID
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_ai_answer_dropped_when_no_option_matches(client):
    """A constrained widget takes one of ITS options or nothing.

    This used to return the unmatched answer and let the client fuzzy-match it.
    The client's matcher is a mirror of the backend's (writeEngine.matchOption),
    so an answer the backend cannot place is one the page could not have taken
    either. It only ever became a "No option matches" write failure. Dropping
    it here says so once, with a reason, and routes the field to the gap modal.

    The original point of this test still holds and is asserted: the answer is
    NOT snapped to options[0] ("Select…").
    """
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, batch_returning("Gold")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["answers"] == []
    assert payload["dropped"] == [
        {"id": "f1", "label": "Favourite metal?", "reason": "not_an_offered_option", "source": "ai"}
    ]


def test_ai_answer_snaps_to_a_matching_option(client):
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, batch_returning("silver")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "Silver"  # snapped to the real option, original casing


def test_ai_answer_snaps_to_a_numeric_range_bucket(client):
    # Bucketed options ("2-3 years") all share the substring "years", so a plain
    # contains-check can't tell them apart; the AI is told to answer with exact
    # option text but often answers conversationally with just the number.
    body = {
        "fields": [{
            "id": "f1",
            "label": "Years of experience?",
            "type": "select",
            "options": ["0-1 years", "2-3 years", "4-5 years", "6+ years"],
        }]
    }
    with patch(_ANSWER, batch_returning("I have approximately 3 years of experience")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "2-3 years"  # not the first bucket


def test_ai_answer_snaps_to_a_salary_range_bucket(client):
    body = {
        "fields": [{
            "id": "f1",
            "label": "Expected salary?",
            "type": "select",
            "options": ["$50,000-$70,000", "$70,000-$90,000", "$90,000-$110,000", "$110,000+"],
        }]
    }
    with patch(_ANSWER, batch_returning("My expected salary is around $95,000")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "$90,000-$110,000"  # not the first bucket
