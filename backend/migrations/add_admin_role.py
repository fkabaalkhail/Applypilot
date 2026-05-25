"""
Migration: Add is_admin field to users table.

Adds:
  - is_admin (Boolean, NOT NULL, default false)

Idempotent: skips if column already exists.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add is_admin column to users table if it doesn't exist."""
    inspector = inspect(engine)

    if "users" not in inspector.get_table_names():
        logger.info("Migration skipped: 'users' table does not exist yet.")
        return

    existing_columns = {col["name"] for col in inspector.get_columns("users")}

    if "is_admin" in existing_columns:
        logger.info("Column is_admin already exists, skipping.")
        return

    with engine.begin() as conn:
        try:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false")
            )
            logger.info("Added column: is_admin")
        except Exception as e:
            logger.error(f"Admin role migration failed: {e}")
            raise

    logger.info("Admin role migration completed successfully.")
