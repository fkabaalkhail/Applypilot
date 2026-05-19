"""
Auth endpoints:
- POST /auth/register — create user, return tokens
- POST /auth/login — verify credentials, return tokens
- POST /auth/google — authenticate with Google ID token
- POST /auth/refresh — exchange refresh token for new token pair
- GET /auth/me — return authenticated user profile
- PUT /auth/me — update user profile fields
- POST /auth/verify-email — verify email with token
- POST /auth/resend-verification — resend verification email
"""

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
import httpx

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.passwords import hash_password, verify_password
from backend.auth.tokens import create_access_token, create_refresh_token, decode_token
from backend.auth.dependencies import get_current_user, get_verified_user
from backend.services.verification_service import (
    create_verification_token,
    verify_token,
    can_resend,
    mark_verified,
)
from backend.services.email_service import email_service

logger = logging.getLogger(__name__)
router = APIRouter()

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo"


# --- Pydantic Schemas ---

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class GoogleAuthRequest(BaseModel):
    credential: str  # Google ID token from frontend

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class RefreshRequest(BaseModel):
    refresh_token: str

class ProfileUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    profile_image_url: Optional[str] = None

class TokenResponseWithVerification(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    email_verified: bool

class VerifyEmailRequest(BaseModel):
    token: str

class ResendVerificationResponse(BaseModel):
    message: str


# --- Endpoints ---

@router.post("/register", response_model=TokenResponseWithVerification)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    """Register a new user with email and password."""
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(email=body.email, hashed_password=hash_password(body.password), auth_provider="local")
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info(f"New user registered: {user.email}")

    # Generate verification token and send email (fire-and-forget)
    try:
        token = create_verification_token(user, db)
        email_service.send_verification_email(user.email, token)
    except Exception as e:
        logger.warning(f"Failed to send verification email to {user.email}: {e}")

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        email_verified=False,
    )


@router.post("/login", response_model=TokenResponseWithVerification)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    """Authenticate with email and password."""
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not user.hashed_password or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        email_verified=user.email_verified,
    )


@router.post("/google", response_model=TokenResponseWithVerification)
def google_auth(body: GoogleAuthRequest, db: Session = Depends(get_db)):
    """Authenticate or register with a Google ID token."""
    if not GOOGLE_CLIENT_ID:
        logger.error("GOOGLE_CLIENT_ID env var is not set")
        raise HTTPException(status_code=500, detail="Google OAuth not configured on server")

    # Verify the token with Google's tokeninfo endpoint
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(
                GOOGLE_TOKEN_INFO_URL,
                params={"id_token": body.credential},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to reach Google token verification: {e}")
        raise HTTPException(status_code=502, detail="Could not verify Google token")

    if resp.status_code != 200:
        logger.warning(f"Google token verification failed: {resp.status_code} {resp.text}")
        raise HTTPException(status_code=401, detail="Invalid Google token")

    idinfo = resp.json()

    # Verify the token was issued for our app
    token_aud = idinfo.get("aud")
    if token_aud != GOOGLE_CLIENT_ID:
        logger.warning(f"Token audience mismatch: got {token_aud}, expected {GOOGLE_CLIENT_ID}")
        raise HTTPException(status_code=401, detail="Token not issued for this application")

    email = idinfo.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Google account has no email")

    if idinfo.get("email_verified") != "true":
        raise HTTPException(status_code=401, detail="Google email not verified")

    # Find or create user
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            email=email,
            hashed_password=None,
            auth_provider="google",
            first_name=idinfo.get("given_name", ""),
            last_name=idinfo.get("family_name", ""),
            profile_image_url=idinfo.get("picture", ""),
            email_verified=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        logger.info(f"New Google user registered: {user.email}")
    else:
        # Update profile image from Google if not set
        if not user.profile_image_url and idinfo.get("picture"):
            user.profile_image_url = idinfo["picture"]
        if not user.first_name and idinfo.get("given_name"):
            user.first_name = idinfo["given_name"]
        if not user.last_name and idinfo.get("family_name"):
            user.last_name = idinfo["family_name"]
        db.commit()
        db.refresh(user)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        email_verified=True,
    )


@router.post("/refresh", response_model=TokenResponseWithVerification)
def refresh(body: RefreshRequest, db: Session = Depends(get_db)):
    """Exchange a valid refresh token for a new token pair."""
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return TokenResponseWithVerification(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id),
        email_verified=user.email_verified,
    )


@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    """Return the current authenticated user's profile."""
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "profile_image_url": user.profile_image_url,
        "email_verified": user.email_verified,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.put("/me")
def update_me(
    body: ProfileUpdate,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Update the current user's profile fields."""
    if body.first_name is not None:
        user.first_name = body.first_name
    if body.last_name is not None:
        user.last_name = body.last_name
    if body.profile_image_url is not None:
        user.profile_image_url = body.profile_image_url
    db.commit()
    db.refresh(user)
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "profile_image_url": user.profile_image_url,
        "email_verified": user.email_verified,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.post("/verify-email", response_model=TokenResponseWithVerification)
def verify_email(body: VerifyEmailRequest, db: Session = Depends(get_db)):
    """Verify a user's email with the provided token."""
    user, error = verify_token(body.token, db)

    if error is not None:
        if "expired" in error.lower():
            raise HTTPException(status_code=410, detail=error)
        raise HTTPException(status_code=400, detail=error)

    # Check if already verified
    if user.email_verified:
        raise HTTPException(status_code=400, detail="Email is already verified")

    # Mark user as verified
    mark_verified(user, db)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        email_verified=True,
    )


@router.post("/resend-verification", response_model=ResendVerificationResponse)
def resend_verification(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Resend verification email to the authenticated user."""
    # Check if already verified
    if user.email_verified:
        raise HTTPException(status_code=400, detail="Email is already verified")

    # Check rate limit
    allowed, retry_after = can_resend(user)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": "Please wait before requesting another email", "retry_after": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    # Generate new token and send email
    token = create_verification_token(user, db)
    success = email_service.send_verification_email(user.email, token)

    if not success:
        raise HTTPException(
            status_code=500,
            detail="Failed to send verification email. Please try again later.",
        )

    return ResendVerificationResponse(message="Verification email sent")
