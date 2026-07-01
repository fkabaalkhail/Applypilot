"""
Migration: Add has_completed_setup field to users table.

Adds:
  - has_completed_setup (Boolean, NOT NULL, default false)

Idempotent: skips if column already exists.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add has_completed_setup column to users table if missing."""
    inspector = inspect(engine)

    if "users" not in inspector.get_table_names():
        logger.info("Setup migration skipped: 'users' table missing.")
        return

    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "has_completed_setup" in existing_columns:
        logger.info("Column has_completed_setup already exists, skipping.")
        return

    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN has_completed_setup "
                "BOOLEAN NOT NULL DEFAULT false"
            )
        )
        # One-time backfill: existing/established users should never see the
        # new setup wizard, only new signups should. A user is "established"
        # if they already completed onboarding, or already uploaded a resume.
        # This runs exactly once, at column-add time, because the
        # column-exists guard above makes the whole migration a no-op on
        # every subsequent boot.
        conn.execute(
            text(
                "UPDATE users SET has_completed_setup = true "
                "WHERE has_completed_onboarding = true "
                "OR id IN (SELECT user_id FROM user_settings "
                "WHERE resume_file_path IS NOT NULL AND resume_file_path <> '')"
            )
        )
    logger.info("Setup migration completed successfully.")
