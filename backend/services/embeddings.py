"""
EmbeddingsService — OpenAI embeddings client for semantic question matching.

Uses the same OPENAI_API_KEY as the chat service. Returns plain ``list[float]``
vectors that the Question Memory stores as JSON and compares with
``answer_memory.cosine``. Callers treat any failure here (missing key, network)
as "no embedding available" and fall back to non-semantic behaviour.
"""
import os

import httpx


class EmbeddingsService:
    """Async client for the OpenAI embeddings API."""

    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "").strip().strip("﻿")
        self.model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small").strip().strip("﻿")
        self.timeout = float(os.getenv("OPENAI_TIMEOUT", "60"))
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY not set in environment")

    async def embed(self, text: str) -> list[float]:
        """Embed a single string."""
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of strings, preserving input order."""
        url = "https://api.openai.com/v1/embeddings"
        body = {"model": self.model, "input": texts}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        async with httpx.AsyncClient() as client:
            r = await client.post(url, json=body, headers=headers, timeout=self.timeout)
            r.raise_for_status()
            data = r.json()
        items = sorted(data["data"], key=lambda d: d["index"])
        return [item["embedding"] for item in items]
