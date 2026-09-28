"""
Migration: company_logos, the self-hosted logo store.

One row per employer (normalized company name): the harvested logo's
normalized bytes, its sha1 (the served URL is /jobs/logo/<sha>.png), where it
came from, the verified domain, and the retry schedule for companies nothing
could be found for yet. See services/logo_cache.py.

DDL only, no backfill: the cron harvester fills the table incrementally, so
startup stays fast on Vercel. Base.metadata.create_all normally creates the
table first; this keeps databases created outside the app (and the indexes)
in step.

Idempotent: skips anything that already exists. Runs on app startup.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

_TABLE_DDL = """
CREATE TABLE company_logos (
    id SERIAL PRIMARY KEY,
    company_key VARCHAR NOT NULL,
    display_name VARCHAR DEFAULT '',
    domain VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'miss',
    sha VARCHAR,
    fmt VARCHAR,
    data BYTEA,
    source VARCHAR DEFAULT '',
    source_url VARCHAR DEFAULT '',
    width INTEGER,
    height INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    rejected_domains JSON,
    checked_at TIMESTAMP,
    next_retry_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
)
"""

# Same names SQLAlchemy gives the model's index=True columns, so a table that
# create_all already built matches and IF NOT EXISTS skips them.
_INDEXES = [
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_company_logos_company_key "
    "ON company_logos (company_key)",
    "CREATE INDEX IF NOT EXISTS ix_company_logos_sha ON company_logos (sha)",
    "CREATE INDEX IF NOT EXISTS ix_company_logos_id ON company_logos (id)",
]


def _is_sqlite(engine) -> bool:
    return engine.dialect.name == "sqlite"


def run_migration(engine=None) -> None:
    """Create company_logos and its indexes if missing."""
    engine = engine or default_engine
    tables = set(inspect(engine).get_table_names())

    with engine.begin() as conn:
        if "company_logos" not in tables:
            ddl = _TABLE_DDL
            if _is_sqlite(engine):
                # SQLite (tests) has no SERIAL, BYTEA or NOW().
                ddl = ddl.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
                ddl = ddl.replace("BYTEA", "BLOB").replace("DEFAULT NOW()", "DEFAULT CURRENT_TIMESTAMP")
            conn.execute(text(ddl))
            logger.info("Created company_logos.")
        for index in _INDEXES:
            conn.execute(text(index))
