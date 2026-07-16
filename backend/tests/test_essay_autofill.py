"""Pass-3 routing on /api/fill: open-ended essay fields go to compose_answer,
everything else keeps answer_question. Isolated SQLite app; both LLM methods are
mocked so no network/key is used. Mirrors test_fill_sentinel.py's harness."""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.auth.dependencies import get_verified_user_id
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_essay_autofill.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"
_COMPOSE = "backend.services.openai_service.OpenAIService.compose_answer"

app = FastAPI()
app.include_router(fill.router, prefix="/api", tags=["fill"])


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


@pytest.fixture
def client():
    session = TestingSessionLocal()

    def _get_db():
        try:
            yield session
        finally:
            pass

    async def _user():
        return TEST_USER_ID

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_verified_user_id] = _user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    session.close()


def _payload(label: str, type: str = "textarea"):
    return {
        "fields": [{"id": "f1", "label": label, "type": type}],
        "company": "Acme",
        "jobTitle": "Backend Engineer",
        "jobDescription": "Build payment APIs.",
        "profile": {"firstName": "Ada", "experience": ["Backend Engineer at Globex (2022-Present)"]},
    }


def test_essay_field_routes_to_compose(client):
    compose = AsyncMock(return_value="I'm drawn to this backend role because my work on payment APIs at Globex maps directly to it.")
    answer = AsyncMock(return_value="SHOULD_NOT_BE_CALLED")
    with patch(_COMPOSE, compose), patch(_ANSWER, answer):
        resp = client.post("/api/fill", json=_payload("Why do you want to work here?"))
    assert resp.status_code == 200
    answers = resp.json()["answers"]
    assert len(answers) == 1
    assert answers[0]["answer"].startswith("I'm drawn to this backend role")
    compose.assert_awaited_once()
    answer.assert_not_awaited()


def test_factual_field_routes_to_answer_question(client):
    compose = AsyncMock(return_value="SHOULD_NOT_BE_CALLED")
    # Unsupported factual free-text still grounds out to the sentinel -> blank.
    answer = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_COMPOSE, compose), patch(_ANSWER, answer):
        resp = client.post("/api/fill", json=_payload("Describe your experience with COBOL"))
    assert resp.status_code == 200
    assert resp.json()["answers"] == []  # regression: grounding preserved
    answer.assert_awaited_once()
    compose.assert_not_awaited()


def test_compose_floor_leaves_field_blank(client):
    # compose_answer may still decline when there is nothing to ground on.
    compose = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_COMPOSE, compose), patch(_ANSWER, AsyncMock(return_value="x")):
        resp = client.post("/api/fill", json=_payload("Tell us about yourself"))
    assert resp.status_code == 200
    assert resp.json()["answers"] == []
