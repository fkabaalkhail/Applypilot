"""
Migration: listing probe stamp on scraped_jobs.

Adds last_probed_at (+ index): when the freshness verifier last checked a
posting against its platform, whatever the answer. It used to stamp
last_seen_at instead, so a probe that learned nothing (a bot wall, an SPA
shell) passed for a board confirmation; last_seen_at now moves only on
positive evidence and the verifier rotates on last_probed_at.

DDL only, no backfill: NULL simply means "never probed", which sorts first.
Idempotent: skips the column when it already exists. Runs on app startup so
the ORM model never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "last_probed_at": "TIMESTAMP",
}


def run_migration() -> None:
    """Add the listing probe columns to scraped_jobs if missing."""
    inspector = inspect(engine)
    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Listing probe migration skipped: scraped_jobs missing.")
        return
    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    with engine.begin() as conn:
        for name, ddl in _COLUMNS.items():
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {name} {ddl}"))
            logger.info("Added scraped_jobs.%s", name)
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_scraped_jobs_last_probed_at "
            "ON scraped_jobs (last_probed_at)"
        ))
