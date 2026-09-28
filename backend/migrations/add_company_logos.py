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
    prior_logo_urls JSON,
    blocked_shas JSON,
    checked_at TIMESTAMP,
    next_retry_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
)
"""

# Columns added after the table first shipped to a database (dev); nullable,
# so adding them is instant.
_ADDED_COLUMNS = {
    "prior_logo_urls": "JSON",
    "blocked_shas": "JSON",
}

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


# Postgres only. Every cold-starting lambda runs this at once on the first
# deploy: lock waits are capped (a timed-out instance leaves the work to the
# next cold start instead of stalling), and the instances take turns on an
# advisory lock so IF NOT EXISTS turns the losers' DDL into no-ops; two
# concurrent CREATE TABLE IF NOT EXISTS can still collide without it.
LOCK_TIMEOUT = "5s"
_ADVISORY_LOCK_KEY = 7_311_027_530_002  # arbitrary, unique to this migration


def run_migration(engine=None) -> None:
    """Create company_logos and its indexes if missing, and add any column
    a table created before it existed lacks."""
    engine = engine or default_engine
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    existing = (
        {c["name"] for c in inspector.get_columns("company_logos")}
        if "company_logos" in tables else set()
    )

    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _ADVISORY_LOCK_KEY})
        if "company_logos" not in tables:
            ddl = _TABLE_DDL
            if _is_sqlite(engine):
                # SQLite (tests) has no SERIAL, BYTEA or NOW().
                ddl = ddl.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
                ddl = ddl.replace("BYTEA", "BLOB").replace("DEFAULT NOW()", "DEFAULT CURRENT_TIMESTAMP")
            else:
                # Another instance may have created it since we inspected.
                ddl = ddl.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
            conn.execute(text(ddl))
            logger.info("Created company_logos.")
        else:
            for column, kind in _ADDED_COLUMNS.items():
                if column not in existing:
                    conn.execute(text(f"ALTER TABLE company_logos ADD COLUMN {column} {kind}"))
                    logger.info("Added company_logos.%s.", column)
        for index in _INDEXES:
            conn.execute(text(index))
