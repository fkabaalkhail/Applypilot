"""Tests for onboarding completion flag: /auth/me exposure + POST toggle."""
from backend.db.models import User
from backend.main import app
from backend.auth.dependencies import get_current_user_id
from backend.tests.conftest import TEST_USER_ID


def _make_user(db):
    user = User(id=TEST_USER_ID, email="tour@test.com", first_name="Tour")
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


def test_me_requires_real_auth_returns_401(client, db_session):
    """GET /auth/me must reject unauthenticated requests through the real
    (non-overridden) get_current_user_id dependency chain, not just the
    manual 'user not found' DB check."""
    app.dependency_overrides.pop(get_current_user_id, None)
    resp = client.get("/auth/me")
    assert resp.status_code == 401
