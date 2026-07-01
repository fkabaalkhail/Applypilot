"""Tests for the setup-completion flag: /auth/me exposure + POST toggle."""
from backend.db.models import User
from backend.tests.conftest import TEST_USER_ID


def _make_user(db):
    user = User(id=TEST_USER_ID, email="setup@test.com", first_name="Setup")
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
