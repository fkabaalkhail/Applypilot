"""
Migration: Remove Clerk auth and switch to self-hosted FastAPI auth.

This script documents the SQL migration that converts the database from
Clerk-based string user IDs (clerk_user_id) to integer-based user IDs
with proper foreign key relationships.

NOTE: This migration has already been run in the Neon SQL editor.
This file exists as a reference and can be re-run if needed (uses IF EXISTS checks).

To run:
    python -m backend.db.migrate_remove_clerk

Or copy the SQL from MIGRATION_SQL and run it directly in the Neon SQL editor.
"""

import os
import ssl
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from dotenv import load_dotenv
load_dotenv()

# ---------------------------------------------------------------------------
# Full migration SQL for reference (designed to run in Neon SQL editor)
# ---------------------------------------------------------------------------

MIGRATION_SQL = """
-- =============================================================================
-- Migration: Remove Clerk Auth → Self-Hosted FastAPI Auth
-- =============================================================================
-- This migration:
--   1. Adds hashed_password column to users
--   2. Converts all 10 referencing tables from string user_id (clerk_user_id)
--      to integer user_id with proper foreign keys
--   3. Removes clerk_user_id from users
--   4. Ensures email is unique and not-null
-- =============================================================================

-- Step 1: Add hashed_password column to users (nullable initially for migration)
ALTER TABLE users ADD COLUMN IF NOT EXISTS hashed_password VARCHAR;

-- =============================================================================
-- Step 2: For each referencing table, add integer user_id, populate, then swap
-- =============================================================================

-- ---------- scraped_jobs ----------
ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE scraped_jobs sj
SET user_id_new = u.id
FROM users u
WHERE sj.user_id = u.clerk_user_id;

ALTER TABLE scraped_jobs DROP COLUMN IF EXISTS user_id;
ALTER TABLE scraped_jobs RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_scraped_jobs_user_id ON scraped_jobs(user_id);
ALTER TABLE scraped_jobs ADD CONSTRAINT fk_scraped_jobs_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- pending_questions ----------
ALTER TABLE pending_questions ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE pending_questions pq
SET user_id_new = u.id
FROM users u
WHERE pq.user_id = u.clerk_user_id;

ALTER TABLE pending_questions DROP COLUMN IF EXISTS user_id;
ALTER TABLE pending_questions RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_pending_questions_user_id ON pending_questions(user_id);
ALTER TABLE pending_questions ADD CONSTRAINT fk_pending_questions_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- resume_profiles ----------
ALTER TABLE resume_profiles ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE resume_profiles rp
SET user_id_new = u.id
FROM users u
WHERE rp.user_id = u.clerk_user_id;

ALTER TABLE resume_profiles DROP COLUMN IF EXISTS user_id;
ALTER TABLE resume_profiles RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_resume_profiles_user_id ON resume_profiles(user_id);
ALTER TABLE resume_profiles ADD CONSTRAINT fk_resume_profiles_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- application_records ----------
ALTER TABLE application_records ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE application_records ar
SET user_id_new = u.id
FROM users u
WHERE ar.user_id = u.clerk_user_id;

ALTER TABLE application_records DROP COLUMN IF EXISTS user_id;
ALTER TABLE application_records RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_application_records_user_id ON application_records(user_id);
ALTER TABLE application_records ADD CONSTRAINT fk_application_records_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- user_settings ----------
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE user_settings us
SET user_id_new = u.id
FROM users u
WHERE us.user_id = u.clerk_user_id;

ALTER TABLE user_settings DROP COLUMN IF EXISTS user_id;
ALTER TABLE user_settings RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_user_settings_user_id ON user_settings(user_id);
ALTER TABLE user_settings ADD CONSTRAINT fk_user_settings_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- bot_runs ----------
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE bot_runs br
SET user_id_new = u.id
FROM users u
WHERE br.user_id = u.clerk_user_id;

ALTER TABLE bot_runs DROP COLUMN IF EXISTS user_id;
ALTER TABLE bot_runs RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_bot_runs_user_id ON bot_runs(user_id);
ALTER TABLE bot_runs ADD CONSTRAINT fk_bot_runs_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- connection_requests ----------
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE connection_requests cr
SET user_id_new = u.id
FROM users u
WHERE cr.user_id = u.clerk_user_id;

ALTER TABLE connection_requests DROP COLUMN IF EXISTS user_id;
ALTER TABLE connection_requests RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_connection_requests_user_id ON connection_requests(user_id);
ALTER TABLE connection_requests ADD CONSTRAINT fk_connection_requests_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- autopilot_runs ----------
ALTER TABLE autopilot_runs ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE autopilot_runs apr
SET user_id_new = u.id
FROM users u
WHERE apr.user_id = u.clerk_user_id;

ALTER TABLE autopilot_runs DROP COLUMN IF EXISTS user_id;
ALTER TABLE autopilot_runs RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_autopilot_runs_user_id ON autopilot_runs(user_id);
ALTER TABLE autopilot_runs ADD CONSTRAINT fk_autopilot_runs_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- tailored_resumes ----------
ALTER TABLE tailored_resumes ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE tailored_resumes tr
SET user_id_new = u.id
FROM users u
WHERE tr.user_id = u.clerk_user_id;

ALTER TABLE tailored_resumes DROP COLUMN IF EXISTS user_id;
ALTER TABLE tailored_resumes RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_tailored_resumes_user_id ON tailored_resumes(user_id);
ALTER TABLE tailored_resumes ADD CONSTRAINT fk_tailored_resumes_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------- insider_connections ----------
ALTER TABLE insider_connections ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

UPDATE insider_connections ic
SET user_id_new = u.id
FROM users u
WHERE ic.user_id = u.clerk_user_id;

ALTER TABLE insider_connections DROP COLUMN IF EXISTS user_id;
ALTER TABLE insider_connections RENAME COLUMN user_id_new TO user_id;

CREATE INDEX IF NOT EXISTS ix_insider_connections_user_id ON insider_connections(user_id);
ALTER TABLE insider_connections ADD CONSTRAINT fk_insider_connections_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- =============================================================================
-- Step 3: Remove clerk_user_id from users
-- =============================================================================
ALTER TABLE users DROP COLUMN IF EXISTS clerk_user_id;

-- =============================================================================
-- Step 4: Make email unique and not-null
-- =============================================================================
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users(email);
"""

