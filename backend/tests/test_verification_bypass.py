"""Tests for the REQUIRE_EMAIL_VERIFICATION beta bypass flag.

The flag lets unverified local users through verified-only endpoints so beta
testers aren't blocked by email deliverability. It must default to enforcing
verification (secure) and only relax when explicitly disabled.

The gate logic lives in get_verified_user; we exercise it directly (the HTTP
test client in conftest overrides the auth dependencies, so it can't see it).
The flag is read live via os.getenv, so monkeypatching the env var is enough.
"""

import asyncio

import pytest
from fastapi import HTTPException

from backend.auth.dependencies import (
    effective_email_verified,
    email_verification_required,
    get_verified_user,
)


# --- Lightweight stand-ins so we can call the dependency without FastAPI DI ---

class _FakeURL:
    def __init__(self, path):
        self.path = path


class _FakeRequest:
    def __init__(self, path):
        self.url = _FakeURL(path)


class _FakeUser:
    def __init__(self, *, provider="local", verified=False):
        self.auth_provider = provider
        self.email_verified = verified


def _run(coro):
    return asyncio.run(coro)


# --- Flag parsing ------------------------------------------------------------

@pytest.mark.parametrize(
    "value,expected",
    [
        (None, True),        # unset -> secure default
        ("true", True),
        ("True", True),
        ("1", True),
        ("yes", True),
        ("false", False),    # explicit opt-out
        ("False", False),
        ("0", False),
        ("no", False),
        (" false ", False),  # tolerate whitespace
    ],
)
def test_flag_parsing(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    else:
        monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", value)
    assert email_verification_required() is expected


# --- Gate behavior -----------------------------------------------------------

def test_unverified_blocked_by_default(monkeypatch):
    """Gate on (default): unverified local user on a non-exempt path -> 403."""
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    user = _FakeUser(provider="local", verified=False)
    with pytest.raises(HTTPException) as exc:
        _run(get_verified_user(request=_FakeRequest("/api/profile"), user=user))
    assert exc.value.status_code == 403


def test_unverified_allowed_when_disabled(monkeypatch):
    """Gate off: the same unverified user passes through."""
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "false")
    user = _FakeUser(provider="local", verified=False)
    assert _run(get_verified_user(request=_FakeRequest("/api/profile"), user=user)) is user


def test_verified_user_always_passes(monkeypatch):
    """A verified user passes regardless of the flag."""
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    user = _FakeUser(provider="local", verified=True)
    assert _run(get_verified_user(request=_FakeRequest("/api/profile"), user=user)) is user


def test_exempt_path_passes_when_gate_on(monkeypatch):
    """Exempt paths (e.g. /auth/me) pass even with the gate on and user unverified."""
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    user = _FakeUser(provider="local", verified=False)
    assert _run(get_verified_user(request=_FakeRequest("/auth/me"), user=user)) is user


# --- effective_email_verified (what clients/frontend see) --------------------

def test_effective_verified_true_when_actually_verified(monkeypatch):
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    assert effective_email_verified(_FakeUser(verified=True)) is True


def test_effective_verified_false_when_unverified_and_gate_on(monkeypatch):
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    assert effective_email_verified(_FakeUser(verified=False)) is False


def test_effective_verified_true_when_gate_off(monkeypatch):
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "false")
    assert effective_email_verified(_FakeUser(verified=False)) is True


# --- End-to-end: /auth/me drives the frontend's verification wall ------------

def test_auth_me_reports_unverified_by_default(client, db_session, monkeypatch):
    """Gate on: a freshly registered user's /auth/me reports email_verified=False
    (frontend would wall them at /verify-email)."""
    monkeypatch.delenv("REQUIRE_EMAIL_VERIFICATION", raising=False)
    reg = client.post(
        "/auth/register",
        json={"email": "me-gate-on@example.com", "password": "Str0ng!pass"},
    )
    assert reg.status_code == 200, reg.text
    assert reg.json()["email_verified"] is False
    me = client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {reg.json()['access_token']}"},
    )
    assert me.status_code == 200, me.text
    assert me.json()["email_verified"] is False


def test_auth_me_reports_verified_when_gate_off(client, db_session, monkeypatch):
    """Gate off: register response and /auth/me both report email_verified=True,
    so the frontend ProtectedRoute lets the user through with no email step."""
    monkeypatch.setenv("REQUIRE_EMAIL_VERIFICATION", "false")
    reg = client.post(
        "/auth/register",
        json={"email": "me-gate-off@example.com", "password": "Str0ng!pass"},
    )
    assert reg.status_code == 200, reg.text
    assert reg.json()["email_verified"] is True
    me = client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {reg.json()['access_token']}"},
    )
    assert me.status_code == 200, me.text
    assert me.json()["email_verified"] is True
