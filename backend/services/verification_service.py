"""Verification token generation and validation."""

import secrets
import datetime
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from backend.db.models import User


TOKEN_LENGTH = 32
TOKEN_EXPIRY_HOURS = 24
RESEND_COOLDOWN_SECONDS = 60


def generate_token() -> str:
    """Generate a cryptographically random URL-safe token of exactly 32 characters."""
    return secrets.token_urlsafe(TOKEN_LENGTH)[:TOKEN_LENGTH]


def create_verification_token(user: User, db: Session) -> str:
    """
    Generate a new verification token for the user.
    Replaces any existing token.

    Args:
        user: The user to generate a token for.
        db: Database session.

    Returns:
        The generated token string.
    """
    token = generate_token()
    user.verification_token = token
    user.verification_token_expires_at = datetime.datetime.utcnow() + datetime.timedelta(
        hours=TOKEN_EXPIRY_HOURS
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return token


def verify_token(token: str, db: Session) -> Tuple[Optional[User], Optional[str]]:
    """
    Validate a verification token.

    Args:
        token: The token string to validate.
        db: Database session.

    Returns:
        Tuple of (user, error_message).
        On success: (user, None)
        On failure: (None, error_description)
    """
    user = db.query(User).filter(User.verification_token == token).first()

    if user is None:
        return (None, "Invalid verification token")

    now = datetime.datetime.utcnow()
    if user.verification_token_expires_at is None or now >= user.verification_token_expires_at:
        return (None, "Verification token has expired. Please request a new one.")

    return (user, None)


def can_resend(user: User) -> Tuple[bool, int]:
    """
    Check if the user can request a new verification email.

    Uses verification_token_expires_at - 23h59m to determine when the token
    was created, then checks if 60 seconds have passed since creation.

    Args:
        user: The user requesting resend.

    Returns:
        Tuple of (can_resend, remaining_seconds).
        If can_resend is False, remaining_seconds indicates wait time.
    """
    if user.verification_token_expires_at is None:
        # No token exists, user can request one
        return (True, 0)

    # Derive when the token was created:
    # token_created_at = expires_at - 24 hours
    token_created_at = user.verification_token_expires_at - datetime.timedelta(
        hours=TOKEN_EXPIRY_HOURS
    )

    now = datetime.datetime.utcnow()
    elapsed = (now - token_created_at).total_seconds()

    if elapsed >= RESEND_COOLDOWN_SECONDS:
        return (True, 0)

    remaining = int(RESEND_COOLDOWN_SECONDS - elapsed)
    # Ensure at least 1 second remaining if not yet elapsed
    if remaining <= 0:
        remaining = 1
    return (False, remaining)


def mark_verified(user: User, db: Session) -> None:
    """
    Mark a user as email-verified and clear token fields.

    Args:
        user: The user to mark as verified.
        db: Database session.
    """
    user.email_verified = True
    user.verification_token = None
    user.verification_token_expires_at = None
    db.add(user)
    db.commit()
    db.refresh(user)
