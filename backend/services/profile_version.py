"""
Profile sync version anchor.

Every change to a user's synced data (profile fields, resumes, cover letters)
bumps ``user_settings.data_version``. The Chrome extension polls the cheap
``GET /api/user/profile-version`` endpoint and only re-downloads the full
profile when the version changed — keeping sync feeling instant without
persistent connections or wasteful refetches.
"""

import datetime
import logging

from sqlalchemy.orm import Session

from backend.db.models import UserSettings

logger = logging.getLogger(__name__)


def bump_profile_version(db: Session, user_id: int | None) -> int:
    """Increment the user's sync version, creating a settings row if needed.

    Commits its own change and is best-effort: it must never break the primary
    write it accompanies, so all failures are swallowed (logged + rolled back).
    Call this AFTER the main ``db.commit()`` of the change it tracks.

    Returns the new version (or 0 on no-op / failure).
    """
    if user_id is None:
        return 0
    try:
        settings = (
            db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
        )
        now = datetime.datetime.utcnow()
        if settings is None:
            settings = UserSettings(user_id=user_id, data_version=1, data_updated_at=now)
            db.add(settings)
        else:
            settings.data_version = (settings.data_version or 0) + 1
            settings.data_updated_at = now
        db.commit()
        return settings.data_version or 1
    except Exception:
        logger.warning("Failed to bump profile version for user %s", user_id, exc_info=True)
        db.rollback()
        return 0


def get_profile_version(
    db: Session, user_id: int
) -> tuple[int, datetime.datetime | None]:
    """Return ``(version, updated_at)`` for cheap staleness polling."""
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if settings is None:
        return 1, None
    return (settings.data_version or 1), settings.data_updated_at
