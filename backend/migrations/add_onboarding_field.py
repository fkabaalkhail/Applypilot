"""
Migration: Add has_completed_onboarding field to users table.

Adds:
  - has_completed_onboarding (Boolean, NOT NULL, default false)

Idempotent: skips if column already exists.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add has_completed_onboarding column to users table if missing."""
    inspector = inspect(engine)

    if "users" not in inspector.get_table_names():
        logger.info("Onboarding migration skipped: 'users' table missing.")
        return

    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "has_completed_onboarding" in existing_columns:
        logger.info("Column has_completed_onboarding already exists, skipping.")
        return

    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN has_completed_onboarding "
                "BOOLEAN NOT NULL DEFAULT false"
            )
        )
    logger.info("Onboarding migration completed successfully.")
