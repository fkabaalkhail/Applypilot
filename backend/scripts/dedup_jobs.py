"""
One-time cross-source dedup over the whole catalogue.

Phase 1 backfills scraped_jobs.title_norm (needed for twin lookups at ingest).
Phase 2 runs the sweep: LinkedIn/Indeed twins of direct ats/github rows get
duplicate_of set; winners inherit applicant_count/salary_range/description.

Column-only reads throughout (no description egress except the rare copy onto
a description-less winner). Idempotent.

Usage:
    DATABASE_URL=postgres://... python backend/scripts/dedup_jobs.py [--dry-run]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import text  # noqa: E402

from backend.db.database import SessionLocal, engine  # noqa: E402
from backend.services.cross_source_dedup import dedup_sweep, normalize_title  # noqa: E402

BATCH = 1000


def backfill_title_norm(dry_run: bool = False) -> int:
    """Phase 1: compute title_norm for every row that lacks one."""
    updated = 0
    with engine.connect() as conn:
        while True:
            rows = conn.execute(text(
                "SELECT id, title FROM scraped_jobs "
                "WHERE title_norm IS NULL OR title_norm = '' "
                "ORDER BY id LIMIT :batch"
            ), {"batch": BATCH}).fetchall()
            if not rows:
                break
            params = [
                {"id": row.id, "tn": normalize_title(row.title or "") or "\x01"}
                for row in rows
            ]
            # '\x01' sentinel keeps unnormalizable titles out of the WHERE loop.
            if dry_run:
                print(f"[dry-run] would set title_norm on {len(params)} rows "
                      f"(through id {rows[-1].id}); stopping after one batch")
                break
            conn.execute(text(
                "UPDATE scraped_jobs SET title_norm = :tn WHERE id = :id"
            ), params)
            conn.commit()
            updated += len(params)
            print(f"title_norm set on {updated} rows (through id {rows[-1].id})")
    return updated


def main(dry_run: bool = False) -> None:
    filled = backfill_title_norm(dry_run=dry_run)
    print(f"phase 1 done: title_norm filled on {filled} rows")
    if dry_run:
        print("[dry-run] skipping sweep phase")
        return
    session = SessionLocal()
    try:
        stats = dedup_sweep(session)
    finally:
        session.close()
    print(f"phase 2 done: {stats}")


if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL", ""):
        sys.exit("DATABASE_URL is required")
    main(dry_run="--dry-run" in sys.argv)
