"""
Migration: Add richer-autofill profile fields to user_settings (autofill v2.1).

Adds (all VARCHAR, default ''):
  - street_address, address_state, postal_code, country  (structured address;
    the existing ``city`` column is reused for addressCity)
  - eeo_gender, eeo_race, eeo_hispanic, eeo_veteran, eeo_disability  (EEO /
    demographic self-identification, only filled when the extension's
    "Fill EEO fields" setting is on)

Idempotent: skips columns that already exist. Runs on app startup so the ORM
model (which references these columns) never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add address + EEO columns to user_settings if missing."""
    inspector = inspect(engine)

    if "user_settings" not in inspector.get_table_names():
        logger.info("Autofill profile migration skipped: 'user_settings' table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("user_settings")}
    to_add = {
        "street_address": "VARCHAR DEFAULT ''",
        "address_state": "VARCHAR DEFAULT ''",
        "postal_code": "VARCHAR DEFAULT ''",
        "country": "VARCHAR DEFAULT ''",
        "eeo_gender": "VARCHAR DEFAULT ''",
        "eeo_race": "VARCHAR DEFAULT ''",
        "eeo_hispanic": "VARCHAR DEFAULT ''",
        "eeo_veteran": "VARCHAR DEFAULT ''",
        "eeo_disability": "VARCHAR DEFAULT ''",
    }

    with engine.begin() as conn:
        for name, ddl in to_add.items():
            if name in existing:
                logger.info("Column user_settings.%s already exists, skipping.", name)
                continue
            conn.execute(text(f"ALTER TABLE user_settings ADD COLUMN {name} {ddl}"))
            logger.info("Added user_settings.%s", name)
