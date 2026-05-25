"""FastAPI auth dependencies for route protection."""

import os
from typing import Optional

from fastapi import Depends, HTTPException, Request, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import jwt

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.tokens import decode_token

security = HTTPBearer(auto_error=False)

CRON_SECRET = os.getenv("CRON_SECRET", "")


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """Requires valid JWT. Returns the full User object."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> int:
    """Requires valid JWT. Returns just the integer user ID (no DB query)."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    return int(payload["sub"])


async def get_optional_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[int]:
    """Returns integer user ID if authenticated, None otherwise."""
    if not credentials:
        return None
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            return None
        return int(payload["sub"])
    except Exception:
        return None


# Endpoints accessible to unverified local users
VERIFICATION_EXEMPT_PATHS = {
    "/auth/verify-email",
    "/auth/resend-verification",
    "/auth/me",
    "/auth/refresh",
    "/auth/logout",
}


async def get_verified_user(
    request: Request,
    user: User = Depends(get_current_user),
) -> User:
    """
    Requires the user to be email-verified (or Google OAuth).
    Raises HTTP 403 if a local user is unverified and the endpoint
    is not in the exempt list.
    """
    # Google OAuth users bypass verification check entirely
    if user.auth_provider == "google":
        return user

    # Verified local users always pass
    if user.email_verified:
        return user

    # Unverified local user — check if path is exempt
    if request.url.path in VERIFICATION_EXEMPT_PATHS:
        return user

    # Unverified local user on a non-exempt path
    raise HTTPException(
        status_code=403,
        detail="Email verification required",
    )


async def get_verified_user_id(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> int:
    """
    Requires valid JWT AND email verification (or Google OAuth).
    Returns just the integer user ID.

    Combines authentication + verification check in one dependency,
    suitable for routes that only need the user_id (not the full User object).
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Google OAuth users bypass verification check
    if user.auth_provider == "google":
        return user.id

    # Verified local users pass
    if user.email_verified:
        return user.id

    # Unverified local user on a non-exempt path
    raise HTTPException(
        status_code=403,
        detail="Email verification required",
    )


async def get_admin_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """
    Requires valid JWT, email verification, AND admin role.
    Returns the full User object.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Require email verification for admin access (Google users bypass)
    if user.auth_provider != "google" and not user.email_verified:
        raise HTTPException(status_code=403, detail="Email verification required")

    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    return user


async def get_admin_user_id(
    admin: User = Depends(get_admin_user),
) -> int:
    """Shortcut: requires admin, returns just the user ID."""
    return admin.id


async def verify_cron_secret(
    x_cron_secret: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
) -> None:
    """
    Verify the cron secret for scheduled job endpoints.
    Supports two methods:
    1. Vercel's built-in CRON_SECRET (sent as Authorization: Bearer <secret>)
    2. Custom x-cron-secret header (for manual testing)
    Fails closed in production if CRON_SECRET is not configured.
    """
    if not CRON_SECRET:
        # Fail closed in production — deny if secret is not configured
        if os.getenv("ENVIRONMENT") == "production":
            raise HTTPException(
                status_code=500,
                detail="Server misconfiguration: CRON_SECRET not set",
            )
        # Allow in development mode only
        return
    # Check Vercel's Authorization: Bearer <secret>
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        if token == CRON_SECRET:
            return
    # Check custom header
    if x_cron_secret == CRON_SECRET:
        return
    raise HTTPException(status_code=403, detail="Invalid cron secret")
