"""
Migration: Add autofill_reports.field_outcomes and autofill_reports.reverted.

The table recorded FAILURES only. That made one bug class unobservable by
construction: a field the pipeline answered wrongly but wrote successfully
produced a `filled` count and nothing else, so the record of the page said
everything had gone well, and the field that mattered had no row at all.

`field_outcomes` is the per-field record, successes included:
``{label, category, tier, pass, expected_value_present,
observed_value_present, outcome, reason}``. Labels, categories, provenance and
booleans only, matching the table's existing rule that a user's answers are
never stored here.

`reverted` counts fields written successfully whose value the page no longer
held at the terminal re-scan, a framework resetting a control after the write
verified, which per-write verification cannot see.

Idempotent: skips columns that already exist. Runs on app startup so the ORM
model never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "field_outcomes": "JSON",
    "reverted": "INTEGER DEFAULT 0",
}


def run_migration(engine=None) -> None:
    """Add the per-field outcome columns to autofill_reports if missing."""
    engine = engine or default_engine
    inspector = inspect(engine)

    if "autofill_reports" not in inspector.get_table_names():
        logger.info("Autofill field-outcomes migration skipped: table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("autofill_reports")}
    missing = {name: ddl for name, ddl in _COLUMNS.items() if name not in existing}
    if not missing:
        logger.info("autofill_reports outcome columns already exist, skipping.")
        return

    with engine.begin() as conn:
        for name, ddl in missing.items():
            conn.execute(text(f"ALTER TABLE autofill_reports ADD COLUMN {name} {ddl}"))
    logger.info("Added autofill_reports columns: %s", ", ".join(missing))
