"""
Tests for the extension authentication handshake (PKCE) and sync snapshot.

  - POST /auth/extension/authorize  → single-use code (web session)
  - POST /auth/extension/token      → token pair (PKCE S256 proof)
  - GET  /api/extension/sync        → one-shot snapshot

The ``user`` fixture overrides ``get_verified_user`` (used by both new routers),
mirroring backend/tests/test_extension_sync.py.
"""

import base64
import datetime
import hashlib
import secrets

import pytest

from backend.auth.dependencies import get_verified_user
from backend.auth.tokens import decode_token
from backend.db.models import CoverLetter, ExtensionAuthCode, ResumeProfileDB, User
from backend.main import app
import backend.routers.auth_extension as ext_auth

TEST_USER_ID = 1
REDIRECT_URI = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"


def _pkce() -> tuple[str, str]:
    """Return (verifier, challenge) for a valid S256 PKCE pair."""
    verifier = secrets.token_urlsafe(48)  # 64 chars, within 43–128
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )
    return verifier, challenge


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


# ── Handshake happy path ──────────────────────────────────────────────────────

def test_authorize_then_token_happy_path(client, user):
    verifier, challenge = _pkce()

    auth = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": REDIRECT_URI},
    )
    assert auth.status_code == 200, auth.text
    code = auth.json()["code"]
    assert code

    tok = client.post(
        "/auth/extension/token",
        json={"code": code, "code_verifier": verifier},
    )
    assert tok.status_code == 200, tok.text
    body = tok.json()
    assert body["email"] == "u@example.com"
    assert body["email_verified"] is True

    # Tokens are tagged as extension-issued.
    assert decode_token(body["access_token"])["client"] == "extension"
    assert decode_token(body["refresh_token"])["client"] == "extension"


def test_token_rejects_wrong_verifier(client, user):
    _, challenge = _pkce()
    code = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": REDIRECT_URI},
    ).json()["code"]

    # A different (valid-length) verifier must not satisfy the challenge.
    wrong = secrets.token_urlsafe(48)
    res = client.post("/auth/extension/token", json={"code": code, "code_verifier": wrong})
    assert res.status_code == 400


def test_token_rejects_reused_code(client, user):
    verifier, challenge = _pkce()
    code = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": REDIRECT_URI},
    ).json()["code"]

    assert client.post("/auth/extension/token", json={"code": code, "code_verifier": verifier}).status_code == 200
    # Single use — a replay fails.
    assert client.post("/auth/extension/token", json={"code": code, "code_verifier": verifier}).status_code == 400


def test_token_rejects_expired_code(client, db_session, user):
    verifier, challenge = _pkce()
    expired = ExtensionAuthCode(
        code="expired-code",
        user_id=TEST_USER_ID,
        code_challenge=challenge,
        redirect_uri=REDIRECT_URI,
        used=False,
        expires_at=datetime.datetime.utcnow() - datetime.timedelta(seconds=10),
    )
    db_session.add(expired)
    db_session.commit()

    res = client.post("/auth/extension/token", json={"code": "expired-code", "code_verifier": verifier})
    assert res.status_code == 400


def test_token_rejects_unknown_code(client, user):
    verifier, _ = _pkce()
    res = client.post("/auth/extension/token", json={"code": "nope", "code_verifier": verifier})
    assert res.status_code == 400


# ── redirect_uri allowlist ────────────────────────────────────────────────────

def test_authorize_rejects_non_extension_redirect(client, user):
    _, challenge = _pkce()
    res = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": "https://evil.example.com/cb"},
    )
    assert res.status_code == 400


def test_authorize_enforces_allowlist_in_prod(client, user, monkeypatch):
    """With an allowlist configured, an unlisted extension id is rejected."""
    monkeypatch.setattr(ext_auth, "IS_PRODUCTION", True)
    monkeypatch.setattr(ext_auth, "_ALLOWED_IDS", {"the-real-extension-id"})
    _, challenge = _pkce()

    # Unlisted id → rejected.
    res = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": REDIRECT_URI},
    )
    assert res.status_code == 400

    # Listed id → accepted.
    ok = client.post(
        "/auth/extension/authorize",
        json={"code_challenge": challenge, "redirect_uri": "https://the-real-extension-id.chromiumapp.org/"},
    )
    assert ok.status_code == 200


# ── Sync snapshot ─────────────────────────────────────────────────────────────

def test_sync_snapshot_shape(client, db_session, user):
    db_session.add(ResumeProfileDB(
        user_id=TEST_USER_ID, name="My CV", is_primary=1, raw_text="x",
        file_blob_url="https://blob/x", file_name="cv.pdf", file_content_type="application/pdf",
    ))
    db_session.add(CoverLetter(user_id=TEST_USER_ID, company="Acme", text="Dear team", is_active=1))
    db_session.commit()

    res = client.get("/api/extension/sync")
    assert res.status_code == 200, res.text
    body = res.json()

    for key in ("version", "profile", "resumes", "activeResumeId", "coverLetters",
                "customResumes", "settings", "subscription", "usage"):
        assert key in body, f"missing {key}"

    assert body["resumes"][0]["hasFile"] is True
    assert body["resumes"][0]["fileName"] == "cv.pdf"
    assert body["activeResumeId"] == body["resumes"][0]["id"]
    assert body["coverLetters"][0]["isActive"] is True
    assert body["subscription"]["tier"] == "free"
    assert body["usage"]["aiCreditsUsed"] == 0


def test_sync_version_matches_snapshot(client, db_session, user):
    snap_v = client.get("/api/extension/sync").json()["version"]
    assert client.get("/api/extension/sync/version").json()["version"] == snap_v
