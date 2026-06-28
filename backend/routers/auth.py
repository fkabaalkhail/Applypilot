"""
Auth endpoints:
- POST /auth/register — create user, return tokens
- POST /auth/login — verify credentials, return tokens
- POST /auth/google — authenticate with Google ID token
- POST /auth/refresh — exchange refresh token for new token pair
- POST /auth/logout — revoke refresh token
- GET /auth/me — return authenticated user profile
- PUT /auth/me — update user profile fields
- POST /auth/verify-email — verify email with token
- POST /auth/resend-verification — resend verification email
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
import httpx

from backend.db.database import get_db
from backend.db.models import User, RevokedToken, Session as DBSession
from backend.auth.passwords import hash_password, verify_password
from backend.auth.tokens import (
    create_access_token, create_refresh_token, decode_token,
    REFRESH_TOKEN_EXPIRE_DAYS,
)
from backend.auth.dependencies import get_current_user, get_verified_user
from backend.services.verification_service import (
    create_verification_token,
    verify_token,
    can_resend,
    mark_verified,
)
from backend.services.email_service import email_service
from backend.services.rate_limiter import rate_limiter
from backend.services import sessions as session_service
from backend.services.security_logger import security_logger, SecurityLogger

logger = logging.getLogger(__name__)
router = APIRouter()

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo"

# Account lockout settings
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 15

IS_PRODUCTION = os.getenv("ENVIRONMENT") == "production"


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    """Set refresh token as HttpOnly secure cookie."""
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=IS_PRODUCTION,
        samesite="strict",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path="/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    """Clear the refresh token cookie."""
    response.delete_cookie(
        key="refresh_token",
        httponly=True,
        secure=IS_PRODUCTION,
        samesite="strict",
        path="/auth",
    )


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
    refresh_token: str = ""

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

class LogoutRequest(BaseModel):
    refresh_token: str = ""

class SessionInfo(BaseModel):
    sid: str
    client: str
    created_at: datetime
    last_seen_at: datetime
    last_ip: Optional[str] = None
    user_agent: Optional[str] = None
    is_current: bool = False

class SessionListResponse(BaseModel):
    sessions: list[SessionInfo]

class RevokeAllRequest(BaseModel):
    except_current: bool = False


# --- Endpoints ---

@router.post("/register", response_model=TokenResponseWithVerification)
def register(body: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    """Register a new user with email and password."""
    # Rate limit: 3 registrations per IP per minute
    rate_limiter.enforce(request, "register", max_requests=3, window_seconds=60)

    # Password complexity validation
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if not any(c.isupper() for c in body.password):
        raise HTTPException(status_code=422, detail="Password must contain at least one uppercase letter")
    if not any(c.islower() for c in body.password):
        raise HTTPException(status_code=422, detail="Password must contain at least one lowercase letter")
    if not any(c.isdigit() for c in body.password):
        raise HTTPException(status_code=422, detail="Password must contain at least one number")
    if not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?" for c in body.password):
        raise HTTPException(status_code=422, detail="Password must contain at least one special character")
    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(email=body.email, hashed_password=hash_password(body.password), auth_provider="local")
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info(f"New user registered: {user.email}")

    # Log security event
    security_logger.log_event(
        db, SecurityLogger.REGISTER, request,
        user_id=user.id, success=True,
        details={"email": user.email},
    )

    # Generate verification token and send email (fire-and-forget)
    try:
        token = create_verification_token(user, db)
        email_service.send_verification_email(user.email, token)
    except Exception as e:
        logger.warning(f"Failed to send verification email to {user.email}: {e}")

    _web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=_web_session.sid)
    _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=refresh_tok,
        email_verified=False,
    )


@router.post("/login", response_model=TokenResponseWithVerification)
def login(body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    """Authenticate with email and password."""
    # Rate limit: 5 login attempts per IP per minute
    rate_limiter.enforce(request, "login", max_requests=5, window_seconds=60)

    user = db.query(User).filter(User.email == body.email).first()
    if not user or not user.hashed_password:
        # Log failed attempt (unknown user)
        security_logger.log_event(
            db, SecurityLogger.LOGIN_FAILED, request,
            success=False, details={"reason": "invalid_credentials"},
        )
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Check account lockout
    if user.locked_until and user.locked_until > datetime.now(timezone.utc):
        remaining = int((user.locked_until - datetime.now(timezone.utc)).total_seconds())
        security_logger.log_event(
            db, SecurityLogger.LOGIN_FAILED, request,
            user_id=user.id, success=False,
            details={"reason": "account_locked", "locked_until": user.locked_until.isoformat()},
        )
        raise HTTPException(
            status_code=423,
            detail=f"Account locked due to too many failed attempts. Try again in {remaining // 60 + 1} minutes.",
        )

    if not verify_password(body.password, user.hashed_password):
        # Increment failed attempts
        user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
        user.last_failed_login_at = datetime.now(timezone.utc)

        # Lock account if threshold exceeded
        if user.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
            user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
            db.commit()
            security_logger.log_event(
                db, SecurityLogger.ACCOUNT_LOCKED, request,
                user_id=user.id, success=False,
                details={"failed_attempts": user.failed_login_attempts},
            )
            raise HTTPException(
                status_code=423,
                detail=f"Account locked due to too many failed attempts. Try again in {LOCKOUT_DURATION_MINUTES} minutes.",
            )

        db.commit()
        security_logger.log_event(
            db, SecurityLogger.LOGIN_FAILED, request,
            user_id=user.id, success=False,
            details={"failed_attempts": user.failed_login_attempts},
        )
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Successful login — reset failed attempts
    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_failed_login_at = None
    db.commit()

    security_logger.log_event(
        db, SecurityLogger.LOGIN_SUCCESS, request,
        user_id=user.id, success=True,
    )

    _web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=_web_session.sid)
    _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=refresh_tok,
        email_verified=user.email_verified,
    )


@router.post("/google", response_model=TokenResponseWithVerification)
def google_auth(body: GoogleAuthRequest, request: Request, response: Response, db: Session = Depends(get_db)):
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
        # Update profile info from Google if not set
        if not user.profile_image_url and idinfo.get("picture"):
            user.profile_image_url = idinfo["picture"]
        if not user.first_name and idinfo.get("given_name"):
            user.first_name = idinfo["given_name"]
        if not user.last_name and idinfo.get("family_name"):
            user.last_name = idinfo["family_name"]
        # Link Google auth and mark email as verified
        if user.auth_provider == "local":
            user.auth_provider = "google"
        if not user.email_verified:
            user.email_verified = True
        db.commit()
        db.refresh(user)

    _web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=_web_session.sid)
    _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=refresh_tok,
        email_verified=True,
    )


@router.post("/refresh", response_model=TokenResponseWithVerification)
def refresh(
    request: Request,
    response: Response,
    body: Optional[RefreshRequest] = None,
    refresh_token_cookie: Optional[str] = Cookie(None, alias="refresh_token"),
    db: Session = Depends(get_db),
):
    """Exchange a valid refresh token for a new token pair.

    Accepts refresh token from either request body or HttpOnly cookie.
    """
    # Get token from body or cookie
    raw_token = None
    if body and body.refresh_token:
        raw_token = body.refresh_token
    elif refresh_token_cookie:
        raw_token = refresh_token_cookie

    if not raw_token:
        raise HTTPException(status_code=401, detail="No refresh token provided")

    try:
        payload = decode_token(raw_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Check if token has been revoked
    jti = payload.get("jti")
    if jti:
        revoked = db.query(RevokedToken).filter(RevokedToken.jti == jti).first()
        if revoked:
            security_logger.log_event(
                db, SecurityLogger.TOKEN_REFRESH, request,
                user_id=int(payload["sub"]), success=False,
                details={"reason": "token_revoked"},
            )
            raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Preserve the issuing surface across rotation (web vs extension) so the
    # extension keeps its longer refresh TTL.
    client = payload.get("client", "web")

    # Session registry gate (Connected Devices). A token with a sid must map to a
    # live session; revoked/unknown => 401. Legacy tokens (no sid) are migrated:
    # a fresh session is created so existing users aren't logged out by deploy.
    sid = payload.get("sid")
    if sid:
        session = session_service.get_active(db, sid)
        if session is None:
            if jti:
                db.add(RevokedToken(
                    jti=jti,
                    user_id=user_id,
                    expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
                ))
                db.commit()
            security_logger.log_event(
                db, SecurityLogger.TOKEN_REFRESH, request,
                user_id=user_id, success=False,
                details={"reason": "session_revoked_or_unknown"},
            )
            raise HTTPException(status_code=401, detail="Session has been revoked")
        session_service.touch(db, session)
    else:
        session = session_service.start_session(db, user_id, client, request)
        sid = session.sid

    # Revoke the old refresh token (rotation)
    if jti:
        revoked_token = RevokedToken(
            jti=jti,
            user_id=user_id,
            expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
        )
        db.add(revoked_token)
        db.commit()

    security_logger.log_event(
        db, SecurityLogger.TOKEN_REFRESH, request,
        user_id=user_id, success=True,
    )

    refresh_tok = create_refresh_token(user_id, client=client, sid=sid)
    # Only the web client uses the HttpOnly cookie; the extension carries the
    # token in the response body and stores it itself.
    if client != "extension":
        _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user_id, client=client),
        refresh_token=refresh_tok,
        email_verified=user.email_verified,
    )


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    body: Optional[LogoutRequest] = None,
    refresh_token_cookie: Optional[str] = Cookie(None, alias="refresh_token"),
    db: Session = Depends(get_db),
):
    """Revoke a refresh token (logout). Accepts token from body or cookie."""
    raw_token = None
    if body and body.refresh_token:
        raw_token = body.refresh_token
    elif refresh_token_cookie:
        raw_token = refresh_token_cookie

    # Always clear the cookie
    _clear_refresh_cookie(response)

    if not raw_token:
        return {"status": "logged_out"}

    try:
        payload = decode_token(raw_token)
        if payload.get("type") != "refresh":
            return {"status": "logged_out"}
    except Exception:
        # Even if token is invalid/expired, return success (idempotent logout)
        return {"status": "logged_out"}

    jti = payload.get("jti")
    user_id = int(payload["sub"])

    if jti:
        # Check if already revoked
        existing = db.query(RevokedToken).filter(RevokedToken.jti == jti).first()
        if not existing:
            revoked_token = RevokedToken(
                jti=jti,
                user_id=user_id,
                expires_at=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
            )
            db.add(revoked_token)
            db.commit()

    security_logger.log_event(
        db, SecurityLogger.LOGOUT, request,
        user_id=user_id, success=True,
    )

    return {"status": "logged_out"}


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
def verify_email(body: VerifyEmailRequest, request: Request, response: Response, db: Session = Depends(get_db)):
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

    _web_session = session_service.start_session(db, user.id, "web", request)
    refresh_tok = create_refresh_token(user.id, client="web", sid=_web_session.sid)
    _set_refresh_cookie(response, refresh_tok)

    return TokenResponseWithVerification(
        access_token=create_access_token(user.id),
        refresh_token=refresh_tok,
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


# --- Session management endpoints ---

@router.get("/sessions", response_model=SessionListResponse)
def list_sessions(
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """List the caller's active (non-revoked) sessions for Connected Devices."""
    rows = (
        db.query(DBSession)
        .filter(DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .order_by(DBSession.last_seen_at.desc())
        .all()
    )
    # is_current is always False: no dependency surfaces the caller's token sid claims.
    return SessionListResponse(
        sessions=[
            SessionInfo(
                sid=r.sid,
                client=r.client,
                created_at=r.created_at,
                last_seen_at=r.last_seen_at,
                last_ip=r.last_ip,
                user_agent=r.user_agent,
                is_current=False,
            )
            for r in rows
        ]
    )


@router.delete("/sessions/{sid}")
def revoke_session(
    sid: str,
    request: Request,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Revoke one of the caller's sessions."""
    row = (
        db.query(DBSession)
        .filter(DBSession.sid == sid, DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session_service.revoke(db, row)
    security_logger.log_event(db, SecurityLogger.LOGOUT, request, user_id=user.id, success=True)
    return {"status": "revoked"}


@router.post("/sessions/revoke-all")
def revoke_all_sessions(
    request: Request,
    body: Optional[RevokeAllRequest] = None,
    user: User = Depends(get_verified_user),
    db: Session = Depends(get_db),
):
    """Revoke all of the caller's active sessions ('sign out everywhere').

    Note: except_current=True has no effect because is_current tracking is not
    yet implemented (no dependency surfaces the caller's token sid claims).
    All active sessions are revoked regardless.
    """
    rows = (
        db.query(DBSession)
        .filter(DBSession.user_id == user.id, DBSession.revoked_at.is_(None))
        .all()
    )
    count = 0
    for r in rows:
        session_service.revoke(db, r)
        count += 1
    security_logger.log_event(db, SecurityLogger.LOGOUT, request, user_id=user.id, success=True)
    return {"revoked": count}
