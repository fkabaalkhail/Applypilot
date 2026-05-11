"""
Clerk JWT verification for FastAPI.

Verifies the Bearer token from Clerk using JWKS (JSON Web Key Set).
Creates/syncs user in the local DB on first request.
"""

import os
import logging
from typing import Optional

import httpx
import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from dotenv import load_dotenv

from backend.db.database import get_db
from backend.db.models import User

load_dotenv()

logger = logging.getLogger(__name__)

# Clerk config from env
CLERK_ISSUER = os.getenv("CLERK_ISSUER", "")
CLERK_JWKS_URL = f"{CLERK_ISSUER}/.well-known/jwks.json" if CLERK_ISSUER else ""

# Security scheme
security = HTTPBearer(auto_error=False)

# Cache the JWKS client (it handles key caching internally)
_jwks_client: Optional[PyJWKClient] = None


def _get_jwks_client() -> PyJWKClient:
    """Lazily initialize the JWKS client."""
    global _jwks_client
    if _jwks_client is None:
        if not CLERK_JWKS_URL:
            raise HTTPException(
                status_code=500,
                detail="CLERK_ISSUER not configured"
            )
        _jwks_client = PyJWKClient(CLERK_JWKS_URL)
    return _jwks_client


def _verify_token(token: str) -> dict:
    """Verify a Clerk JWT and return the decoded payload."""
    try:
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=CLERK_ISSUER,
            options={"verify_aud": False},  # Clerk doesn't always set aud
        )
        return payload
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError as e:
        logger.warning(f"Invalid token: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        logger.error(f"Token verification error: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")


def _sync_user(db: Session, payload: dict) -> User:
    """Create or update the user record from the JWT claims."""
    clerk_user_id = payload.get("sub", "")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Invalid token: no sub claim")

    user = db.query(User).filter(User.clerk_user_id == clerk_user_id).first()

    if not user:
        user = User(
            clerk_user_id=clerk_user_id,
            email=payload.get("email", ""),
            first_name=payload.get("first_name", ""),
            last_name=payload.get("last_name", ""),
            profile_image_url=payload.get("image_url", ""),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info(f"Created new user: {clerk_user_id}")
    else:
        # Update fields if they changed
        changed = False
        for field, claim in [("email", "email"), ("first_name", "first_name"),
                             ("last_name", "last_name"), ("profile_image_url", "image_url")]:
            val = payload.get(claim, "")
            if val and getattr(user, field) != val:
                setattr(user, field, val)
                changed = True
        if changed:
            db.commit()
            db.refresh(user)

    return user


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI dependency: requires a valid Clerk JWT. Returns the User object."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _verify_token(credentials.credentials)
    user = _sync_user(db, payload)
    return user


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> str:
    """FastAPI dependency: returns just the clerk_user_id (no DB sync)."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = _verify_token(credentials.credentials)
    user_id = payload.get("sub", "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user_id


async def get_optional_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[str]:
    """FastAPI dependency: returns clerk_user_id if authenticated, None otherwise."""
    if not credentials:
        return None

    try:
        payload = _verify_token(credentials.credentials)
        return payload.get("sub")
    except HTTPException:
        return None
