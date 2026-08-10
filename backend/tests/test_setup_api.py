"""Tests for the setup-completion flag: /auth/me exposure + POST toggle."""
import pytest

from backend.db.models import User
from backend.tests.conftest import TEST_USER_ID


def _make_user(db, provider: str = "local"):
    user = User(
        id=TEST_USER_ID,
        email="setup@test.com",
        first_name="Setup",
        auth_provider=provider,
    )
    db.add(user)
    db.commit()
    return user


def test_me_includes_setup_flag_default_false(client, db_session):
    _make_user(db_session)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is False


def test_post_setup_sets_completed_true(client, db_session):
    _make_user(db_session)
    resp = client.post("/auth/me/setup", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is True
    assert client.get("/auth/me").json()["has_completed_setup"] is True


def test_post_setup_reset_to_false(client, db_session):
    _make_user(db_session)
    client.post("/auth/me/setup", json={"completed": True})
    resp = client.post("/auth/me/setup", json={"completed": False})
    assert resp.status_code == 200
    assert resp.json()["has_completed_setup"] is False


@pytest.mark.parametrize("provider", ["google", "linkedin", "local"])
def test_post_setup_response_carries_auth_provider(client, db_session, provider):
    """This response replaces the whole user object in frontend auth state.

    SetupWizard's final step calls setSetupComplete(true), and AuthProvider
    feeds the response straight into setUser(data), so any key missing here
    goes `undefined` for the rest of the session. Every new user hits this
    path, and Settings -> Account reads user.auth_provider to render the
    "Connected account" row. Omitting it blanks that row until a full reload.

    Non-"local" providers are parametrized deliberately: a hardcoded "local"
    would satisfy a mere key-presence check but fails this one.
    """
    _make_user(db_session, provider)
    resp = client.post("/auth/me/setup", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["auth_provider"] == provider
