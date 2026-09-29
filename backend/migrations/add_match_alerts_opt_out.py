"""
Migration: per-account opt-out for match-alert emails.

Adds user_settings.match_alerts_enabled (BOOLEAN NOT NULL DEFAULT TRUE). TRUE
keeps today's behaviour for every existing account: the sweep has emailed
every verified user with a resume since alerts shipped, and this column only
gives them a way out (the unsubscribe link every alert now carries, and the
Settings toggle). Existing rows take TRUE from the column default; an account
with no user_settings row at all is treated as opted in by every reader.

DDL only, no backfill. Idempotent: once the column exists it sends no DDL at
all. Runs on app startup, before any request, so the ORM model (which maps the
column on every UserSettings query, GET /settings included) never selects a
missing column.

Same first-deploy guard as add_listing_probe_columns: every cold-starting
lambda runs this at once, so on Postgres each caps its lock wait (an ALTER
queued behind an open transaction on user_settings would stall every settings
read queued behind it) and the instances take turns on an advisory lock,
after which IF NOT EXISTS turns the losers' ALTER into a no-op instead of a
duplicate-column crash. NOT NULL DEFAULT TRUE is a catalog-only change on
Postgres 11+ (no table rewrite). A failure is not swallowed: startup fails and
the next cold start retries.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

COLUMN = "match_alerts_enabled"
DDL = "BOOLEAN NOT NULL DEFAULT TRUE"

LOCK_TIMEOUT = "5s"
# Arbitrary, unique to this migration: serializes concurrent cold starts.
_ADVISORY_LOCK_KEY = 7_311_027_530_052


def run_migration(engine=None) -> None:
    """Add user_settings.match_alerts_enabled if it is missing."""
    engine = engine or default_engine
    inspector = inspect(engine)
    if "user_settings" not in inspector.get_table_names():
        logger.info("Match-alert opt-out migration skipped: user_settings missing.")
        return
    if COLUMN in {col["name"] for col in inspector.get_columns("user_settings")}:
        return

    postgres = engine.dialect.name == "postgresql"
    with engine.begin() as conn:
        if postgres:
            conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ADVISORY_LOCK_KEY})
        # SQLite (tests, local dev) has no ADD COLUMN IF NOT EXISTS.
        if_not_exists = "IF NOT EXISTS " if postgres else ""
        conn.execute(text(f"ALTER TABLE user_settings ADD COLUMN {if_not_exists}{COLUMN} {DDL}"))
    logger.info("Ensured user_settings.%s", COLUMN)
