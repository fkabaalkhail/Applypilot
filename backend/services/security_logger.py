"""
Structured security event logging service.

Logs authentication events, access control decisions, and security-relevant
actions to the security_events table for audit and anomaly detection.
"""

import logging
from typing import Optional

from fastapi import Request
from sqlalchemy.orm import Session

from backend.db.models import SecurityEvent

logger = logging.getLogger(__name__)


class SecurityLogger:
    """Logs structured security events to the database."""

    # Event type constants
    LOGIN_SUCCESS = "login_success"
    LOGIN_FAILED = "login_failed"
    REGISTER = "register"
    LOGOUT = "logout"
    TOKEN_REFRESH = "token_refresh"
    TOKEN_REVOKED = "token_revoked"
    ACCOUNT_LOCKED = "account_locked"
    ACCOUNT_UNLOCKED = "account_unlocked"
    PASSWORD_CHANGE = "password_change"
    RATE_LIMITED = "rate_limited"
    GOOGLE_AUTH = "google_auth"
    EXTENSION_AUTHORIZE = "extension_authorize"  # web session issued a handshake code
    EXTENSION_TOKEN = "extension_token"          # extension redeemed a code for tokens

    @staticmethod
    def get_client_ip(request: Request) -> str:
        """Extract client IP from request, respecting X-Forwarded-For."""
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        if request.client:
            return request.client.host
        return "unknown"

    @staticmethod
    def get_user_agent(request: Request) -> str:
        """Extract user agent from request."""
        return request.headers.get("user-agent", "unknown")

    @staticmethod
    def log_event(
        db: Session,
        event_type: str,
        request: Request,
        user_id: Optional[int] = None,
        success: bool = True,
        details: Optional[dict] = None,
    ) -> None:
        """Log a security event to the database.

        Fire-and-forget: errors are logged but don't propagate.
        """
        try:
            event = SecurityEvent(
                event_type=event_type,
                user_id=user_id,
                ip_address=SecurityLogger.get_client_ip(request),
                user_agent=SecurityLogger.get_user_agent(request),
                success=success,
                details=details,
            )
            db.add(event)
            db.commit()
        except Exception as e:
            logger.warning(f"Failed to log security event: {e}")
            try:
                db.rollback()
            except Exception:
                pass


security_logger = SecurityLogger()
