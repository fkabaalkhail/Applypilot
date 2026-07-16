"""
Per-board source health: consecutive-failure tracking + circuit breaker.

A board that 404s (renamed slug), 500s, or changed its response shape would
otherwise burn budget every single run and fail silently forever. Every board
outcome lands in source_health; after FAILURE_THRESHOLD consecutive failures
the board is skipped until COOLDOWN_HOURS pass, then retried automatically.
The table doubles as the dead-letter view: /jobs/ingest-metrics surfaces the
currently-broken boards with their last error.
"""

from __future__ import annotations

import datetime

from sqlalchemy.orm import Session

from backend.db.models import SourceHealth

FAILURE_THRESHOLD = 5
COOLDOWN_HOURS = 24


def _utcnow() -> datetime.datetime:
    return datetime.datetime.utcnow()


def in_cooldown(health: SourceHealth | None, now: datetime.datetime | None = None) -> bool:
    """True when the board's breaker is open: threshold reached and the
    cooldown window since the last failure hasn't elapsed."""
    if health is None or health.consecutive_failures < FAILURE_THRESHOLD:
        return False
    if health.last_failure_at is None:
        return False
    now = now or _utcnow()
    return (now - health.last_failure_at) < datetime.timedelta(hours=COOLDOWN_HOURS)


def get_health_map(db: Session, board_keys: list[str]) -> dict[str, SourceHealth]:
    """One query for the shard's health rows instead of one per board."""
    if not board_keys:
        return {}
    rows = db.query(SourceHealth).filter(SourceHealth.board_key.in_(board_keys)).all()
    return {row.board_key: row for row in rows}


def record_success(db: Session, board_key: str, platform: str, slug: str,
                   job_count: int, now: datetime.datetime | None = None) -> None:
    """Reset the failure streak. Commits."""
    now = now or _utcnow()
    health = db.query(SourceHealth).filter(SourceHealth.board_key == board_key).first()
    if health is None:
        health = SourceHealth(board_key=board_key, platform=platform, slug=slug)
        db.add(health)
    health.consecutive_failures = 0
    health.last_error = ""
    health.last_success_at = now
    health.last_job_count = job_count
    db.commit()


def record_failure(db: Session, board_key: str, platform: str, slug: str,
                   error: str, now: datetime.datetime | None = None) -> None:
    """Bump the failure streak. Commits."""
    now = now or _utcnow()
    health = db.query(SourceHealth).filter(SourceHealth.board_key == board_key).first()
    if health is None:
        health = SourceHealth(board_key=board_key, platform=platform, slug=slug)
        db.add(health)
    health.consecutive_failures = (health.consecutive_failures or 0) + 1
    health.total_failures = (health.total_failures or 0) + 1
    health.last_error = (error or "")[:500]
    health.last_failure_at = now
    db.commit()
