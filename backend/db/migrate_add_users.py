"""
Migration: Add users table and user_id columns to existing tables.

Run this once against your Neon database:
    python -m backend.db.migrate_add_users

This is safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS checks).
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
    # 1. Create users table
    """
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        clerk_user_id VARCHAR NOT NULL UNIQUE,
        email VARCHAR,
        first_name VARCHAR DEFAULT '',
        last_name VARCHAR DEFAULT '',
        profile_image_url VARCHAR DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    );
    """,
    # 2. Create index on clerk_user_id
    """
    CREATE INDEX IF NOT EXISTS ix_users_clerk_user_id ON users (clerk_user_id);
    """,
    # 3. Add user_id to scraped_jobs
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'scraped_jobs' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE scraped_jobs ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_scraped_jobs_user_id ON scraped_jobs (user_id);
        END IF;
    END $$;
    """,
    # 4. Add user_id to resume_profiles
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'resume_profiles' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE resume_profiles ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_resume_profiles_user_id ON resume_profiles (user_id);
        END IF;
    END $$;
    """,
    # 5. Add user_id to application_records
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'application_records' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE application_records ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_application_records_user_id ON application_records (user_id);
        END IF;
    END $$;
    """,
    # 6. Add user_id to user_settings (unique per user)
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'user_settings' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE user_settings ADD COLUMN user_id VARCHAR UNIQUE;
            CREATE INDEX ix_user_settings_user_id ON user_settings (user_id);
        END IF;
    END $$;
    """,
    # 7. Add user_id to tailored_resumes
    """
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tailored_resumes' AND column_name = 'user_id'
        ) THEN
            ALTER TABLE tailored_resumes ADD COLUMN user_id VARCHAR;
            CREATE INDEX ix_tailored_resumes_user_id ON tailored_resumes (user_id);
        END IF;
    END $$;
    """,
]


def run_migrations():
    print(f"Connecting to database...")
    with engine.connect() as conn:
        for i, sql in enumerate(MIGRATIONS, 1):
            print(f"  Running migration {i}/{len(MIGRATIONS)}...")
            conn.execute(text(sql))
        conn.commit()
    print("All migrations completed successfully!")


if __name__ == "__main__":
    run_migrations()
