"""
Migration script to add job aggregator classification fields.
Run once to add new columns to existing databases.
New databases get these columns automatically via create_all.

Usage:
    python -m backend.db.migrate_aggregator_fields

Supports both SQLite and PostgreSQL (Neon).
Idempotent — safe to run multiple times.
"""

import os
import ssl
from sqlalchemy import create_engine, text, inspect


def get_database_url():
    """Get database URL from environment, matching backend/db/database.py logic."""
    database_url = os.getenv("DATABASE_URL", "sqlite:///./data/autoapply.db")

    if not database_url.startswith("sqlite"):
        # Strip query params and rewrite for pg8000 driver
        database_url = database_url.split("?")[0]
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql+pg8000://", 1)
        elif database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgresql+pg8000://", 1)

    return database_url


def get_connect_args(database_url: str) -> dict:
    """Get connection args matching backend/db/database.py logic."""
    if database_url.startswith("sqlite"):
        return {"check_same_thread": False}
    else:
        ssl_context = ssl.create_default_context()
        return {"ssl_context": ssl_context}


def migrate():
    """Add aggregator classification columns if they don't exist."""
    database_url = get_database_url()
    connect_args = get_connect_args(database_url)
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
    inspector = inspect(engine)

    # Check that tables exist before attempting migration
    existing_tables = inspector.get_table_names()

    with engine.begin() as conn:
        # --- ScrapedJob columns ---
        if "scraped_jobs" in existing_tables:
            existing_cols = [c["name"] for c in inspector.get_columns("scraped_jobs")]

            new_scraped_job_cols = {
                "work_type": "VARCHAR DEFAULT 'onsite'",
                "role_category": "VARCHAR DEFAULT ''",
                "country": "VARCHAR DEFAULT ''",
                "experience_level": "VARCHAR DEFAULT ''",
            }

            for col_name, col_def in new_scraped_job_cols.items():
                if col_name not in existing_cols:
                    conn.execute(
                        text(f"ALTER TABLE scraped_jobs ADD COLUMN {col_name} {col_def}")
                    )
                    print(f"  Added scraped_jobs.{col_name}")
                else:
                    print(f"  scraped_jobs.{col_name} already exists, skipping")
        else:
            print("  Table 'scraped_jobs' does not exist yet — will be created by create_all")

        # --- GitHubSource columns ---
        if "github_sources" in existing_tables:
            existing_cols = [c["name"] for c in inspector.get_columns("github_sources")]

            new_github_source_cols = {
                "role_category": "VARCHAR DEFAULT ''",
                "experience_level": "VARCHAR DEFAULT ''",
            }

            for col_name, col_def in new_github_source_cols.items():
                if col_name not in existing_cols:
                    conn.execute(
                        text(f"ALTER TABLE github_sources ADD COLUMN {col_name} {col_def}")
                    )
                    print(f"  Added github_sources.{col_name}")
                else:
                    print(f"  github_sources.{col_name} already exists, skipping")
        else:
            print("  Table 'github_sources' does not exist yet — will be created by create_all")

    print("\nMigration complete: aggregator classification fields added.")


if __name__ == "__main__":
    migrate()
