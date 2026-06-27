"""JWT token creation and verification with revocation support."""

import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt

JWT_SECRET = os.getenv("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET environment variable is required")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7
# The extension can't lean on an HttpOnly cookie and re-auth costs a full
# handshake, so its refresh token lives much longer than the web's.
EXTENSION_REFRESH_TOKEN_EXPIRE_DAYS = 60


def create_access_token(user_id: int, client: str = "web") -> str:
    """Create a short-lived access token.

    ``client`` ("web" | "extension") is carried as a claim so the issuing
    surface is auditable and refresh can preserve it across rotation.
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": str(user_id),
        "exp": expire,
        "type": "access",
        "client": client,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _refresh_ttl_days(client: str) -> int:
    return EXTENSION_REFRESH_TOKEN_EXPIRE_DAYS if client == "extension" else REFRESH_TOKEN_EXPIRE_DAYS


def create_refresh_token(user_id: int, client: str = "web") -> str:
    """Create a long-lived refresh token with a unique JTI for revocation.

    The TTL depends on ``client``: extension tokens last
    ``EXTENSION_REFRESH_TOKEN_EXPIRE_DAYS``, web tokens ``REFRESH_TOKEN_EXPIRE_DAYS``.
    """
    expire = datetime.now(timezone.utc) + timedelta(days=_refresh_ttl_days(client))
    payload = {
        "sub": str(user_id),
        "exp": expire,
        "type": "refresh",
        "client": client,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and verify a JWT. Raises jwt.InvalidTokenError on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
