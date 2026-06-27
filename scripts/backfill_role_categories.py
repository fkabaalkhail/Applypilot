"""Backfill scraped_jobs.role_category to the canonical taxonomy.

Dry-run by default (prints the planned remap + counts). Pass --apply to commit.

For each row:
  - already canonical            -> leave as-is
  - known legacy alias           -> map to canonical
  - empty / unrecognised / dept  -> reclassify from the job title
"""

import sys
from collections import Counter

from backend.db.database import SessionLocal
from backend.db.models import ScrapedJob
from backend.services.role_classifier import (
    CANONICAL_CATEGORIES, classify, normalize_category,
)

APPLY = "--apply" in sys.argv


def target_category(title: str, current: str) -> str:
    cur = (current or "").strip()
    if cur in CANONICAL_CATEGORIES:
        return cur
    mapped = normalize_category(cur)
    if mapped:
        return mapped
    # empty or unrecognised free-text (e.g. raw department) -> classify by title
    return classify(title or "", cur)


def main():
    db = SessionLocal()
    try:
        rows = db.query(ScrapedJob.id, ScrapedJob.title, ScrapedJob.role_category).all()
        total = len(rows)
        before = Counter((r.role_category or "").strip() or "(empty)" for r in rows)
        changes = []  # (id, old, new)
        for r in rows:
            new = target_category(r.title, r.role_category)
            if new != (r.role_category or ""):
                changes.append((r.id, (r.role_category or "").strip() or "(empty)", new))

        after = Counter()
        for r in rows:
            after[target_category(r.title, r.role_category)] += 1

        print(f"Total rows: {total}")
        print(f"Rows to change: {len(changes)}")
        print("\n-- BEFORE (top 25) --")
        for k, v in before.most_common(25):
            print(f"  {v:6d}  {k}")
        print("\n-- AFTER (canonical) --")
        for k, v in after.most_common():
            print(f"  {v:6d}  {k}")

        # sample of remaps
        print("\n-- sample remaps --")
        seen = set()
        for _id, old, new in changes:
            key = (old, new)
            if key in seen:
                continue
            seen.add(key)
            print(f"  {old!r:40} -> {new!r}")
            if len(seen) >= 30:
                break

        if not APPLY:
            print("\nDRY RUN. Re-run with --apply to write these changes.")
            return

        # Apply in one transaction, updating only changed rows.
        id_to_new = {cid: new for cid, _o, new in changes}
        updated = 0
        for r in db.query(ScrapedJob).filter(ScrapedJob.id.in_(list(id_to_new))).all():
            r.role_category = id_to_new[r.id]
            updated += 1
        db.commit()
        print(f"\nAPPLIED: updated {updated} rows.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
