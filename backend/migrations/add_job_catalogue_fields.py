"""
Migration: structured location + description-pipeline columns on scraped_jobs.

city/region/locations_json/location_search power exact token-boundary city
filtering (see services/location_parser.py). desc_fetch_attempts caps the
backfill cron's retries per job. description_sections caches the structured
(gpt-4o-mini) parse of the description for the detail view.

Idempotent: skips columns that already exist. Runs on app startup.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "city": "VARCHAR DEFAULT ''",
    "region": "VARCHAR DEFAULT ''",
    "locations_json": "JSON",
    "location_search": "TEXT DEFAULT ''",
    "desc_fetch_attempts": "INTEGER DEFAULT 0",
    "description_sections": "JSON",
    # Cross-source dedup (services/cross_source_dedup.py): normalized title
    # for twin lookups, and the id of the surviving row for hidden duplicates.
    "title_norm": "VARCHAR DEFAULT ''",
    "duplicate_of": "INTEGER",
}


def run_migration() -> None:
    """Add the job catalogue columns to scraped_jobs if missing."""
    inspector = inspect(engine)
    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Job catalogue migration skipped: scraped_jobs missing.")
        return
    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    with engine.begin() as conn:
        for name, ddl in _COLUMNS.items():
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {name} {ddl}"))
            logger.info("Added scraped_jobs.%s", name)
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_scraped_jobs_title_norm "
            "ON scraped_jobs (title_norm)"
        ))
