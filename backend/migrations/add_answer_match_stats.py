"""
Migration: Add saved_answers.times_matched and saved_answers.last_matched_at.

Question Memory recalls by embedding proximity, so a badly-keyed row becomes a
permanent attractor: every future question near it in vector space gets its
answer. ``times_reused`` cannot expose that, because POST /api/answers bumps the
same counter on every re-save — a row saved ten times and never recalled reads
identically to one recalled ten times.

These two columns count the MATCH itself, which is what the answer-bank audit
(scripts/audit_saved_answers.py) ranks suspect keys by.

Idempotent: skips when the columns already exist. Runs on app startup so the
ORM model never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "times_matched": "INTEGER DEFAULT 0",
    "last_matched_at": "TIMESTAMP",
}


def run_migration(engine=None) -> None:
    """Add the match-count columns to saved_answers if missing.

    `engine` is injectable so the answer-bank audit script can apply this to
    whatever database it was pointed at, rather than to whatever DATABASE_URL
    happened to be set when the app package was imported.
    """
    engine = engine or default_engine
    inspector = inspect(engine)

    if "saved_answers" not in inspector.get_table_names():
        logger.info("Answer match-stats migration skipped: table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("saved_answers")}
    missing = {name: ddl for name, ddl in _COLUMNS.items() if name not in existing}
    if not missing:
        logger.info("saved_answers match-stat columns already exist, skipping.")
        return

    with engine.begin() as conn:
        for name, ddl in missing.items():
            conn.execute(text(f"ALTER TABLE saved_answers ADD COLUMN {name} {ddl}"))
    logger.info("Added saved_answers columns: %s", ", ".join(missing))
