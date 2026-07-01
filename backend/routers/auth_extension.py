"""
Extension authentication handshake (PKCE authorization-code flow).

The Chrome extension never handles credentials. Instead it bounces the user
through the web app's ``/extension/connect`` page (which reuses the live web
session) and exchanges a short-lived authorization code for its own token pair:

  1. POST /auth/extension/authorize  — called by the *web app* with the user's
     web access token. Mints a single-use code bound to the user + the PKCE
     ``code_challenge`` + the extension's ``redirect_uri``.
  2. POST /auth/extension/token      — called by the *extension* (public). Proves
     possession of the matching ``code_verifier`` (S256) and redeems the code for
     an access + refresh token pair tagged ``client="extension"``.

Security:
  - Codes are high-entropy, single-use, and expire in ~60s.
  - PKCE S256 only (no ``plain``) — a leaked code is useless without the verifier.
  - ``redirect_uri`` must be an extension ``chromiumapp.org`` URL; in production it
    must match the ``EXTENSION_ALLOWED_IDS`` allowlist so a malicious site can't
    phish a code. Dev allows any ``*.chromiumapp.org``.
  - Both endpoints are rate-limited.
"""

import base64
import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import ExtensionAuthCode, User
from backend.auth.dependencies import get_verified_user, effective_email_verified
from backend.auth.tokens import create_access_token, create_refresh_token
from backend.services import sessions as session_service
from backend.services.rate_limiter import rate_limiter
from backend.services.security_logger import security_logger, SecurityLogger

logger = logging.getLogger(__name__)
router = APIRouter()

IS_PRODUCTION = os.getenv("ENVIRONMENT") == "production"
# Comma-separated list of Chrome extension IDs allowed to complete the handshake
# in production. Empty list + non-prod => any *.chromiumapp.org is accepted.
_ALLOWED_IDS = {
    i.strip() for i in os.getenv("EXTENSION_ALLOWED_IDS", "").split(",") if i.strip()
}

CODE_TTL_SECONDS = 60


# ─── Schemas ─────────────────────────────────────────────────────────────────

class AuthorizeRequest(BaseModel):
    code_challenge: str
    redirect_uri: str
    code_challenge_method: str = "S256"

    @field_validator("code_challenge")
    @classmethod
    def _challenge_len(cls, v: str) -> str:
        # base64url SHA-256 is 43 chars; allow a little slack but reject junk.
        if not (20 <= len(v) <= 128):
            raise ValueError("invalid code_challenge")
        return v


class AuthorizeResponse(BaseModel):
    code: str
    expires_in: int = CODE_TTL_SECONDS


class TokenRequest(BaseModel):
    code: str
    code_verifier: str

    @field_validator("code_verifier")
    @classmethod
    def _verifier_len(cls, v: str) -> str:
        # PKCE spec: 43–128 chars.
        if not (43 <= len(v) <= 128):
            raise ValueError("invalid code_verifier")
        return v


class ExtensionTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    email: str
    email_verified: bool


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _redirect_uri_allowed(redirect_uri: str) -> bool:
    """Only allow this extension's own ``https://<id>.chromiumapp.org/`` URL.

    In production the ``<id>`` must be in ``EXTENSION_ALLOWED_IDS``. In dev (or
    when no allowlist is configured) any ``*.chromiumapp.org`` host is accepted.
    """
    try:
        parsed = urlparse(redirect_uri)
    except Exception:
        return False
    if parsed.scheme != "https":
        return False
    host = parsed.hostname or ""
    if not host.endswith(".chromiumapp.org"):
        return False
    ext_id = host[: -len(".chromiumapp.org")]
    if not ext_id:
        return False
    if _ALLOWED_IDS:
        return ext_id in _ALLOWED_IDS
    # No allowlist configured: permissive in dev, deny in prod (fail closed).
    return not IS_PRODUCTION


def _verify_pkce_s256(code_verifier: str, code_challenge: str) -> bool:
    """True when base64url(SHA256(verifier)) == challenge (constant-time)."""
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return secrets.compare_digest(expected, code_challenge)


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/authorize", response_model=AuthorizeResponse)
def authorize(
    body: AuthorizeRequest,
    request: Request,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Issue a single-use authorization code for the extension handshake.

    Authenticated with the user's *web* session. The extension never calls this.
    """
    rate_limiter.enforce(request, "ext_authorize", max_requests=10, window_seconds=60)

    if body.code_challenge_method.upper() != "S256":
        raise HTTPException(status_code=400, detail="Only S256 PKCE is supported")

    if not _redirect_uri_allowed(body.redirect_uri):
        security_logger.log_event(
            db, SecurityLogger.EXTENSION_AUTHORIZE, request,
            user_id=user.id, success=False,
            details={"reason": "redirect_uri_rejected", "redirect_uri": body.redirect_uri},
        )
        raise HTTPException(status_code=400, detail="redirect_uri is not an allowed extension URL")

    code = secrets.token_urlsafe(32)
    auth_code = ExtensionAuthCode(
        code=code,
        user_id=user.id,
        code_challenge=body.code_challenge,
        redirect_uri=body.redirect_uri,
        used=False,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=CODE_TTL_SECONDS),
    )
    db.add(auth_code)
    db.commit()

    security_logger.log_event(
        db, SecurityLogger.EXTENSION_AUTHORIZE, request,
        user_id=user.id, success=True,
    )
    return AuthorizeResponse(code=code)


@router.post("/token", response_model=ExtensionTokenResponse)
def token(
    body: TokenRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Redeem an authorization code (+ PKCE verifier) for an extension token pair.

    Public endpoint — possession of the matching ``code_verifier`` is the proof.
    """
    rate_limiter.enforce(request, "ext_token", max_requests=10, window_seconds=60)

    auth_code = (
        db.query(ExtensionAuthCode)
        .filter(ExtensionAuthCode.code == body.code)
        .first()
    )

    def _reject(reason: str):
        security_logger.log_event(
            db, SecurityLogger.EXTENSION_TOKEN, request,
            user_id=auth_code.user_id if auth_code else None,
            success=False, details={"reason": reason},
        )
        raise HTTPException(status_code=400, detail="Invalid or expired authorization code")

    if auth_code is None:
        _reject("code_not_found")

    # Normalize expiry to aware UTC (SQLite stores naive datetimes).
    expires_at = auth_code.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if auth_code.used:
        _reject("code_already_used")
    if expires_at < datetime.now(timezone.utc):
        _reject("code_expired")
    if not _verify_pkce_s256(body.code_verifier, auth_code.code_challenge):
        # Burn the code on a failed verifier to prevent brute-forcing.
        auth_code.used = True
        db.commit()
        _reject("pkce_mismatch")

    # Single use — mark redeemed before issuing tokens.
    auth_code.used = True
    db.commit()

    user = db.query(User).filter(User.id == auth_code.user_id).first()
    if not user:
        _reject("user_not_found")

    session = session_service.start_session(db, user.id, "extension", request)

    security_logger.log_event(
        db, SecurityLogger.EXTENSION_TOKEN, request,
        user_id=user.id, success=True,
    )

    return ExtensionTokenResponse(
        access_token=create_access_token(user.id, client="extension"),
        refresh_token=create_refresh_token(user.id, client="extension", sid=session.sid),
        email=user.email,
        email_verified=effective_email_verified(user),
    )
