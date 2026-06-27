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


def test_refresh_token_carries_sid():
    tok = create_refresh_token(TEST_USER_ID, client="extension", sid="sid-xyz")
    payload = decode_token(tok)
    assert payload["sid"] == "sid-xyz"
    assert payload["client"] == "extension"


def test_start_session_captures_client(db_session, user):
    from backend.services import sessions

    class _Req:
        client = type("C", (), {"host": "1.2.3.4"})()
        headers = {"user-agent": "TestAgent/1.0"}

    s = sessions.start_session(db_session, TEST_USER_ID, "extension", _Req())
    assert s.sid and len(s.sid) >= 32
    assert s.client == "extension"
    assert s.last_ip == "1.2.3.4"
    assert s.user_agent == "TestAgent/1.0"
    assert sessions.get_active(db_session, s.sid) is not None


def test_touch_and_revoke(db_session, user):
    from backend.services import sessions
    s = sessions.start_session(db_session, TEST_USER_ID, "web", None)  # request=None path
    sessions.touch(db_session, s)
    assert s.last_seen_at is not None
    sessions.revoke(db_session, s)
    assert sessions.get_active(db_session, s.sid) is None
