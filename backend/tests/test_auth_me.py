"""/auth/me must expose auth_provider, the Settings Account tab renders it.

Covers GET plus the sibling writes that return the same profile shape. The
write responses matter because AuthProvider pipes them into setUser(data),
which *replaces* the user object in auth state rather than merging into it.
"""
import pytest

from backend.auth.dependencies import get_verified_user
from backend.db.models import User
from backend.main import app
from backend.tests.conftest import TEST_USER_ID


def _make_user(db, provider: str) -> User:
    user = User(id=TEST_USER_ID, email="me@test.com", auth_provider=provider)
    db.add(user)
    db.commit()
    return user


@pytest.mark.parametrize("provider", ["local", "google", "linkedin"])
def test_me_exposes_auth_provider(client, db_session, provider):
    _make_user(db_session, provider)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["auth_provider"] == provider


def test_me_coalesces_legacy_null_provider_to_local(client, db_session):
    """Rows predating the column hold NULL: `default="local"` is a Python-side
    INSERT default, not a server_default, so ADD COLUMN backfilled NULL. Those
    are pre-OAuth email/password users, /auth/me must report them as "local".
    """
    _make_user(db_session, "local")
    # The Python-side default only fires on INSERT, so null the column via an
    # UPDATE to reproduce exactly what a legacy row looks like on disk.
    db_session.query(User).filter(User.id == TEST_USER_ID).update({"auth_provider": None})
    db_session.commit()
    # Guard: prove the row really is NULL, so this test can't pass vacuously.
    assert db_session.query(User).filter(User.id == TEST_USER_ID).one().auth_provider is None

    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["auth_provider"] == "local"


@pytest.mark.parametrize("provider", ["google", "linkedin", "local"])
def test_put_me_response_carries_auth_provider(client, db_session, provider):
    """PUT /auth/me returns the same profile shape and must carry the field.

    No caller wires this response into setUser() *today*, but Task 4's settings
    modal is the obvious place someone does, and the moment they write
    `setUser(data)` on save, a payload missing auth_provider silently blanks
    the Connected-account row it just rendered. Pin it now rather than
    rediscover it.

    Unlike its siblings this route depends on get_verified_user (the full User,
    not the id), which conftest does not override, so supply it here.
    """
    user = _make_user(db_session, provider)
    app.dependency_overrides[get_verified_user] = lambda: user

    resp = client.put("/auth/me", json={"first_name": "Renamed"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["first_name"] == "Renamed"  # guard: the update really ran
    assert body["auth_provider"] == provider
