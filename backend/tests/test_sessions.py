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


def _connect_extension(client):
    """Run the PKCE handshake and return the extension's refresh token + sid."""
    import base64, hashlib, secrets
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    redirect = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"
    code = client.post("/auth/extension/authorize",
                       json={"code_challenge": challenge, "redirect_uri": redirect}).json()["code"]
    body = client.post("/auth/extension/token",
                       json={"code": code, "code_verifier": verifier}).json()
    return body["refresh_token"]


def test_extension_token_registers_session(client, db_session, user):
    refresh = _connect_extension(client)
    sid = decode_token(refresh)["sid"]
    assert sid
    assert db_session.query(DBSession).filter(DBSession.sid == sid).first() is not None


def test_refresh_rotates_and_touches_session(client, db_session, user):
    refresh = _connect_extension(client)
    sid = decode_token(refresh)["sid"]

    res = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert res.status_code == 200, res.text
    new_refresh = res.json()["refresh_token"]
    # sid is preserved across rotation; client stays "extension".
    assert decode_token(new_refresh)["sid"] == sid
    assert decode_token(new_refresh)["client"] == "extension"


def test_refresh_rejected_after_session_revoked(client, db_session, user):
    from backend.services import sessions
    from backend.db.models import RevokedToken
    refresh = _connect_extension(client)
    decoded = decode_token(refresh)
    sid = decoded["sid"]
    sessions.revoke(db_session, sessions.get_active(db_session, sid))

    res = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert res.status_code == 401
    # Defense-in-depth: the presented token's jti is revoked even on the 401 path.
    assert db_session.query(RevokedToken).filter(RevokedToken.jti == decoded["jti"]).first() is not None


def test_list_sessions_excludes_revoked(client, db_session, user):
    from backend.services import sessions
    s1 = sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    s2 = sessions.start_session(db_session, TEST_USER_ID, "web", None)
    sessions.revoke(db_session, s2)

    res = client.get("/auth/sessions")
    assert res.status_code == 200, res.text
    sids = [s["sid"] for s in res.json()["sessions"]]
    assert s1.sid in sids
    assert s2.sid not in sids


def test_revoke_one_session(client, db_session, user):
    from backend.services import sessions
    s = sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    res = client.delete(f"/auth/sessions/{s.sid}")
    assert res.status_code == 200, res.text
    assert sessions.get_active(db_session, s.sid) is None


def test_revoke_all_sessions(client, db_session, user):
    from backend.services import sessions
    sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    sessions.start_session(db_session, TEST_USER_ID, "web", None)
    res = client.post("/auth/sessions/revoke-all", json={})
    assert res.status_code == 200, res.text
    assert res.json()["revoked"] >= 2
    assert client.get("/auth/sessions").json()["sessions"] == []


def test_revoke_session_cross_user_returns_404(client, db_session, user):
    from backend.db.models import User
    from backend.services import sessions
    other = User(id=2, email="other@example.com", email_verified=True, auth_provider="local")
    db_session.add(other)
    db_session.commit()
    s = sessions.start_session(db_session, 2, "web", None)

    res = client.delete(f"/auth/sessions/{s.sid}")
    assert res.status_code == 404
    # The other user's session must remain active.
    assert sessions.get_active(db_session, s.sid) is not None


def test_revoke_already_revoked_session_returns_404(client, db_session, user):
    from backend.services import sessions
    s = sessions.start_session(db_session, TEST_USER_ID, "extension", None)
    sessions.revoke(db_session, s)
    res = client.delete(f"/auth/sessions/{s.sid}")
    assert res.status_code == 404


def test_revoke_all_accepts_except_current_flag(client, db_session, user):
    from backend.services import sessions
    sessions.start_session(db_session, TEST_USER_ID, "web", None)
    res = client.post("/auth/sessions/revoke-all", json={"except_current": True})
    assert res.status_code == 200
    assert "revoked" in res.json()


def test_legacy_refresh_without_sid_is_migrated(client, db_session, user):
    # A refresh token minted the old way (no sid) must still work once and gain a sid.
    legacy = create_refresh_token(TEST_USER_ID, client="extension")  # no sid
    assert "sid" not in decode_token(legacy)
    res = client.post("/auth/refresh", json={"refresh_token": legacy})
    assert res.status_code == 200, res.text
    assert decode_token(res.json()["refresh_token"])["sid"]
