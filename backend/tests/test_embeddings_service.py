"""Transport tests for EmbeddingsService (POST /v1/embeddings)."""
import json

import httpx
import pytest
from unittest.mock import patch

from backend.services.embeddings import EmbeddingsService

_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_client_factory(handler):
    def factory(*args, **kwargs):
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler))
    return factory


@pytest.mark.asyncio
async def test_embed_batch_payload_and_parses_in_index_order(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        # Returned deliberately out of order to prove we re-order by `index`.
        return httpx.Response(200, json={"data": [
            {"index": 1, "embedding": [0.3, 0.4]},
            {"index": 0, "embedding": [0.1, 0.2]},
        ]})

    with patch("httpx.AsyncClient", _mock_client_factory(handler)):
        svc = EmbeddingsService()
        out = await svc.embed_batch(["q one", "q two"])

    assert out == [[0.1, 0.2], [0.3, 0.4]]
    assert captured["url"] == "https://api.openai.com/v1/embeddings"
    assert captured["auth"] == "Bearer test-key"
    assert captured["body"]["input"] == ["q one", "q two"]
    assert captured["body"]["model"] == "text-embedding-3-small"


@pytest.mark.asyncio
async def test_embed_single_returns_first_vector(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5, 0.6]}]})

    with patch("httpx.AsyncClient", _mock_client_factory(handler)):
        svc = EmbeddingsService()
        out = await svc.embed("hello")

    assert out == [0.5, 0.6]


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError):
        EmbeddingsService()
