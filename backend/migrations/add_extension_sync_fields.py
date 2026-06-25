"""
Migration: Extension sync foundations (Phase 0).

Adds to resume_profiles (original uploaded file, stored in Vercel Blob):
  - file_blob_url (Text, nullable)
  - file_name (String, nullable)
  - file_content_type (String, nullable)
  - file_size (Integer, nullable)
  - file_uploaded_at (TIMESTAMP, nullable)

Adds to user_settings (sync version anchor):
  - data_version (Integer, NOT NULL, default 1)
  - data_updated_at (TIMESTAMP, nullable)

Creates / reconciles table:
  - cover_letters (id, user_id, resume_id, job_id, job_title, company, job_url,
                   text, tone, source, is_active, created_at, updated_at) + indexes
    An experimental cover_letters table already exists on some branches with a
    subset of these columns; this migration adds whatever is missing so dev and
    prod converge on the same shape.

Idempotent: skips columns/tables/indexes that already exist. Safe to run on
every boot. Additive only — no data is dropped, so rollback is trivial.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def _columns(inspector, table: str) -> set[str]:
    if table not in inspector.get_table_names():
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def run_migration() -> None:
    """Apply the extension-sync schema additions."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    # --- resume_profiles: original file reference -------------------------------
    if "resume_profiles" in tables:
        cols = _columns(inspector, "resume_profiles")
        additions = {
            "file_blob_url": "ALTER TABLE resume_profiles ADD COLUMN file_blob_url TEXT",
            "file_name": "ALTER TABLE resume_profiles ADD COLUMN file_name VARCHAR",
            "file_content_type": "ALTER TABLE resume_profiles ADD COLUMN file_content_type VARCHAR",
            "file_size": "ALTER TABLE resume_profiles ADD COLUMN file_size INTEGER",
            "file_uploaded_at": "ALTER TABLE resume_profiles ADD COLUMN file_uploaded_at TIMESTAMP",
        }
        with engine.begin() as conn:
            for col, ddl in additions.items():
                if col not in cols:
                    conn.execute(text(ddl))
                    logger.info("Added column resume_profiles.%s", col)

    # --- user_settings: sync version anchor -------------------------------------
    if "user_settings" in tables:
        cols = _columns(inspector, "user_settings")
        with engine.begin() as conn:
            if "data_version" not in cols:
                conn.execute(text(
                    "ALTER TABLE user_settings ADD COLUMN data_version INTEGER NOT NULL DEFAULT 1"
                ))
                logger.info("Added column user_settings.data_version")
            if "data_updated_at" not in cols:
                conn.execute(text(
                    "ALTER TABLE user_settings ADD COLUMN data_updated_at TIMESTAMP"
                ))
                logger.info("Added column user_settings.data_updated_at")

    # --- cover_letters table ----------------------------------------------------
    # Create it only when truly absent (fresh / prod). The raw Postgres DDL
    # (SERIAL, NOW()) must never reach SQLite, so we guard on the inspector
    # rather than CREATE TABLE IF NOT EXISTS — in tests create_all() has already
    # built the table from the model, so this branch is skipped there.
    if "cover_letters" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE cover_letters (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    resume_id INTEGER NULL,
                    job_id INTEGER NULL,
                    job_title VARCHAR DEFAULT '',
                    company VARCHAR DEFAULT '',
                    job_url VARCHAR DEFAULT '',
                    text TEXT DEFAULT '',
                    tone VARCHAR DEFAULT '',
                    source VARCHAR DEFAULT 'generated',
                    is_active INTEGER DEFAULT 0,
                    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            logger.info("Created table: cover_letters")

    # Re-inspect: the table may have pre-existed with a different shape.
    cl_cols = _columns(inspect(engine), "cover_letters")
    cl_additions = {
        "resume_id": "ALTER TABLE cover_letters ADD COLUMN resume_id INTEGER",
        "job_id": "ALTER TABLE cover_letters ADD COLUMN job_id INTEGER",
        "job_title": "ALTER TABLE cover_letters ADD COLUMN job_title VARCHAR DEFAULT ''",
        "company": "ALTER TABLE cover_letters ADD COLUMN company VARCHAR DEFAULT ''",
        "job_url": "ALTER TABLE cover_letters ADD COLUMN job_url VARCHAR DEFAULT ''",
        "text": "ALTER TABLE cover_letters ADD COLUMN text TEXT DEFAULT ''",
        "tone": "ALTER TABLE cover_letters ADD COLUMN tone VARCHAR DEFAULT ''",
        "source": "ALTER TABLE cover_letters ADD COLUMN source VARCHAR DEFAULT 'generated'",
        "is_active": "ALTER TABLE cover_letters ADD COLUMN is_active INTEGER DEFAULT 0",
        "updated_at": "ALTER TABLE cover_letters ADD COLUMN updated_at TIMESTAMP",
    }
    with engine.begin() as conn:
        for col, ddl in cl_additions.items():
            if col not in cl_cols:
                conn.execute(text(ddl))
                logger.info("Added column cover_letters.%s", col)
        # CREATE INDEX IF NOT EXISTS is supported by both Postgres and SQLite.
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_cover_letters_user_id ON cover_letters (user_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_cover_letters_job_id ON cover_letters (job_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_cover_letters_user_active ON cover_letters (user_id, is_active)"
        ))

    logger.info("Extension sync migration completed successfully.")
