"""
Migration: Add user_id to remaining tables + add FK constraints.

Run this once against your Neon database:
    python -m backend.db.migrate_user_relationships

This is safe to run multiple times (uses IF NOT EXISTS checks).
"""

import os
import ssl
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from dotenv import load_dotenv
load_dotenv()

from sqlalchemy import create_engine, text

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
engine = create_engine(db_url, connect_args={"ssl_context": ssl_context})


MIGRATIONS = [
    # 1. Add user_id to pending_questions
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'pending_questions' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE pending_questions ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_pending_questions_user_id ON pending_questions (user_id);
        END IF;
    END $$;
    """,
    # 2. Add user_id to bot_runs
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'bot_runs' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE bot_runs ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_bot_runs_user_id ON bot_runs (user_id);
        END IF;
    END $$;
    """,
    # 3. Add user_id to connection_requests
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'connection_requests' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE connection_requests ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_connection_requests_user_id ON connection_requests (user_id);
        END IF;
    END $$;
    """,
    # 4. Add user_id to autopilot_runs
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'autopilot_runs' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE autopilot_runs ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_autopilot_runs_user_id ON autopilot_runs (user_id);
        END IF;
    END $$;
    """,
    # 5. Add user_id to insider_connections
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'insider_connections' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE insider_connections ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_insider_connections_user_id ON insider_connections (user_id);
        END IF;
    END $$;
    """,
    # 6. FK: resume_profiles.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_resume_profiles_user' AND table_name = 'resume_profiles'
        ) THEN
            ALTER TABLE resume_profiles
                ADD CONSTRAINT fk_resume_profiles_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 7. FK: application_records.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_application_records_user' AND table_name = 'application_records'
        ) THEN
            ALTER TABLE application_records
                ADD CONSTRAINT fk_application_records_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 8. FK: user_settings.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_user_settings_user' AND table_name = 'user_settings'
        ) THEN
            ALTER TABLE user_settings
                ADD CONSTRAINT fk_user_settings_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 9. FK: tailored_resumes.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_tailored_resumes_user' AND table_name = 'tailored_resumes'
        ) THEN
            ALTER TABLE tailored_resumes
                ADD CONSTRAINT fk_tailored_resumes_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 10. FK: pending_questions.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_pending_questions_user' AND table_name = 'pending_questions'
        ) THEN
            ALTER TABLE pending_questions
                ADD CONSTRAINT fk_pending_questions_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 11. FK: bot_runs.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_bot_runs_user' AND table_name = 'bot_runs'
        ) THEN
            ALTER TABLE bot_runs
                ADD CONSTRAINT fk_bot_runs_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 12. FK: connection_requests.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_connection_requests_user' AND table_name = 'connection_requests'
        ) THEN
            ALTER TABLE connection_requests
                ADD CONSTRAINT fk_connection_requests_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 13. FK: autopilot_runs.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_autopilot_runs_user' AND table_name = 'autopilot_runs'
        ) THEN
            ALTER TABLE autopilot_runs
                ADD CONSTRAINT fk_autopilot_runs_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 14. FK: insider_connections.user_id → users.clerk_user_id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_insider_connections_user' AND table_name = 'insider_connections'
        ) THEN
            ALTER TABLE insider_connections
                ADD CONSTRAINT fk_insider_connections_user
                FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) NOT VALID;
        END IF;
    END $$;
    """,
    # 15. FK: scraped_jobs.github_source_id → github_sources.id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_scraped_jobs_github_source' AND table_name = 'scraped_jobs'
        ) THEN
            ALTER TABLE scraped_jobs
                ADD CONSTRAINT fk_scraped_jobs_github_source
                FOREIGN KEY (github_source_id) REFERENCES github_sources(id) NOT VALID;
        END IF;
    END $$;
    """,
    # 16. FK: application_records.job_id → scraped_jobs.id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_application_records_job' AND table_name = 'application_records'
        ) THEN
            ALTER TABLE application_records
                ADD CONSTRAINT fk_application_records_job
                FOREIGN KEY (job_id) REFERENCES scraped_jobs(id) NOT VALID;
        END IF;
    END $$;
    """,
    # 17. FK: tailored_resumes.job_id → scraped_jobs.id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_tailored_resumes_job' AND table_name = 'tailored_resumes'
        ) THEN
            ALTER TABLE tailored_resumes
                ADD CONSTRAINT fk_tailored_resumes_job
                FOREIGN KEY (job_id) REFERENCES scraped_jobs(id) NOT VALID;
        END IF;
    END $$;
    """,
    # 18. FK: pending_questions.job_id → scraped_jobs.id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_pending_questions_job' AND table_name = 'pending_questions'
        ) THEN
            ALTER TABLE pending_questions
                ADD CONSTRAINT fk_pending_questions_job
                FOREIGN KEY (job_id) REFERENCES scraped_jobs(id) NOT VALID;
        END IF;
    END $$;
    """,
    # 19. FK: connection_requests.job_id → scraped_jobs.id
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_connection_requests_job' AND table_name = 'connection_requests'
        ) THEN
            ALTER TABLE connection_requests
                ADD CONSTRAINT fk_connection_requests_job
                FOREIGN KEY (job_id) REFERENCES scraped_jobs(id) NOT VALID;
        END IF;
    END $$;
    """,
]


def run_migrations():
    print("Connecting to database...")
    with engine.connect() as conn:
        for i, sql in enumerate(MIGRATIONS, 1):
            print(f"  Running migration {i}/{len(MIGRATIONS)}...")
            conn.execute(text(sql))
        conn.commit()
    print("All migrations completed successfully!")


if __name__ == "__main__":
    run_migrations()
