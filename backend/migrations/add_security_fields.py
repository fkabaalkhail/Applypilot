"""
Migration: Add security fields for rate limiting, account lockout, and token revocation.

Adds to users table:
  - failed_login_attempts (Integer, default 0)
  - locked_until (DateTime, nullable)
  - last_failed_login_at (DateTime, nullable)

Creates new table:
  - revoked_tokens (id, jti, user_id, revoked_at, expires_at)

Idempotent: skips if columns/tables already exist.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add security columns and tables."""
    inspector = inspect(engine)

    # --- Users table: account lockout fields ---
    if "users" in inspector.get_table_names():
        existing_columns = {col["name"] for col in inspector.get_columns("users")}

        with engine.begin() as conn:
            if "failed_login_attempts" not in existing_columns:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0")
                )
                logger.info("Added column: failed_login_attempts")

            if "locked_until" not in existing_columns:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN locked_until TIMESTAMP NULL")
                )
                logger.info("Added column: locked_until")

            if "last_failed_login_at" not in existing_columns:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN last_failed_login_at TIMESTAMP NULL")
                )
                logger.info("Added column: last_failed_login_at")

    # --- Revoked tokens table ---
    if "revoked_tokens" not in inspector.get_table_names():
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE revoked_tokens (
                    id SERIAL PRIMARY KEY,
                    jti VARCHAR(255) NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL,
                    revoked_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMP NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE INDEX ix_revoked_tokens_jti ON revoked_tokens (jti)
            """))
            conn.execute(text("""
                CREATE INDEX ix_revoked_tokens_user_id ON revoked_tokens (user_id)
            """))
            logger.info("Created table: revoked_tokens")

    # --- Security audit log table ---
    if "security_events" not in inspector.get_table_names():
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE security_events (
                    id SERIAL PRIMARY KEY,
                    event_type VARCHAR(100) NOT NULL,
                    user_id INTEGER NULL,
                    ip_address VARCHAR(45) NULL,
                    user_agent TEXT NULL,
                    details JSONB NULL,
                    success BOOLEAN NOT NULL DEFAULT true,
                    created_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("""
                CREATE INDEX ix_security_events_event_type ON security_events (event_type)
            """))
            conn.execute(text("""
                CREATE INDEX ix_security_events_user_id ON security_events (user_id)
            """))
            conn.execute(text("""
                CREATE INDEX ix_security_events_created_at ON security_events (created_at)
            """))
            logger.info("Created table: security_events")

    logger.info("Security migration completed successfully.")
