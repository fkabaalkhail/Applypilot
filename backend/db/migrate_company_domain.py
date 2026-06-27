"""
Migration: add company_domain and company_url columns to scraped_jobs.

These support accurate, stable company logos resolved from the real company
website domain (rather than guessing from the company name).

Usage:
    python -m backend.db.migrate_company_domain

Supports both SQLite and PostgreSQL (Neon). Idempotent — safe to re-run.
"""

import os
import ssl
from sqlalchemy import create_engine, text, inspect


def get_database_url():
    """Get database URL from environment, matching backend/db/database.py logic."""
    database_url = os.getenv("DATABASE_URL", "sqlite:///./data/autoapply.db")

    if not database_url.startswith("sqlite"):
        database_url = database_url.split("?")[0]
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql+pg8000://", 1)
        elif database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgresql+pg8000://", 1)

    return database_url


def get_connect_args(database_url: str) -> dict:
    if database_url.startswith("sqlite"):
        return {"check_same_thread": False}
    ssl_context = ssl.create_default_context()
    return {"ssl_context": ssl_context}


def migrate():
    """Add company_domain / company_url columns if they don't exist."""
    database_url = get_database_url()
    connect_args = get_connect_args(database_url)
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
    inspector = inspect(engine)

    existing_tables = inspector.get_table_names()

    with engine.begin() as conn:
        if "scraped_jobs" in existing_tables:
            existing_cols = [c["name"] for c in inspector.get_columns("scraped_jobs")]
            new_cols = {
                "company_domain": "VARCHAR DEFAULT ''",
                "company_url": "VARCHAR DEFAULT ''",
            }
            for col_name, col_def in new_cols.items():
                if col_name not in existing_cols:
                    conn.execute(
                        text(f"ALTER TABLE scraped_jobs ADD COLUMN {col_name} {col_def}")
                    )
                    print(f"  Added scraped_jobs.{col_name}")
                else:
                    print(f"  scraped_jobs.{col_name} already exists, skipping")
        else:
            print("  Table 'scraped_jobs' does not exist yet — will be created by create_all")

    print("\nMigration complete: company_domain / company_url added.")


if __name__ == "__main__":
    migrate()
