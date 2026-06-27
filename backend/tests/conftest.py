"""
Shared test fixtures: in-memory DB, test client, sample data.
"""

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
