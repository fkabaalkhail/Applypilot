"""Session registry helpers — create / look up / touch / revoke sessions.

A session is a long-lived auth grant keyed by a stable ``sid`` that survives
refresh-token rotation. Backs the "Connected Devices" dashboard.
"""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import Request
from sqlalchemy.orm import Session as DbSession

from backend.db.models import Session as SessionModel


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    client = getattr(request, "client", None)
    return getattr(client, "host", None) if client else None


def _user_agent(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    return ua[:1024] if ua else None  # store raw, just bound the length


def start_session(db: DbSession, user_id: int, client: str, request: Optional[Request]) -> SessionModel:
    """Create and persist a new active session; returns it with its ``sid`` set."""
    now = datetime.utcnow()
    session = SessionModel(
        sid=uuid.uuid4().hex,
        user_id=user_id,
        client=client,
        created_at=now,
        last_seen_at=now,
        last_ip=_client_ip(request),
        user_agent=_user_agent(request),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def get_active(db: DbSession, sid: str) -> Optional[SessionModel]:
    """Return the session for ``sid`` only if it exists and is not revoked."""
    return (
        db.query(SessionModel)
        .filter(SessionModel.sid == sid, SessionModel.revoked_at.is_(None))
        .first()
    )


def touch(db: DbSession, session: SessionModel) -> None:
    """Record activity on a session (called on each successful refresh)."""
    session.last_seen_at = datetime.utcnow()
    db.commit()


def revoke(db: DbSession, session: SessionModel) -> None:
    """Mark a session revoked; its next refresh will be rejected."""
    session.revoked_at = datetime.utcnow()
    db.commit()
