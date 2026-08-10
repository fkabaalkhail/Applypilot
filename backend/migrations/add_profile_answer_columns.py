"""
Migration: Add the profile-parity columns to user_settings.

Implements section A of docs/superpowers/specs/2026-08-09-profile-parity-contract.md.

Adds (all VARCHAR, default ''):
  - github_url              — ``github`` had no write path at all. The web app
                              wrote it to the resume row, the extension kept it
                              in chrome.storage.local, so an edit on either
                              surface never round-tripped through the API.
  - address_city            — ``location`` and ``addressCity`` both wrote
                              ``user_settings.city``, so a PUT carrying both
                              silently dropped one (dict order decided which).
  - eeo_gender_identity     — declared in the extension's ``EeoAnswers`` type
  - eeo_pronouns              but implemented nowhere; ``eeo_pronouns`` is new.
  - eeo_sexual_orientation

The eight screening answers in the same contract need NO schema change: they
live in the existing ``prefilled_answers`` JSON under exact keys, exactly like
``workAuthorization`` and ``dateOfBirth`` already do.

One-time backfill: ``address_city`` is seeded from ``city`` when the column is
first created, because until now ``addressCity`` WAS ``city`` — without the
backfill an existing user's mailing-address city would silently vanish on
deploy. The backfill runs only on the boot that creates the column: re-running
it every boot would resurrect a value a user deliberately cleared (they can set
``location`` alone, which still writes ``city``).

Idempotent: skips columns that already exist. Runs on app startup so the ORM
model (which references these columns) never queries a missing column. Plain
ADD COLUMN / UPDATE, so it is correct on both PostgreSQL (Neon) and SQLite.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine as default_engine

logger = logging.getLogger(__name__)

# column -> DDL fragment. VARCHAR DEFAULT '' matches the sibling autofill
# migration and the model's ``Column(String, default="")``.
_COLUMNS = {
    "github_url": "VARCHAR DEFAULT ''",
    "address_city": "VARCHAR DEFAULT ''",
    "eeo_gender_identity": "VARCHAR DEFAULT ''",
    "eeo_pronouns": "VARCHAR DEFAULT ''",
    "eeo_sexual_orientation": "VARCHAR DEFAULT ''",
}


def run_migration(engine=None) -> None:
    """Add the profile-parity columns to user_settings if missing."""
    engine = engine or default_engine
    inspector = inspect(engine)

    if "user_settings" not in inspector.get_table_names():
        logger.info("Profile answer columns migration skipped: 'user_settings' table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("user_settings")}
    added: list[str] = []

    with engine.begin() as conn:
        for name, ddl in _COLUMNS.items():
            if name in existing:
                logger.info("Column user_settings.%s already exists, skipping.", name)
                continue
            conn.execute(text(f"ALTER TABLE user_settings ADD COLUMN {name} {ddl}"))
            added.append(name)
            logger.info("Added user_settings.%s", name)

        if "address_city" in added:
            # First run only — see the module docstring. NULL is checked as well
            # as '' because the column default only applies to rows Postgres
            # rewrites, and a hand-built table may allow NULLs.
            result = conn.execute(text(
                "UPDATE user_settings SET address_city = city "
                "WHERE (address_city IS NULL OR address_city = '') "
                "AND city IS NOT NULL AND city <> ''"
            ))
            logger.info(
                "Backfilled user_settings.address_city from city for %s row(s).",
                getattr(result, "rowcount", -1),
            )
