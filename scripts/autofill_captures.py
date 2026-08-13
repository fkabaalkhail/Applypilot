#!/usr/bin/env python
"""
Turn diagnostic autofill captures into things a coding agent can act on.

This is the read side of the capture pipeline: the extension records every
field of every fill (for accounts with diagnostic capture on), and this script
answers the three questions worth asking of that data.

    # 1. What is broken, ranked by how often? Start here.
    python scripts/autofill_captures.py rank --days 14

    # 2. Show me one failure in full, including the markup.
    python scripts/autofill_captures.py show 481

    # 3. Write me the fixture so I can author a regression test.
    python scripts/autofill_captures.py fixture 481 > \\
        chrome-extension/test/fixtures/greenhouseSchoolAsync.ts

The point of (3): the forms that fail most are several steps into a flow behind
a login, so nobody can re-fetch them later. The captured DOM is the only way to
rebuild them, and a fixture is what turns one bad application into a permanent
test.

Reads DATABASE_URL from the environment / .env, same as the backend.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import ssl
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text  # noqa: E402


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        for candidate in (Path(".env"), Path("backend/.env")):
            if candidate.exists():
                for line in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
                    if line.strip().startswith("DATABASE_URL="):
                        url = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not url:
        sys.exit("DATABASE_URL not set (env or .env).")
    # Same rewrite the backend does: pg8000 rejects Neon's query params
    # (channel_binding, sslmode) and takes an ssl_context instead.
    url = url.split("?")[0]
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return url.replace(prefix, "postgresql+pg8000://", 1)
    return url


def connect():
    url = _database_url()
    connect_args = {} if url.startswith("sqlite") else {"ssl_context": ssl.create_default_context()}
    conn = create_engine(url, connect_args=connect_args).connect()
    if not conn.dialect.has_table(conn, "autofill_field_captures"):
        sys.exit(
            "autofill_field_captures does not exist on this database.\n"
            "The migration runs at app startup, so deploy the backend first "
            "(backend/migrations/add_autofill_diagnostic_capture.py)."
        )
    return conn


# ── rank ─────────────────────────────────────────────────────────────────────

FAILED = ("failed", "reverted", "dropped")

# The value is already stripped from a reason before storage in the default
# record, but a capture keeps it, so collapse the varying parts to group.
_NORMALISE = [
    (re.compile(r'"[^"]*"'), '"..."'),
    (re.compile(r"\(saw:[^)]*\)"), "(saw: ...)"),
    (re.compile(r"\d+"), "N"),
]


def normalise_reason(reason: str) -> str:
    out = (reason or "").strip()
    for pattern, repl in _NORMALISE:
        out = pattern.sub(repl, out)
    return out[:120]


def cmd_rank(args) -> None:
    """Failure clusters, biggest first: what fixing would help most."""
    # Cutoff computed here rather than in SQL: `NOW() - interval` is Postgres
    # only, and this script has to run against a sqlite copy too.
    cutoff = datetime.datetime.now(datetime.UTC).replace(tzinfo=None) - datetime.timedelta(days=args.days)
    sql = text(f"""
        SELECT host, ats_type, category, control_type, outcome, reason, id
        FROM autofill_field_captures
        WHERE created_at >= :cutoff
          AND outcome IN {FAILED}
        ORDER BY created_at DESC
        LIMIT 20000
    """)
    with connect() as conn:
        rows = list(conn.execute(sql, {"cutoff": cutoff}))

    if not rows:
        print("No captured failures in that window.")
        print("If you expected some: diagnostic capture is per-account and OFF by default.")
        print("  UPDATE user_settings SET diagnostic_capture = true WHERE user_id = <id>;")
        return

    clusters: Counter = Counter()
    example: dict = {}
    for host, ats, category, control, outcome, reason, cid in rows:
        key = (ats or host, category, control, outcome, normalise_reason(reason))
        clusters[key] += 1
        example.setdefault(key, cid)

    print(f"{len(rows)} failed fields over {args.days}d, {len(clusters)} distinct clusters\n")
    print(f"{'n':>5}  {'example':>7}  site / category / control / outcome")
    print("-" * 100)
    for (site, category, control, outcome, reason), n in clusters.most_common(args.top):
        print(f"{n:>5}  {example[(site, category, control, outcome, reason)]:>7}  "
              f"{site} | {category or '?'} | {control or '?'} | {outcome}")
        if reason:
            print(f"{'':>14}  -> {reason}")


# ── show ─────────────────────────────────────────────────────────────────────

def _capture(conn, capture_id: int):
    row = conn.execute(
        text("SELECT * FROM autofill_field_captures WHERE id = :id"), {"id": capture_id}
    ).mappings().first()
    if not row:
        sys.exit(f"No capture with id {capture_id}.")
    return row


def cmd_show(args) -> None:
    """One field in full: everything needed to reproduce it."""
    with connect() as conn:
        c = _capture(conn, args.id)
    print(f"# capture {c['id']}  ({c['created_at']})")
    print(f"site       {c['host']}  [{c['ats_type']}]")
    print(f"url        {c['url']}")
    print(f"label      {c['label']!r}")
    print(f"help text  {c['help_text']!r}")
    print(f"category   {c['category']}  (confidence {c['confidence']})")
    print(f"control    {c['control_type']}  input_type={c['input_type']!r}  required={c['required']}")
    print(f"row index  {c['group_index']}")
    print(f"proposed   {c['proposed_value']!r}{'  [REDACTED]' if c['redacted'] else ''}")
    print(f"observed   {c['observed_value']!r}")
    print(f"outcome    {c['outcome']}  ({c['tier']}/{c['pass']})")
    print(f"reason     {c['reason']}")
    options = c["options"] if isinstance(c["options"], list) else json.loads(c["options"] or "[]")
    print(f"options    ({len(options)}) {' | '.join(options[:20])}")
    print("\n--- dom ---")
    print(c["dom"])


# ── fixture ──────────────────────────────────────────────────────────────────

def _day(value) -> str:
    """Postgres hands back a datetime, sqlite a string. Print a date either way."""
    return value.strftime("%Y-%m-%d") if hasattr(value, "strftime") else str(value)[:10]


def _ident(text_: str) -> str:
    words = re.sub(r"[^a-zA-Z0-9 ]", " ", text_ or "field").split()
    if not words:
        return "field"
    return words[0].lower() + "".join(w.capitalize() for w in words[1:6])


def cmd_fixture(args) -> None:
    """Emit a ready-to-commit fixture module for one capture."""
    with connect() as conn:
        c = _capture(conn, args.id)
    options = c["options"] if isinstance(c["options"], list) else json.loads(c["options"] or "[]")
    name = _ident(c["label"])
    const = re.sub(r"[^A-Z0-9]", "_", (c["ats_type"] or c["host"]).upper())[:20] or "SITE"

    print(f"""// chrome-extension/test/fixtures/{name}.ts
// REAL markup captured from {c['host']} on {_day(c['created_at'])}
// (autofill_field_captures #{c['id']}; scripts/autofill_captures.py show {c['id']}).
//
// What went wrong here:
//   label      {c['label']!r}
//   control    {c['control_type']}
//   category   {c['category']} (confidence {c['confidence']})
//   proposed   {c['proposed_value']!r}
//   observed   {c['observed_value']!r}
//   outcome    {c['outcome']} - {c['reason']}

/** The options the widget was really offering when the fill ran. */
export const {const}_{name.upper()}_OPTIONS: string[] = {json.dumps(options[:60], indent=2)};

export const {const}_{name.upper()} = `
{c['dom']}`;
""")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("rank", help="failure clusters, biggest first")
    r.add_argument("--days", type=int, default=14)
    r.add_argument("--top", type=int, default=25)
    r.set_defaults(func=cmd_rank)

    s = sub.add_parser("show", help="one capture in full")
    s.add_argument("id", type=int)
    s.set_defaults(func=cmd_show)

    f = sub.add_parser("fixture", help="emit a fixture module for one capture")
    f.add_argument("id", type=int)
    f.set_defaults(func=cmd_fixture)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
