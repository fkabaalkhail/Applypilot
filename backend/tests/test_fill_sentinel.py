"""The grounding sentinel and page-context forwarding on /api/fill.

Isolated SQLite app; OpenAIService.answer_question is mocked so no network/key
is used. Mirrors test_fill_memory.py's harness.
"""
from unittest.mock import patch, AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.auth.dependencies import get_verified_user_id
from backend.routers import fill

TEST_DATABASE_URL = "sqlite:///./test_fill_sentinel.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)

TEST_USER_ID = 1
_ANSWER = "backend.services.openai_service.OpenAIService.answer_question"

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


def _payload(**field):
    base = {"id": "f1", "label": "Describe your experience with COBOL", "type": "textarea"}
    base.update(field)
    return {"fields": [base], "profile": {"firstName": "Ada"}}


def test_sentinel_answer_emits_no_field_answer(client):
    # No saved answers seeded -> memory pass is skipped and this goes to the AI
    # pass, which returns the grounding sentinel.
    with patch(_ANSWER, AsyncMock(return_value="__NO_ANSWER__")):
        resp = client.post("/api/fill", json=_payload())
    assert resp.status_code == 200
    # A field the AI could not ground produces no answer -> stays blank.
    assert resp.json()["answers"] == []


def test_help_text_and_input_type_reach_the_prompt(client):
    mock = AsyncMock(return_value="__NO_ANSWER__")
    with patch(_ANSWER, mock):
        client.post("/api/fill", json=_payload(
            label="Start date", type="text",
            helpText="When can you begin?", inputType="date",
        ))
    question = mock.call_args.kwargs["question"]
    assert "date" in question
    assert "When can you begin?" in question
