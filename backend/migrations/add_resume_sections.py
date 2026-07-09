"""
Migration: Add full-fidelity section columns to resume_profiles.

Adds:
  - summary (TEXT)          — the candidate's professional summary / objective
  - summary_title (VARCHAR) — their own heading for it ("PROFILE", "OBJECTIVE"…)
  - custom_sections (JSON)  — certifications, awards, volunteering, publications,
                              languages, leadership… every section that isn't one
                              of the five we model explicitly
  - section_order (JSON)    — the order the sections appeared in the uploaded file

Before this, anything outside {experience, education, projects, skills,
technologies} was discarded at upload time.

Idempotent: skips columns that already exist. Runs on app startup so the ORM
model never queries a missing column.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)


def run_migration() -> None:
    """Add summary/custom_sections/section_order columns if missing."""
    inspector = inspect(engine)

    if "resume_profiles" not in inspector.get_table_names():
        logger.info("Resume sections migration skipped: 'resume_profiles' table missing.")
        return

    existing = {col["name"] for col in inspector.get_columns("resume_profiles")}
    to_add = {
        "summary": "TEXT",
        "summary_title": "VARCHAR",
        "custom_sections": "JSON",
        "section_order": "JSON",
    }

    with engine.begin() as conn:
        for name, ddl in to_add.items():
            if name in existing:
                logger.info("Column resume_profiles.%s already exists, skipping.", name)
                continue
            conn.execute(text(f"ALTER TABLE resume_profiles ADD COLUMN {name} {ddl}"))
            logger.info("Added resume_profiles.%s", name)
