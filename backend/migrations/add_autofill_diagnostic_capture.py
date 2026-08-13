"""
Migration: diagnostic autofill capture.

Adds
  * ``user_settings.diagnostic_capture`` — the per-account opt-in. FALSE for
    everybody by default, which is what keeps the existing "labels and booleans
    only" posture true for every account that did not ask for more.
  * ``autofill_reports.extension_version`` / ``durations`` — which build produced
    a report, and what each phase cost. Both existed only as guesses before: a
    "takes exceptionally long" report on 2026-08-13 had no timing data at all,
    and a stale local build has been mistaken for a code bug more than once.
  * ``autofill_field_captures`` — one row per field per fill, for opted-in
    accounts only, carrying the answer, the widget's real options and a
    sanitised snapshot of the employer's markup.

The capture table is the point of the whole migration. It exists so an agent can
read a failed field out of the database and write a regression test for it
WITHOUT visiting the live page, which for the forms that fail most (behind a
login, several steps into a flow) is not possible any other way.

`dom` is TEXT and relies on Postgres TOAST compressing it; snapshots are capped
client-side (~4 KB) and sanitised of scripts, styles, SVG paths and inline
styles before they are ever sent.

Idempotent: skips anything that already exists. Runs on app startup.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

_REPORT_COLUMNS = {
    "extension_version": "VARCHAR",
    "durations": "JSON",
}

_CAPTURES_DDL = """
CREATE TABLE autofill_field_captures (
    id SERIAL PRIMARY KEY,
    report_id INTEGER REFERENCES autofill_reports(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    host VARCHAR,
    ats_type VARCHAR,
    url VARCHAR,
    field_id VARCHAR,
    label TEXT,
    category VARCHAR,
    confidence DOUBLE PRECISION DEFAULT 0,
    control_type VARCHAR,
    input_type VARCHAR,
    help_text TEXT,
    required BOOLEAN DEFAULT FALSE,
    group_index INTEGER,
    options JSON,
    proposed_value TEXT,
    observed_value TEXT,
    redacted BOOLEAN DEFAULT FALSE,
    tier VARCHAR,
    pass VARCHAR,
    outcome VARCHAR,
    reason TEXT,
    dom TEXT,
    selector VARCHAR,
    created_at TIMESTAMP DEFAULT NOW()
)
"""

# The three questions this table is queried with: "what is broken on this ATS",
# "what is broken for this kind of field", and "show me the newest failures".
_CAPTURES_INDEXES = [
    "CREATE INDEX ix_afc_host ON autofill_field_captures (host)",
    "CREATE INDEX ix_afc_category ON autofill_field_captures (category)",
    "CREATE INDEX ix_afc_outcome ON autofill_field_captures (outcome)",
    "CREATE INDEX ix_afc_created_at ON autofill_field_captures (created_at)",
    "CREATE INDEX ix_afc_report_id ON autofill_field_captures (report_id)",
]


def _is_sqlite(engine) -> bool:
    return engine.dialect.name == "sqlite"


def run_migration(engine=None) -> None:
    engine = engine or default_engine
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    # 1. The opt-in flag.
    if "user_settings" in tables:
        cols = {c["name"] for c in inspector.get_columns("user_settings")}
        if "diagnostic_capture" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE user_settings ADD COLUMN diagnostic_capture BOOLEAN DEFAULT FALSE"
                ))
            logger.info("Added user_settings.diagnostic_capture.")
        else:
            logger.info("user_settings.diagnostic_capture already exists, skipping.")

    # 2. Report-level context.
    if "autofill_reports" in tables:
        cols = {c["name"] for c in inspector.get_columns("autofill_reports")}
        missing = {n: d for n, d in _REPORT_COLUMNS.items() if n not in cols}
        if missing:
            with engine.begin() as conn:
                for name, ddl in missing.items():
                    conn.execute(text(f"ALTER TABLE autofill_reports ADD COLUMN {name} {ddl}"))
            logger.info("Added autofill_reports columns: %s", ", ".join(missing))
        else:
            logger.info("autofill_reports diagnostic columns already exist, skipping.")

    # 3. The capture table.
    if "autofill_field_captures" in tables:
        logger.info("autofill_field_captures already exists, skipping.")
        return

    ddl = _CAPTURES_DDL
    if _is_sqlite(engine):
        # SQLite (tests) has no SERIAL and no NOW().
        ddl = ddl.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
        ddl = ddl.replace("DOUBLE PRECISION", "REAL").replace("DEFAULT NOW()", "DEFAULT CURRENT_TIMESTAMP")
    with engine.begin() as conn:
        conn.execute(text(ddl))
        for index in _CAPTURES_INDEXES:
            conn.execute(text(index))
    logger.info("Created autofill_field_captures.")
