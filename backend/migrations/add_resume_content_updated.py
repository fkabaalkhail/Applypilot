"""
Migration: Add resume_profiles.content_updated_at.

Set whenever the structured content (profile fields, sections) is edited after
upload. The file-download endpoint uses it to decide between streaming the
original uploaded blob (never edited) and rendering the CURRENT document to PDF
(edited) — so the Chrome extension always attaches what the user last saw in
the web app.

Idempotent: skips when the column already exists. Runs on app startup so the
ORM model never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add content_updated_at to resume_profiles if missing."""
    inspector = inspect(engine)

    if "resume_profiles" not in inspector.get_table_names():
        logger.info("Resume content_updated_at migration skipped: table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("resume_profiles")}
    if "content_updated_at" in existing:
        logger.info("Column resume_profiles.content_updated_at already exists, skipping.")
        return

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE resume_profiles ADD COLUMN content_updated_at TIMESTAMP"))
    logger.info("Added resume_profiles.content_updated_at")
