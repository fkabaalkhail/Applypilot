"""Tests for the session registry (Connected Devices) and session-aware refresh."""

import datetime

import pytest

from backend.auth.dependencies import get_verified_user
from backend.auth.tokens import create_refresh_token, decode_token
from backend.db.models import Session as DBSession, User
from backend.main import app

TEST_USER_ID = 1


@pytest.fixture
def user(db_session):
    u = User(id=TEST_USER_ID, email="u@example.com", email_verified=True, auth_provider="local")
    db_session.add(u)
    db_session.commit()

    async def _override():
        return u

    app.dependency_overrides[get_verified_user] = _override
    yield u
    app.dependency_overrides.pop(get_verified_user, None)


def test_session_model_persists(db_session, user):
    s = DBSession(
        sid="sid-1", user_id=TEST_USER_ID, client="extension",
        last_seen_at=datetime.datetime.utcnow(),
    )
    db_session.add(s)
    db_session.commit()
    found = db_session.query(DBSession).filter(DBSession.sid == "sid-1").first()
    assert found is not None
    assert found.client == "extension"
    assert found.revoked_at is None
