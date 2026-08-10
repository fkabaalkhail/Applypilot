"""
Migration: Drop the saved_answers table.

The Remembered Answers feature (Question Memory) has been removed. It recalled
previously approved answers by embedding proximity and replayed them into new
applications, which meant a badly-keyed row became a permanent attractor,
answering questions it had nothing to do with. The whole pass is gone: /api/fill
now derives every answer from the profile, the rules, or the LLM, and persists
nothing.

This migration is a DELIBERATE, IRREVERSIBLE DATA DELETION. Dropping the table
destroys every remembered answer every user ever stored, which is the point:
leaving the rows behind would keep users' banked application answers on disk
indefinitely with no feature able to read, show, or delete them. There is no
down-migration and no backup taken here.

Idempotent: no-ops when the table is already absent. Runs on app startup, and is
safe on both PostgreSQL and SQLite (plain DROP TABLE, no CASCADE, nothing
references saved_answers).
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)


def run_migration(engine=None) -> None:
    """Drop saved_answers if it still exists."""
    engine = engine or default_engine
    inspector = inspect(engine)

    if "saved_answers" not in inspector.get_table_names():
        logger.info("saved_answers drop skipped: table already absent.")
        return

    with engine.begin() as conn:
        conn.execute(text("DROP TABLE saved_answers"))
    logger.info("Dropped saved_answers (Remembered Answers feature removed).")
