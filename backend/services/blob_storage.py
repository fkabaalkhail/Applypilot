"""
Vercel Blob storage for original resume files (PDF/DOCX).

The resume binary is what the Chrome extension auto-uploads into ATS forms, so
we must keep the bytes the parser used to discard. Files are stored with an
unguessable UUID path. Authorization is enforced by the API layer
(``GET /resumes/{id}/file`` proxies the bytes only to the owning user) — the
public Blob URL is never handed to clients.

Configuration: set ``BLOB_READ_WRITE_TOKEN`` (locally in .env, and in the
Vercel project env). When the token is absent, storage degrades gracefully:
uploads are skipped (resume parsing still succeeds) and downloads return None.
"""

import logging
import os
import uuid

import httpx

logger = logging.getLogger(__name__)

_API_BASE = "https://blob.vercel-storage.com"
_API_VERSION = "7"
_TIMEOUT = httpx.Timeout(30.0)


def _token() -> str | None:
    return os.getenv("BLOB_READ_WRITE_TOKEN")


def is_configured() -> bool:
    """True when Blob storage is usable (token present)."""
    return bool(_token())


def _safe_name(filename: str) -> str:
    base = os.path.basename(filename or "resume")
    # Keep it filesystem/URL friendly; the UUID guarantees uniqueness.
    cleaned = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in base)
    return cleaned[-120:] or "resume"


async def upload_resume(
    content: bytes, filename: str, content_type: str, user_id: int
) -> dict | None:
    """Upload resume bytes to Vercel Blob.

    Returns ``{"url", "size", "name", "content_type"}`` on success, or None when
    storage is unconfigured or the upload fails (caller treats the file as
    optional and keeps the parsed-text-only flow working).
    """
    token = _token()
    if not token:
        logger.info("BLOB_READ_WRITE_TOKEN not set — skipping resume file storage.")
        return None

    name = _safe_name(filename)
    pathname = f"resumes/{user_id}/{uuid.uuid4().hex}-{name}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            res = await client.put(
                f"{_API_BASE}/{pathname}",
                content=content,
                headers={
                    "authorization": f"Bearer {token}",
                    "x-api-version": _API_VERSION,
                    "x-content-type": content_type or "application/octet-stream",
                    # We supply our own UUID, so no random suffix is needed.
                    "x-add-random-suffix": "0",
                    "x-cache-control-max-age": "0",
                },
            )
            res.raise_for_status()
            data = res.json()
        return {
            "url": data.get("url", ""),
            "size": len(content),
            "name": name,
            "content_type": content_type,
        }
    except Exception:
        logger.warning("Resume blob upload failed for user %s", user_id, exc_info=True)
        return None


async def download(url: str) -> bytes | None:
    """Fetch stored bytes by Blob URL (called server-side, behind authz)."""
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            res = await client.get(url)
            res.raise_for_status()
            return res.content
    except Exception:
        logger.warning("Resume blob download failed", exc_info=True)
        return None


async def delete(url: str) -> None:
    """Best-effort delete of a stored blob (e.g. when a resume is removed)."""
    token = _token()
    if not token or not url:
        return
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            res = await client.post(
                f"{_API_BASE}/delete",
                headers={
                    "authorization": f"Bearer {token}",
                    "x-api-version": _API_VERSION,
                    "content-type": "application/json",
                },
                json={"urls": [url]},
            )
            res.raise_for_status()
    except Exception:
        logger.warning("Resume blob delete failed", exc_info=True)
