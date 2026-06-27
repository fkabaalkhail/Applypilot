"""
Migration: Extension auth codes (PKCE handshake).

Creates the ``extension_auth_codes`` table backing the credential-free
extension↔web authentication handshake:

  - id (PK)
  - code (unique, indexed)        — the one-time authorization code
  - user_id (FK users.id)         — who authorized
  - code_challenge                — base64url SHA-256 of the PKCE verifier
  - redirect_uri                  — the extension chromiumapp.org URL it was issued for
  - used (bool)                   — flipped true on redemption (single use)
  - expires_at (TIMESTAMP)        — ~60s after issue
  - created_at (TIMESTAMP)

Idempotent: only creates the table when truly absent. The raw Postgres DDL
(SERIAL, NOW()) must never reach SQLite, so we guard on the inspector rather
than CREATE TABLE IF NOT EXISTS — in tests create_all() has already built the
table from the model, so this branch is skipped there. Additive only.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Create the extension_auth_codes table if it does not exist."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "extension_auth_codes" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE extension_auth_codes (
                    id SERIAL PRIMARY KEY,
                    code VARCHAR(255) NOT NULL UNIQUE,
                    user_id INTEGER NOT NULL,
                    code_challenge VARCHAR(255) NOT NULL,
                    redirect_uri VARCHAR NOT NULL,
                    used BOOLEAN NOT NULL DEFAULT FALSE,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            logger.info("Created table: extension_auth_codes")

    # Indexes are safe to (re)create on both Postgres and SQLite.
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_extension_auth_codes_code "
            "ON extension_auth_codes (code)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_extension_auth_codes_user_id "
            "ON extension_auth_codes (user_id)"
        ))

    logger.info("Extension auth codes migration completed successfully.")
