"""
Migration: Job match notifications registry.

Creates the ``job_match_notifications`` table backing per-user-per-job dedup of
high-match alert emails:

  - id (PK)
  - user_id (FK users.id, ON DELETE CASCADE), recipient
  - job_id (FK scraped_jobs.id, ON DELETE CASCADE), the matched job
  - match_score (INT), score at the time we notified
  - sent_at (TIMESTAMP), when the alert was sent
  - UNIQUE(user_id, job_id), a user is never alerted twice about a job

Both foreign keys cascade: an alert is a receipt for a (user, job) pair and is
meaningless once either side is gone. They did not always, see
``_ensure_cascade_fks``, which repairs databases created before that was fixed.

Idempotent + additive: guard on the inspector so raw Postgres DDL never reaches
SQLite (tests build the table from the model via create_all()).
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


#: (column, parent table) pairs that must delete along with their parent.
_CASCADE_FKS = (("user_id", "users"), ("job_id", "scraped_jobs"))


def _ensure_cascade_fks() -> None:
    """Repair foreign keys that were created without ON DELETE CASCADE.

    The table's FKs originally came from ``create_all()``, which emits them with
    Postgres' default NO ACTION. Every other user-owned table cascades, so this
    one table alone blocked ``DELETE FROM users``, and blocked deleting any job
    a user had already been alerted about, since the alert row still pointed at
    it.

    Postgres-only: SQLite cannot ALTER a constraint, and the test DB builds this
    table from the model, which now declares the cascade itself. Idempotent,
    an FK that already cascades is left alone.
    """
    if engine.dialect.name != "postgresql":
        return

    inspector = inspect(engine)
    if "job_match_notifications" not in set(inspector.get_table_names()):
        return

    by_column = {
        tuple(fk.get("constrained_columns") or []): fk
        for fk in inspector.get_foreign_keys("job_match_notifications")
    }

    for column, parent in _CASCADE_FKS:
        fk = by_column.get((column,))
        if fk and ((fk.get("options") or {}).get("ondelete") or "").upper() == "CASCADE":
            continue

        name = (fk or {}).get("name") or f"job_match_notifications_{column}_fkey"
        with engine.begin() as conn:
            if fk and fk.get("name"):
                conn.execute(text(
                    f'ALTER TABLE job_match_notifications DROP CONSTRAINT "{fk["name"]}"'
                ))
            conn.execute(text(
                f'ALTER TABLE job_match_notifications ADD CONSTRAINT "{name}" '
                f"FOREIGN KEY ({column}) REFERENCES {parent}(id) ON DELETE CASCADE"
            ))
        logger.info("job_match_notifications.%s foreign key now ON DELETE CASCADE", column)


def run_migration() -> None:
    """Create the job_match_notifications table if it does not exist."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "job_match_notifications" not in tables:
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE job_match_notifications (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    job_id INTEGER NOT NULL REFERENCES scraped_jobs(id) ON DELETE CASCADE,
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

    _ensure_cascade_fks()

    logger.info("Job match notifications migration completed successfully.")
