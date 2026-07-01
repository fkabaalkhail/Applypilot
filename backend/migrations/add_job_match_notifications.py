"""
Migration: Job match notifications registry.

Creates the ``job_match_notifications`` table backing per-user-per-job dedup of
high-match alert emails:

  - id (PK)
  - user_id (FK users.id)      — recipient
  - job_id (FK scraped_jobs.id) — the matched job
  - match_score (INT)          — score at the time we notified
  - sent_at (TIMESTAMP)        — when the alert was sent
  - UNIQUE(user_id, job_id)    — a user is never alerted twice about a job

Idempotent + additive: guard on the inspector so raw Postgres DDL never reaches
SQLite (tests build the table from the model via create_all()).
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Create the job_match_notifications table if it does not exist."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "job_match_notifications" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE job_match_notifications (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    job_id INTEGER NOT NULL,
                    match_score INTEGER DEFAULT 0,
                    sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_job_match_notification_user_job UNIQUE (user_id, job_id)
                )
            """))
            logger.info("Created table: job_match_notifications")

    with engine.begin() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_job_match_notifications_user_id "
            "ON job_match_notifications (user_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_job_match_notifications_job_id "
            "ON job_match_notifications (job_id)"
        ))

    logger.info("Job match notifications migration completed successfully.")
