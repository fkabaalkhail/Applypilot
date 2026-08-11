"""
Shared test fixtures: in-memory DB, test client, sample data.
"""

import os

# Rate limiting is exercised by its own dedicated tests (which opt in
# explicitly). Disable it everywhere else so unrelated suites that hammer an
# endpoint in a loop aren't tripped by the per-minute/daily AI limits.
os.environ.setdefault("RATE_LIMIT_ENABLED", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# --- Hypothesis: disable timing-based deadlines globally ---------------------
# Property tests do real DB/HTTP-client work; on shared CI runners the first
# example is often slow enough to trip Hypothesis' default 200ms deadline,
# producing FlakyFailures unrelated to correctness. Register a CI profile that
# removes the deadline and load it for every test session.
from hypothesis import settings as _hyp_settings, HealthCheck as _HealthCheck

_hyp_settings.register_profile(
    "ci",
    deadline=None,
    suppress_health_check=[_HealthCheck.too_slow],
)
_hyp_settings.load_profile("ci")

from backend.db.database import Base, get_db
from backend.auth.dependencies import get_current_user_id, get_optional_user_id, get_verified_user_id
from backend.main import app

# In-memory SQLite for tests
TEST_DATABASE_URL = "sqlite:///./test.db"
engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

TEST_USER_ID = 1


@pytest.fixture(autouse=True)
def setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


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

    async def _override_get_optional_user_id():
        return TEST_USER_ID

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user_id] = _override_get_user_id
    app.dependency_overrides[get_verified_user_id] = _override_get_user_id
    app.dependency_overrides[get_optional_user_id] = _override_get_optional_user_id
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# --- /api/fill batched-answer test helpers ----------------------------------
# The fill endpoint answers a whole form in one call per group (factual /
# open-ended) rather than one call per field, so a stand-in for the LLM has to
# fan one canned answer out across every id it was asked about.

ANSWER_BATCH = "backend.services.openai_service.OpenAIService.answer_questions_batch"
COMPOSE_BATCH = "backend.services.openai_service.OpenAIService.compose_answers_batch"


def batch_returning(value):
    """A stand-in for a batched answer method that answers every id with ``value``.

    Mirrors the real contract: keys in, keys out. Pass a dict instead of a
    string to answer specific ids differently; ids left out come back absent,
    which is how the endpoint learns a field went unanswered.
    """
    from unittest.mock import AsyncMock

    async def _impl(questions, context, model=None):
        if isinstance(value, dict):
            return {qid: value[qid] for qid in questions if qid in value}
        return {qid: value for qid in questions}

    return AsyncMock(side_effect=_impl)


def questions_asked(mock) -> dict:
    """The questions dict a batch mock was handed (empty if it never ran).

    Routing is asserted with this rather than with ``assert_not_awaited``: both
    groups are always awaited concurrently, so "did this field go to the essay
    path?" is a question about which dict it landed in, not about which
    coroutine ran.
    """
    if not mock.await_args_list:
        return {}
    return mock.await_args_list[0].args[0]


@pytest.fixture(autouse=True)
def _cold_analysis_memo():
    """Give every test a cold résumé↔job analysis memo.

    ``match_engine`` memoises analyze_job for ANALYSIS_MEMO_TTL so one "tailor my
    résumé" journey buys the analysis once instead of three times. That cache is
    process-global by design — which across a test session means one test's
    result silently answers another's call, so a test that stubs the LLM to
    raise never reaches it. Production is unaffected (the key contains the
    résumé text and job description, so no two users can collide), but tests
    have to start from nothing or they become order-dependent.
    """
    from backend.services.match_engine import reset_analysis_memo

    reset_analysis_memo()
    yield
    reset_analysis_memo()
