"""Tests for the LinkedIn OIDC auth flow (/auth/linkedin/*)."""
import backend.routers.auth_linkedin as li
from backend.db.models import User


def _prime_env(monkeypatch):
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_ID", "test-client")
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_SECRET", "test-secret")
    monkeypatch.setattr(li, "LINKEDIN_REDIRECT_URI", "https://www.tailrd.ca/auth/linkedin/callback")


def test_start_redirects_and_sets_state_cookie(client, monkeypatch):
    _prime_env(monkeypatch)
    resp = client.get("/auth/linkedin/start", params={"next": "/app"}, follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://www.linkedin.com/oauth/v2/authorization")
    assert "li_oauth_state" in resp.cookies
    # The state cookie must be SameSite=Lax so it survives LinkedIn's top-level
    # GET redirect back to /callback (a Strict cookie would be dropped there).
    state_cookie = next((c for c in resp.headers.get_list("set-cookie")
                         if c.startswith("li_oauth_state=")), "")
    assert "samesite=lax" in state_cookie.lower()


def test_start_500_when_unconfigured(client, monkeypatch):
    monkeypatch.setattr(li, "LINKEDIN_CLIENT_ID", "")
    resp = client.get("/auth/linkedin/start", follow_redirects=False)
    assert resp.status_code == 500


def test_callback_rejects_state_mismatch(client, monkeypatch):
    _prime_env(monkeypatch)
    resp = client.get(
        "/auth/linkedin/callback",
        params={"code": "abc", "state": "attacker"},
        cookies={"li_oauth_state": "real", "li_oauth_next": "/app"},
        follow_redirects=False,
    )
    assert resp.status_code == 401


def test_callback_creates_user_sets_cookie_and_redirects(client, db_session, monkeypatch):
    _prime_env(monkeypatch)
    monkeypatch.setattr(li, "_exchange_code", lambda code: {"access_token": "tok"})
    monkeypatch.setattr(li, "_fetch_userinfo", lambda tok: {
        "email": "grad@example.com", "given_name": "Grad", "family_name": "Student",
        "picture": "https://img.example/p.jpg", "email_verified": True,
    })
    resp = client.get(
        "/auth/linkedin/callback",
        params={"code": "abc", "state": "match"},
        cookies={"li_oauth_state": "match", "li_oauth_next": "/app"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/linkedin/complete")
    assert "refresh_token" in resp.cookies
    user = db_session.query(User).filter(User.email == "grad@example.com").first()
    assert user is not None
    assert user.auth_provider == "linkedin"
    assert user.email_verified is True


def test_callback_links_existing_local_user_not_duplicated(client, db_session, monkeypatch):
    """Spec §F: an existing local-account email is linked to LinkedIn, not duplicated."""
    _prime_env(monkeypatch)
    db_session.add(User(
        email="grad@example.com",
        auth_provider="local",
        hashed_password="x",
        email_verified=False,
        first_name="",
        last_name="",
    ))
    db_session.commit()

    monkeypatch.setattr(li, "_exchange_code", lambda code: {"access_token": "tok"})
    monkeypatch.setattr(li, "_fetch_userinfo", lambda tok: {
        "email": "grad@example.com", "given_name": "Grad", "family_name": "Student",
        "picture": "https://img.example/p.jpg", "email_verified": True,
    })
    resp = client.get(
        "/auth/linkedin/callback",
        params={"code": "abc", "state": "match"},
        cookies={"li_oauth_state": "match", "li_oauth_next": "/app"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    # Linked in place — no second row for this email.
    assert db_session.query(User).filter_by(email="grad@example.com").count() == 1
    user = db_session.query(User).filter_by(email="grad@example.com").first()
    assert user.auth_provider == "linkedin"
    assert user.email_verified is True
    # Empty names are backfilled from the userinfo claims.
    assert user.first_name == "Grad"
    assert user.last_name == "Student"
