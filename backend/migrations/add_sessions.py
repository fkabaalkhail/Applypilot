"""
Migration: Sessions registry (Connected Devices).

Creates the ``sessions`` table backing per-device session tracking + revocation:

  - id (PK)
  - sid (unique, indexed)   — stable session id across refresh rotation
  - user_id (FK users.id)   — owner
  - client                  — "web" | "extension"
  - created_at / last_seen_at (TIMESTAMP)
  - revoked_at (TIMESTAMP, nullable)  — set on revoke; null = active
  - last_ip / user_agent    — captured raw at creation, no parsing

Idempotent + additive: guard on the inspector so raw Postgres DDL never reaches
SQLite (tests build the table from the model via create_all()).
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Create the sessions table if it does not exist."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "sessions" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE sessions (
                    id SERIAL PRIMARY KEY,
                    sid VARCHAR(36) NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL,
                    client VARCHAR(20) NOT NULL DEFAULT 'web',
                    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMP,
                    last_ip VARCHAR(45),
                    user_agent TEXT
                )
            """))
            logger.info("Created table: sessions")

    with engine.begin() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_sessions_sid ON sessions (sid)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions (user_id)"
        ))

    logger.info("Sessions migration completed successfully.")
