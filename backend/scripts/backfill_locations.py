"""
One-time backfill of structured location columns (+company_domain repair)
for every scraped_jobs row. Idempotent: only touches rows where
location_search is NULL/''. Targets Postgres (Neon).

Reads ONLY the columns it needs (never full rows — descriptions would make
this ~70 MB of egress) and updates in batches.

Usage:
    DATABASE_URL=postgres://... python backend/scripts/backfill_locations.py [--dry-run]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import text  # noqa: E402

from backend.db.database import engine  # noqa: E402  (built from DATABASE_URL)
from backend.services.location_parser import location_fields  # noqa: E402
from backend.services.logo_resolver import resolve_logo  # noqa: E402

BATCH = 500

_IS_SQLITE = engine.url.get_backend_name() == "sqlite"
_LJ_CAST = ":lj" if _IS_SQLITE else "CAST(:lj AS json)"

UPDATE_SQL = text(
    "UPDATE scraped_jobs SET "
    "city = :city, region = :region, "
    f"locations_json = {_LJ_CAST}, location_search = :ls, "
    "company_domain = :domain, company_logo = :logo "
    "WHERE id = :id"
)

SELECT_SQL = text(
    "SELECT id, location, company, company_url, company_domain, company_logo "
    "FROM scraped_jobs "
    "WHERE location_search IS NULL OR location_search = '' "
    "ORDER BY id LIMIT :batch"
)


def main(dry_run: bool = False) -> None:
    updated = scanned = 0
    with engine.connect() as conn:
        while True:
            rows = conn.execute(SELECT_SQL, {"batch": BATCH}).fetchall()
            if not rows:
                break
            scanned += len(rows)
            params = []
            for row in rows:
                fields = location_fields(row.location or "")
                domain = (row.company_domain or "").strip()
                logo = row.company_logo or ""
                if not domain:
                    resolved_logo, resolved_domain = resolve_logo(row.company, row.company_url)
                    if resolved_domain:
                        domain = resolved_domain
                        if not logo or "icon.horse" in logo:
                            logo = resolved_logo
                params.append({
                    "id": row.id,
                    "city": fields["city"],
                    "region": fields["region"],
                    "lj": json.dumps(fields["locations_json"]),
                    # '\x01' sentinel keeps genuinely-unparseable rows out of
                    # the WHERE loop (they'd otherwise be reselected forever).
                    "ls": fields["location_search"] or "\x01",
                    "domain": domain,
                    "logo": logo,
                })
            if dry_run:
                sample = params[:5]
                for p in sample:
                    print(f"  id={p['id']} city={p['city']!r} region={p['region']!r} ls={p['ls'][:60]!r} domain={p['domain']!r}")
                print(f"[dry-run] would update {len(params)} rows (through id {rows[-1].id}); stopping after one batch")
                break
            conn.execute(UPDATE_SQL, params)
            conn.commit()
            updated += len(params)
            print(f"updated {updated} rows (through id {rows[-1].id})")
    print(f"done: scanned {scanned}, updated {updated}")


if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL", ""):
        sys.exit("DATABASE_URL is required")
    main(dry_run="--dry-run" in sys.argv)
