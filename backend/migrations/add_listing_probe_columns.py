"""
Migration: listing probe stamp on scraped_jobs.

Adds last_probed_at (+ index): when the freshness verifier last checked a
posting against its platform, whatever the answer. It used to stamp
last_seen_at instead, so a probe that learned nothing (a bot wall, an SPA
shell) passed for a board confirmation; last_seen_at now moves only on
positive evidence and the verifier rotates on last_probed_at.

DDL only, no backfill: NULL simply means "never probed", which sorts first.
Idempotent: once the column and index exist it sends no DDL at all (even
CREATE INDEX IF NOT EXISTS locks scraped_jobs before it finds the index).
Runs on app startup so the ORM model never queries a missing column.

On Postgres this runs in every cold-starting lambda at once on the first
deploy, so each transaction caps its lock waits (an ALTER queued behind an
open transaction would otherwise stall every scraped_jobs query queued behind
it; a timed-out instance just leaves the work to the next cold start) and the
instances take turns on an advisory lock, after which IF NOT EXISTS turns the
losers' DDL into no-ops instead of a duplicate-column crash.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "last_probed_at": "TIMESTAMP",
}
_INDEX = "ix_scraped_jobs_last_probed_at"

LOCK_TIMEOUT = "5s"
# Arbitrary, unique to this migration: serializes concurrent cold starts.
_ADVISORY_LOCK_KEY = 7_311_027_530_001


def run_migration(engine=None) -> None:
    """Add the listing probe columns (and their index) to scraped_jobs if missing."""
    engine = engine or default_engine
    inspector = inspect(engine)
    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Listing probe migration skipped: scraped_jobs missing.")
        return
    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    missing = {name: ddl for name, ddl in _COLUMNS.items() if name not in existing}
    has_index = _INDEX in {index["name"] for index in inspector.get_indexes("scraped_jobs")}
    if not missing and has_index:
        return

    postgres = engine.dialect.name == "postgresql"
    with engine.begin() as conn:
        if postgres:
            conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ADVISORY_LOCK_KEY})
        # SQLite (tests, local dev) has no ADD COLUMN IF NOT EXISTS.
        if_not_exists = "IF NOT EXISTS " if postgres else ""
        for name, ddl in missing.items():
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {if_not_exists}{name} {ddl}"))
            logger.info("Ensured scraped_jobs.%s", name)
        conn.execute(text(
            f"CREATE INDEX IF NOT EXISTS {_INDEX} ON scraped_jobs (last_probed_at)"
        ))