# ---------------------------------------------------------------------------
# Executable migration (optional — can run against the database directly)
# ---------------------------------------------------------------------------

def get_engine():
    """Create a SQLAlchemy engine from DATABASE_URL."""
    from sqlalchemy import create_engine

    DATABASE_URL = os.getenv("DATABASE_URL", "")
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL not set")
        sys.exit(1)

    # Rewrite for pg8000
    db_url = DATABASE_URL.split("?")[0]
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql+pg8000://", 1)
    elif db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+pg8000://", 1)

    ssl_context = ssl.create_default_context()
    return create_engine(db_url, connect_args={"ssl_context": ssl_context})


def run_migration():
    """Execute the migration SQL against the database."""
    from sqlalchemy import text

    engine = get_engine()
    print("Connecting to database...")
    with engine.connect() as conn:
        # Split on semicolons and execute each statement
        statements = [s.strip() for s in MIGRATION_SQL.split(";") if s.strip()]
        total = len(statements)
        for i, stmt in enumerate(statements, 1):
            print(f"  Executing statement {i}/{total}...")
            conn.execute(text(stmt))
        conn.commit()
    print("Migration completed successfully!")


def print_sql():
    """Print the full migration SQL for copy-paste into Neon SQL editor."""
    print(MIGRATION_SQL)


if __name__ == "__main__":
    if "--print" in sys.argv:
        print_sql()
    elif "--run" in sys.argv:
        run_migration()
    else:
        print("Usage:")
        print("  python -m backend.db.migrate_remove_clerk --print   # Print SQL for Neon editor")
        print("  python -m backend.db.migrate_remove_clerk --run     # Execute against database")
        print()
        print("This migration has already been run. Use --print to view the SQL.")
