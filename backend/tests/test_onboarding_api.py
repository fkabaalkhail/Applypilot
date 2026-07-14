"""Tests for onboarding completion flag: /auth/me exposure + POST toggle."""
import pytest

from backend.db.models import User
from backend.main import app
from backend.auth.dependencies import get_current_user_id
from backend.tests.conftest import TEST_USER_ID


def _make_user(db, provider: str = "local"):
    user = User(
        id=TEST_USER_ID,
        email="tour@test.com",
        first_name="Tour",
        auth_provider=provider,
    )
    db.add(user)
    db.commit()
    return user


def test_me_includes_onboarding_flag_default_false(client, db_session):
    _make_user(db_session)
    resp = client.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is False


def test_post_onboarding_sets_completed_true(client, db_session):
    _make_user(db_session)
    resp = client.post("/auth/me/onboarding", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is True
    resp2 = client.get("/auth/me")
    assert resp2.json()["has_completed_onboarding"] is True


def test_post_onboarding_reset_to_false(client, db_session):
    _make_user(db_session)
    client.post("/auth/me/onboarding", json={"completed": True})
    resp = client.post("/auth/me/onboarding", json={"completed": False})
    assert resp.status_code == 200
    assert resp.json()["has_completed_onboarding"] is False


@pytest.mark.parametrize("provider", ["google", "linkedin", "local"])
def test_post_onboarding_response_carries_auth_provider(client, db_session, provider):
    """This response replaces the whole user object in frontend auth state.

    OnboardingProvider calls setOnboardingComplete(true) at the end of the
    product tour, and AuthProvider feeds the response straight into
    setUser(data) — so any key missing here goes `undefined` for the rest of
    the session, blanking the Settings -> Account "Connected account" row
    until a full page reload re-hits GET /auth/me.

    Non-"local" providers are parametrized deliberately: a hardcoded "local"
    would satisfy a mere key-presence check but fails this one.
    """
    _make_user(db_session, provider)
    resp = client.post("/auth/me/onboarding", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["auth_provider"] == provider


def test_me_requires_real_auth_returns_401(client, db_session):
    """GET /auth/me must reject unauthenticated requests through the real
    (non-overridden) get_current_user_id dependency chain, not just the
    manual 'user not found' DB check."""
    app.dependency_overrides.pop(get_current_user_id, None)
    resp = client.get("/auth/me")
    assert resp.status_code == 401
