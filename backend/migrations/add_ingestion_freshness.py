"""
Migration: ingestion freshness + structured-extraction fields on scraped_jobs.

Adds:
  - listing lifecycle: listing_status, listing_status_changed_at,
    first_seen_at, last_seen_at, board_key, external_id
  - change detection: raw_hash, edit_count, change_log
  - ghost heuristic: ghost_risk_score, ghost_risk_factors
  - trust: source_trust
  - structured extraction: salary_min/max/currency/period, employment_type,
    visa_sponsorship, skills

Backfills (single UPDATE each, only rows that predate the migration):
  - first_seen_at / last_seen_at from scraped_at
  - source_trust from source_platform (ats=high, github=medium, rest=low)

Idempotent: skips columns that already exist. Runs on app startup so the ORM
model never queries a missing column. The source_health table itself is
created by Base.metadata.create_all before migrations run.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)

_NEW_COLUMNS = {
    "listing_status": "VARCHAR DEFAULT 'active'",
    "listing_status_changed_at": "TIMESTAMP",
    "first_seen_at": "TIMESTAMP",
    "last_seen_at": "TIMESTAMP",
    "board_key": "VARCHAR DEFAULT ''",
    "external_id": "VARCHAR DEFAULT ''",
    "raw_hash": "VARCHAR DEFAULT ''",
    "edit_count": "INTEGER DEFAULT 0",
    "change_log": "JSON",
    "ghost_risk_score": "INTEGER DEFAULT 0",
    "ghost_risk_factors": "JSON",
    "source_trust": "VARCHAR DEFAULT ''",
    "salary_min": "INTEGER",
    "salary_max": "INTEGER",
    "salary_currency": "VARCHAR DEFAULT ''",
    "salary_period": "VARCHAR DEFAULT ''",
    "employment_type": "VARCHAR DEFAULT ''",
    "visa_sponsorship": "VARCHAR DEFAULT 'unknown'",
    "skills": "JSON",
}

_INDEXES = {
    "ix_scraped_jobs_listing_status": "listing_status",
    "ix_scraped_jobs_last_seen_at": "last_seen_at",
    "ix_scraped_jobs_board_key": "board_key",
    "ix_scraped_jobs_external_id": "external_id",
}


def run_migration() -> None:
    """Add freshness/extraction columns to scraped_jobs if missing."""
    inspector = inspect(engine)

    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Migration skipped: 'scraped_jobs' table does not exist yet.")
        return

    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    added: list[str] = []

    with engine.begin() as conn:
        for name, ddl in _NEW_COLUMNS.items():
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {name} {ddl}"))
            added.append(name)
            logger.info("Added scraped_jobs.%s", name)

        for index_name, column in _INDEXES.items():
            conn.execute(text(
                f"CREATE INDEX IF NOT EXISTS {index_name} ON scraped_jobs ({column})"
            ))

        # Backfills only touch rows the new defaults left NULL/empty — a
        # re-run after the columns exist matches zero rows and costs nothing.
        conn.execute(text(
            "UPDATE scraped_jobs SET first_seen_at = scraped_at "
            "WHERE first_seen_at IS NULL AND scraped_at IS NOT NULL"
        ))
        conn.execute(text(
            "UPDATE scraped_jobs SET last_seen_at = scraped_at "
            "WHERE last_seen_at IS NULL AND scraped_at IS NOT NULL"
        ))
        conn.execute(text(
            "UPDATE scraped_jobs SET listing_status = 'active' "
            "WHERE listing_status IS NULL OR listing_status = ''"
        ))
        conn.execute(text(
            "UPDATE scraped_jobs SET source_trust = CASE "
            "WHEN source_platform = 'ats' THEN 'high' "
            "WHEN source_platform = 'github' THEN 'medium' "
            "ELSE 'low' END "
            "WHERE source_trust IS NULL OR source_trust = ''"
        ))

    if added:
        logger.info("Ingestion freshness migration added columns: %s", ", ".join(added))
