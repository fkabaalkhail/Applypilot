#!/usr/bin/env python
"""
Audit the Question Memory bank for keys that will answer the wrong questions.

    python scripts/audit_saved_answers.py                  # report only
    python scripts/audit_saved_answers.py --user 44        # one user
    python scripts/audit_saved_answers.py --purge          # delete flagged rows
    python scripts/audit_saved_answers.py --purge --yes    # no confirmation
    DATABASE_URL=... python scripts/audit_saved_answers.py # pick the database

An answer is stored under its question text and recalled by matching that text.
So the failure mode is not a wrong ANSWER — it is a wrong KEY, and a wrong key
is invisible from the answer alone. Three things are flagged:

  unnamed keys       A key that names no question: the "Unlabeled field"
                     sentinel, or an opaque widget id.

  widget boilerplate A key made only of what a widget says about itself.
                     Production, 2026-08-09: Workday writes
                     `aria-label="<question> <value> Required"`, which for a
                     yes/no radio group with no question in the attribute
                     collapses to "Yes Required". Every such group on the page
                     canonicalized identically, so all of them shared one row —
                     last write wins — and an "Are you 18 or older?" question
                     was answered from whatever had been banked there last.

  attractors         A key sitting within MATCH_THRESHOLD of OTHER stored keys.
                     A question should be the nearest neighbour of itself and
                     nothing else in the bank; one that is this close to
                     unrelated rows will win recall for their questions too.
                     Measured on the stored embeddings, not inferred from a
                     counter — and reported with the neighbour it collides
                     with, so the finding can be checked rather than trusted.

Match counts are printed alongside as context. They are deliberately NOT a
flag on their own: a genuinely common question ("are you authorized to work?")
is supposed to match often, so a high count is a reason to look, not a verdict.

Prints question keys and statistics. Answer text is shown only under --show-
answers, which is off by default: this is an operational tool, and the answers
are the user's.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.db.models import SavedAnswer  # noqa: E402
from backend.migrations.add_answer_match_stats import run_migration as run_match_stats_migration  # noqa: E402
from backend.services.answer_memory import (  # noqa: E402
    MATCH_THRESHOLD,
    attractor_neighbours,
    key_health,
)

_REASON_TEXT = {
    "empty_key": "key is blank",
    "unlabeled": "key is the unlabeled-field sentinel",
    "machine_id": "key is an opaque widget id",
    "widget_boilerplate": "key is widget boilerplate, not a question",
    "attracts_other_questions": "key sits within the reuse threshold of other keys",
}


def _session(url: str):
    engine = create_engine(url)
    # Idempotent, and the audit reads the columns it adds — running it here
    # means the script works against a database the API has not started on yet.
    run_match_stats_migration(engine)
    return sessionmaker(bind=engine)()


def audit(rows) -> dict[int, str]:
    """``{row_id: reason}`` for every row worth deleting."""
    flagged: dict[int, str] = {}
    for row in rows:
        reason = key_health(row.question_raw or "")
        if reason:
            flagged[row.id] = reason
    neighbours = attractor_neighbours(rows)
    for row_id in neighbours:
        flagged.setdefault(row_id, "attracts_other_questions")
    return flagged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--user", type=int, default=None, help="restrict to one user id")
    parser.add_argument("--purge", action="store_true", help="delete the flagged rows")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    parser.add_argument("--show-answers", action="store_true", help="print answer text too")
    parser.add_argument(
        "--database-url", default=os.getenv("DATABASE_URL", ""),
        help="defaults to $DATABASE_URL",
    )
    args = parser.parse_args()

    if not args.database_url:
        print("No database URL. Set DATABASE_URL or pass --database-url.", file=sys.stderr)
        return 2

    db = _session(args.database_url)
    try:
        query = db.query(SavedAnswer)
        if args.user is not None:
            query = query.filter(SavedAnswer.user_id == args.user)
        rows = query.order_by(SavedAnswer.user_id, SavedAnswer.id).all()

        print(f"{len(rows)} stored answers  (MATCH_THRESHOLD = {MATCH_THRESHOLD})\n")
        if not rows:
            return 0

        by_user: dict[int | None, list[SavedAnswer]] = {}
        for row in rows:
            by_user.setdefault(row.user_id, []).append(row)

        flagged: dict[int, str] = {}
        neighbours: dict[int, list[tuple[int, float]]] = {}
        for user_rows in by_user.values():
            # Scoped per user: recall only ever searches one user's rows, so a
            # collision across two users is not a collision at all.
            flagged.update(audit(user_rows))
            neighbours.update(attractor_neighbours(user_rows))

        for user_id, user_rows in sorted(by_user.items(), key=lambda kv: (kv[0] is None, kv[0])):
            print(f"-- user {user_id} - {len(user_rows)} rows " + "-" * 30)
            for row in user_rows:
                mark = "FLAG" if row.id in flagged else "  ok"
                matched = row.times_matched or 0
                saved = row.times_reused or 0
                created = row.created_at.date().isoformat() if row.created_at else "?"
                print(
                    f" {mark} #{row.id:<5} matched={matched:<4} reused={saved:<4} "
                    f"src={row.source or '?':<12} {created}  {row.question_raw!r}"
                )
                if args.show_answers:
                    print(f"          -> {row.answer!r}")
                if row.id in flagged:
                    print(f"          ! {_REASON_TEXT.get(flagged[row.id], flagged[row.id])}")
                for other_id, score in neighbours.get(row.id, [])[:3]:
                    other = next((r for r in user_rows if r.id == other_id), None)
                    print(f"          ~ {score:.4f} vs #{other_id} {(other.question_raw if other else '')!r}")
            print()

        counts = Counter(flagged.values())
        if not flagged:
            print("No suspect keys.")
            return 0
        print("Flagged: " + ", ".join(f"{n}× {_REASON_TEXT.get(k, k)}" for k, n in counts.most_common()))

        if not args.purge:
            print("\nRe-run with --purge to delete these rows.")
            return 0

        if not args.yes:
            reply = input(f"\nDelete {len(flagged)} rows? [y/N] ").strip().lower()
            if reply not in ("y", "yes"):
                print("Aborted.")
                return 1

        deleted = (
            db.query(SavedAnswer)
            .filter(SavedAnswer.id.in_(list(flagged)))
            .delete(synchronize_session=False)
        )
        db.commit()
        print(f"Deleted {deleted} rows.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
