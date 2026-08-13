"""How a 429 from OpenAI is classified.

OpenAI answers two very different conditions with the same status code:

  * ``rate_limit_exceeded`` — the window is full. Waiting fixes it.
  * ``insufficient_quota`` / a hard billing limit — the account cannot pay for
    the call. Waiting NEVER fixes it.

Treating both as transient cost a real application. On 2026-08-12 a Lyft form
(autofill_reports #167) came back with 12 of 24 fields blank and reason
``ai_error``; the logs showed four 429s over 45 seconds of exponential backoff
and said only "rate limited", so the investigation started by looking for a
traffic spike that did not exist. These tests pin the split and the log line.
"""

import logging

import httpx
import pytest

from backend.services.openai_service import _is_terminal_429, _openai_error_code, _retry_after


def response(status: int = 429, body: dict | None = None, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=body if body is not None else {},
        headers=headers or {},
        request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
    )


# ------------------------------------------------------------ error codes

def test_reads_the_error_code_that_distinguishes_quota_from_rate_limit():
    r = response(body={"error": {"code": "insufficient_quota", "type": "insufficient_quota"}})
    assert _openai_error_code(r) == "insufficient_quota"


def test_falls_back_to_error_type_when_no_code_is_set():
    r = response(body={"error": {"type": "rate_limit_exceeded"}})
    assert _openai_error_code(r) == "rate_limit_exceeded"


def test_returns_empty_for_an_unreadable_body_rather_than_raising():
    """A 429 with an HTML error page must not turn into a 500 of our own."""
    r = httpx.Response(
        status_code=429,
        text="<html>429 Too Many Requests</html>",
        request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"),
    )
    assert _openai_error_code(r) == ""


# ------------------------------------------------------------ Retry-After

def test_honours_retry_after_because_the_api_knows_its_own_window():
    assert _retry_after(response(headers={"retry-after": "8"})) == 8.0


def test_caps_retry_after_so_one_header_cannot_stall_a_user_request():
    assert _retry_after(response(headers={"retry-after": "600"})) == 30.0


def test_absent_or_nonsense_retry_after_defers_to_exponential_backoff():
    assert _retry_after(response()) is None
    assert _retry_after(response(headers={"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"})) is None


# ------------------------------------------------- terminal vs transient

def test_the_code_the_real_outage_returned_is_terminal():
    """The actual body from api.openai.com on 2026-08-12:

        {"error": {"message": "Your account is not active, please check your
                   billing details on our website.",
                   "type": "billing_not_active", "code": "billing_not_active"}}

    An allowlist of the codes one would *guess* (insufficient_quota,
    billing_hard_limit_reached, account_deactivated) did not contain it, which
    is why this matches the family by substring instead.
    """
    assert _is_terminal_429("billing_not_active")


@pytest.mark.parametrize(
    "code",
    ["insufficient_quota", "billing_hard_limit_reached", "account_deactivated", "billing_not_active"],
)
def test_every_account_level_429_fails_fast(code):
    assert _is_terminal_429(code)


@pytest.mark.parametrize("code", ["rate_limit_exceeded", "requests", "tokens", "", "something_new"])
def test_traffic_and_unknown_429s_still_retry(code):
    """Unknown codes retry: a burst we have not seen before deserves its
    backoff, and only a recognizably account-level failure skips it."""
    assert not _is_terminal_429(code)


@pytest.mark.asyncio
async def test_a_spent_quota_fails_fast_instead_of_retrying_for_45_seconds(monkeypatch, caplog):
    """The whole point: no sleeping, no four attempts, and a legible reason."""
    from backend.services.openai_service import OpenAIService

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    service = OpenAIService()

    attempts = 0

    async def post(self, url, **kwargs):  # noqa: ARG001
        nonlocal attempts
        attempts += 1
        # Verbatim from the real outage.
        return response(body={"error": {
            "message": "Your account is not active, please check your billing details on our website.",
            "type": "billing_not_active", "code": "billing_not_active",
        }})

    slept: list[float] = []

    async def no_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(ConnectionError) as excinfo:
            await service._generate("hi", op="fill.batch.short")

    assert attempts == 1, "an account/billing error must not be retried"
    assert slept == [], "an account/billing error must not sleep"
    # The message has to name the real cause, not "rate limited".
    assert "billing_not_active" in str(excinfo.value)
    assert "billing" in str(excinfo.value).lower()
    assert "billing_not_active" in caplog.text


@pytest.mark.asyncio
async def test_a_real_rate_limit_still_retries_and_then_succeeds(monkeypatch):
    from backend.services.openai_service import OpenAIService

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    service = OpenAIService()

    calls = 0

    async def post(self, url, **kwargs):  # noqa: ARG001
        nonlocal calls
        calls += 1
        if calls == 1:
            return response(
                body={"error": {"code": "rate_limit_exceeded"}}, headers={"retry-after": "2"}
            )
        return response(
            status=200,
            body={
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    slept: list[float] = []

    async def no_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr("asyncio.sleep", no_sleep)

    assert await service._generate("hi", op="fill.batch.short") == "ok"
    assert calls == 2
    assert slept == [2.0], "Retry-After should win over the blind doubling"
