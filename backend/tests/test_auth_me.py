"""GET /auth/me must expose auth_provider — the Settings Account tab renders it."""
import pytest

from backend.db.models import User
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
    are pre-OAuth email/password users — /auth/me must report them as "local".
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
