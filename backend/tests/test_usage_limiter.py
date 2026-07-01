"""Tests for the DB-backed usage limiter (per-minute burst + daily AI quota)."""

import pytest
from fastapi import HTTPException

from backend.services import usage_limiter
from backend.services.usage_limiter import _hit, enforce_llm_limits, client_identity


@pytest.fixture
def enabled(monkeypatch):
    """Rate limiting is off by default in tests; turn it on for this module."""
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    yield


def test_hit_allows_up_to_limit_then_blocks(db_session, enabled):
    for _ in range(3):
        assert _hit(db_session, "t", "user:1", max_requests=3, window_seconds=60) is None
    retry = _hit(db_session, "t", "user:1", max_requests=3, window_seconds=60)
    assert retry is not None and retry > 0


def test_hit_isolates_distinct_identities(db_session, enabled):
    for _ in range(3):
        _hit(db_session, "t", "user:1", max_requests=3, window_seconds=60)
    # A different user shares neither bucket nor counter.
    assert _hit(db_session, "t", "user:2", max_requests=3, window_seconds=60) is None


def test_hit_isolates_distinct_limit_names(db_session, enabled):
    for _ in range(3):
        _hit(db_session, "minute", "user:1", max_requests=3, window_seconds=60)
    assert _hit(db_session, "daily", "user:1", max_requests=3, window_seconds=86_400) is None


def test_enforce_is_noop_when_disabled(db_session, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "false")
    monkeypatch.setattr(usage_limiter, "LLM_DAILY_QUOTA", 1)
    monkeypatch.setattr(usage_limiter, "LLM_PER_MINUTE", 1)
    # Far exceeds both limits, but disabled means never raises.
    for _ in range(50):
        enforce_llm_limits(db_session, None, user_id=1)


def test_enforce_daily_quota_raises_429(db_session, enabled, monkeypatch):
    monkeypatch.setattr(usage_limiter, "LLM_PER_MINUTE", 10_000)
    monkeypatch.setattr(usage_limiter, "LLM_DAILY_QUOTA", 5)
    for _ in range(5):
        enforce_llm_limits(db_session, None, user_id=42)
    with pytest.raises(HTTPException) as exc:
        enforce_llm_limits(db_session, None, user_id=42)
    assert exc.value.status_code == 429
    assert exc.value.headers.get("Retry-After")


def test_enforce_per_minute_burst_raises_429(db_session, enabled, monkeypatch):
    monkeypatch.setattr(usage_limiter, "LLM_PER_MINUTE", 3)
    monkeypatch.setattr(usage_limiter, "LLM_DAILY_QUOTA", 10_000)
    for _ in range(3):
        enforce_llm_limits(db_session, None, user_id=7)
    with pytest.raises(HTTPException) as exc:
        enforce_llm_limits(db_session, None, user_id=7)
    assert exc.value.status_code == 429


def test_identity_prefers_user_over_ip():
    assert client_identity(None, user_id=99) == "user:99"
    assert client_identity(None, user_id=None) == "ip:unknown"


def test_fill_endpoint_enforces_limit_over_http(client, monkeypatch):
    """End-to-end: the 429 surfaces through a real LLM-guarded route.

    Uses a sponsorship question that the rule-based layer answers, so the limit
    is proven without any real OpenAI call.
    """
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    monkeypatch.setattr(usage_limiter, "LLM_PER_MINUTE", 2)
    monkeypatch.setattr(usage_limiter, "LLM_DAILY_QUOTA", 10_000)

    payload = {"fields": [{"label": "Do you require visa sponsorship?", "options": ["Yes", "No"]}]}
    assert client.post("/api/fill", json=payload).status_code == 200
    assert client.post("/api/fill", json=payload).status_code == 200
    blocked = client.post("/api/fill", json=payload)
    assert blocked.status_code == 429
    assert blocked.headers.get("Retry-After")
