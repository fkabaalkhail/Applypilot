"""Transport tests for OpenAIService (POST /v1/chat/completions).

The other public methods are transport-agnostic (build a prompt -> _generate ->
parse) and are covered by the endpoint tests; here we pin down the OpenAI HTTP
contract: payload shape, system/user message mapping, response parsing, and the
missing-key guard. httpx is exercised for real via a MockTransport.
"""
import json

import httpx
import pytest
from unittest.mock import patch

from backend.services.openai_service import OpenAIService

# Capture the real client before any test patches httpx.AsyncClient, so the
# factory can still build a real client (backed by a mock transport) without
# recursing into the patch.
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_client_factory(handler):
    """Build a drop-in for httpx.AsyncClient that routes through MockTransport."""
    def factory(*args, **kwargs):
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler))
    return factory


@pytest.mark.asyncio
async def test_generate_builds_chat_payload_and_parses_content(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o")
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "Hello world"}}]},
        )

    with patch("httpx.AsyncClient", _mock_client_factory(handler)):
        svc = OpenAIService()
        out = await svc._generate("the prompt", system="be terse")

    assert out == "Hello world"
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured["auth"] == "Bearer test-key"
    assert captured["body"]["model"] == "gpt-4o"
    assert captured["body"]["messages"] == [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "the prompt"},
    ]


@pytest.mark.asyncio
async def test_generate_without_system_sends_only_user_message(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with patch("httpx.AsyncClient", _mock_client_factory(handler)):
        svc = OpenAIService()
        out = await svc._generate("just the prompt")

    assert out == "ok"
    assert captured["body"]["messages"] == [{"role": "user", "content": "just the prompt"}]


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError):
        OpenAIService()
