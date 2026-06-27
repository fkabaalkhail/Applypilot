"""
Migration: Add company_domain and company_url to scraped_jobs.

Adds:
  - company_domain (VARCHAR, default '')
  - company_url (VARCHAR, default '')

Idempotent: skips columns that already exist. Runs on app startup so the
ORM model (which references these columns) never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add company_domain / company_url columns to scraped_jobs if missing."""
    inspector = inspect(engine)

    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Migration skipped: 'scraped_jobs' table does not exist yet.")
        return

    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    to_add = {
        "company_domain": "VARCHAR DEFAULT ''",
        "company_url": "VARCHAR DEFAULT ''",
    }

    with engine.begin() as conn:
        for name, ddl in to_add.items():
            if name in existing:
                logger.info("Column %s already exists, skipping.", name)
                continue
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {name} {ddl}"))
            logger.info("Added scraped_jobs.%s", name)
