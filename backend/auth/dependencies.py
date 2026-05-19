"""FastAPI auth dependencies for route protection."""

from typing import Optional

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import jwt

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.tokens import decode_token

security = HTTPBearer(auto_error=False)


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
