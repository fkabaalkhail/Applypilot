"""
Migration: scraped_jobs.match_terms, the per-job input to the free local
match scorer (services/local_match.py).

The local scorer reads each job's 40 most frequent content words. Computing
them needs the full description, and pulling every description for every user
on every sweep is the egress pattern that cost 4.9 GB in July. So each job's
terms are computed ONCE (lazily, by the sweep) and stored here; per-user
scoring then reads a few hundred bytes per job instead of the whole posting.

Adds a nullable JSON column: NULL means "not computed yet". DDL only, no
backfill (the sweep fills rows as it meets them). Same first-deploy guard as
add_match_alerts_opt_out: capped lock wait, advisory lock across concurrent
cold starts, IF NOT EXISTS. A nullable ADD COLUMN is catalog-only on
Postgres, no table rewrite.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

COLUMN = "match_terms"
DDL = "JSON"

LOCK_TIMEOUT = "5s"
# Arbitrary, unique to this migration: serializes concurrent cold starts.
_ADVISORY_LOCK_KEY = 7_311_027_530_101


def run_migration(engine=None) -> None:
    """Add scraped_jobs.match_terms if it is missing."""
    engine = engine or default_engine
    inspector = inspect(engine)
    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Job match-terms migration skipped: scraped_jobs missing.")
        return
    if COLUMN in {col["name"] for col in inspector.get_columns("scraped_jobs")}:
        return

    postgres = engine.dialect.name == "postgresql"
    with engine.begin() as conn:
        if postgres:
            conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ADVISORY_LOCK_KEY})
        if_not_exists = "IF NOT EXISTS " if postgres else ""
        conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {if_not_exists}{COLUMN} {DDL}"))
    logger.info("Ensured scraped_jobs.%s", COLUMN)
