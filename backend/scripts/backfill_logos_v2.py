"""
One-time, idempotent backfill of self-hosted company logos.

Runs exactly the harvest cron-backfill Phase 3 runs (services/logo_cache.py:
plan_harvest -> run_harvest -> apply_outcomes, the same hints), but over
every employer instead of a 150s slice, and from a developer machine:
LinkedIn's public guest endpoints (the best source) answer a residential IP
and are unmeasured from Vercel. Re-running it only touches employers that
still have no stored logo, or a provisional one due for its re-check.

Steps:
  0. re-point rows of employers whose logo is already stored (no network);
  1. work list: employers with visible rows and no stored logo, busiest
     first (misses only once their backoff is due, or all with
     --retry-misses), then provisional logos the cron stored while LinkedIn
     was rate-limiting it, once due for their re-check;
  2. harvest each with the Phase 3 hints (its own rows' logos, then its
     longer name's, LinkedIn, ATS boards, verified homepages, Wikidata, s2);
  3. store + propagate each hit, record each miss (--apply only).

LinkedIn rate-limits even a residential IP now and then: a 429 pauses it
(--linkedin-cooldown, doubling on repeats) and queued calls wait. If it
keeps refusing, the run stops, stores nothing that finished without
LinkedIn (a wordmark stored now would be kept for good), and a re-run
picks up where it left off.

A wrong stored logo is undone with --reharvest NAME (implies --company
NAME): the image is demoted and blocked for good, rows still showing it get
back the hotlink it replaced, and the employer is harvested again, trying
the hotlinks it replaced first (services/logo_cache.demote_logo).

The default is a DRY RUN: it harvests and reports what WOULD be stored and
writes nothing. It runs no migrations, uses a session that refuses to
flush or commit, and every SQL statement is checked before it is sent:
anything but SELECT/SHOW raises. That makes it safe against production.

Usage:
    DATABASE_URL=postgres://... python backend/scripts/backfill_logos_v2.py
        [--apply] [--limit N] [--company NAME ...] [--reharvest NAME ...]
        [--concurrency 4] [--retry-misses] [--no-migrate] [--timeout 120]
        [--linkedin-cooldown 60] [--dump DIR] [--top 25]
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import functools
import math
import os
import re
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# backend.db.database calls load_dotenv(), which would quietly fall back to
# whatever DATABASE_URL a .env above this checkout holds. Refuse instead.
if __name__ == "__main__" and not os.environ.get("DATABASE_URL"):
    sys.exit("DATABASE_URL is required (set it for this command only)")

import httpx  # noqa: E402
from sqlalchemy import event, func, inspect  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from backend.db.models import ScrapedJob  # noqa: E402
from backend.services import logo_cache, logo_harvester  # noqa: E402
from backend.services.logo_cache import (  # noqa: E402
    HarvestOutcome,
    apply_outcomes,
    company_key,
    company_names_by_key,
    load_branding,
    logo_quality,
    new_harvest_stats,
    plan_harvest,
    repropagate_known_logos,
    run_harvest,
)

KINDS = (
    ("self_hosted", "self-hosted logo"),
    ("trusted", "LinkedIn/Indeed square hotlink"),
    ("hotlink", "other hotlink (unverified)"),
    ("none", "generated or none (letter-avatar-prone)"),
)
_KIND_OF_QUALITY = {3: "self_hosted", 2: "trusted", 1: "hotlink", 0: "none"}
SOURCE_ORDER = (
    "existing", "linkedin_job", "linkedin_search", "ats_*", "homepage", "wikidata", "s2",
)


# --- dry-run safety ---------------------------------------------------------

class ReadOnlyViolation(RuntimeError):
    """A dry run tried to write."""


_READ_ONLY_HEADS = ("SELECT", "SHOW")
_INTO = re.compile(r"\bINTO\b", re.IGNORECASE)


def _refuse_writes(conn, cursor, statement, parameters, context, executemany):
    words = (statement or "").lstrip().split(None, 1)
    if not words or words[0].upper() not in _READ_ONLY_HEADS or _INTO.search(statement):
        raise ReadOnlyViolation(f"dry run refused a statement: {statement.strip()[:120]!r}")


@contextlib.contextmanager
def read_only(engine):
    """Every statement sent through `engine` inside this block must be a
    SELECT or SHOW (SELECT ... INTO refused too); anything else raises
    before it reaches the database."""
    event.listen(engine, "before_cursor_execute", _refuse_writes)
    try:
        yield
    finally:
        event.remove(engine, "before_cursor_execute", _refuse_writes)


class ReadOnlySession(Session):
    """A session that can read but never flush or commit."""

    def flush(self, objects=None):
        if self.new or self.dirty or self.deleted:
            raise ReadOnlyViolation("dry run refused a flush")

    def commit(self):
        raise ReadOnlyViolation("dry run refused a commit")


# --- coverage -----------------------------------------------------------------

def coverage(db: Session) -> dict[str, Counter]:
    """{company_key: Counter(kind -> visible rows)}. One grouped, column-only
    read; kinds follow logo_cache.logo_quality."""
    out: dict[str, Counter] = {}
    rows = (
        db.query(ScrapedJob.company, ScrapedJob.company_logo, func.count(ScrapedJob.id))
        .filter(logo_cache._visible())
        .group_by(ScrapedJob.company, ScrapedJob.company_logo)
        .all()
    )
    for company, logo, count in rows:
        key = company_key(company)
        if key:
            out.setdefault(key, Counter())[_KIND_OF_QUALITY[logo_quality(logo)]] += count
    return out


def _totals(by_key: dict[str, Counter]) -> Counter:
    total: Counter = Counter()
    for kinds in by_key.values():
        total.update(kinds)
    return total


def project(by_key: dict[str, Counter], stored_keys: set[str]) -> dict[str, Counter]:
    """Coverage once every employer in `stored_keys` has a stored logo:
    propagation replaces everything but LinkedIn/Indeed square hotlinks."""
    out: dict[str, Counter] = {}
    for key, kinds in by_key.items():
        kinds = Counter(kinds)
        if key in stored_keys:
            moved = kinds.pop("hotlink", 0) + kinds.pop("none", 0)
            kinds["self_hosted"] += moved
        out[key] = kinds
    return out


# --- report ---------------------------------------------------------------------

def _source_bucket(source: str) -> str:
    return "ats_*" if source.startswith("ats_") else source


def _print_coverage(before: Counter, after: Counter, after_label: str, out) -> None:
    total = sum(before.values()) or 1
    out(f"\ncoverage of visible rows ({sum(before.values())} rows):")
    out(f"  {'':42s} {'before':>14s} {after_label:>18s}")
    for kind, label in KINDS:
        b, a = before.get(kind, 0), after.get(kind, 0)
        out(f"  {label:42s} {b:7d} {100 * b / total:5.1f}% {a:10d} {100 * a / total:5.1f}%")


def _print_sources(outcomes: list[HarvestOutcome], out) -> dict[str, list[int]]:
    table: dict[str, list[int]] = {}  # bucket -> [companies, rows]
    for o in outcomes:
        bucket = _source_bucket(o.result.source) if o.status == "ok" else o.status
        entry = table.setdefault(bucket, [0, 0])
        entry[0] += 1
        entry[1] += o.plan.rows
    detail: Counter = Counter(o.result.source for o in outcomes if o.status == "ok")
    out("\nper source (companies / visible rows):")
    for bucket in SOURCE_ORDER + ("miss", "timeout", "deferred", "error", "skipped"):
        companies, rows = table.get(bucket, [0, 0])
        extra = ""
        if bucket == "ats_*":
            extra = "  " + ", ".join(f"{s}={n}" for s, n in sorted(detail.items()) if s.startswith("ats_"))
        out(f"  {bucket:16s} {companies:6d} {rows:8d}{extra}")
    return table


# --- the run --------------------------------------------------------------------

def _chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _dump(outcome: HarvestOutcome, directory: str) -> None:
    logo = outcome.result.logo
    safe = re.sub(r"[^a-z0-9]+", "-", outcome.plan.key).strip("-")[:60] or "x"
    source = re.sub(r"[^a-z0-9_]+", "-", outcome.result.source or "unknown")
    path = os.path.join(directory, f"{source}__{safe}.{logo.fmt}")
    with open(path, "wb") as fh:
        fh.write(logo.data)


async def run(
    args: argparse.Namespace,
    engine,
    *,
    harvest=None,
    client: httpx.AsyncClient | None = None,
    out=print,
) -> dict:
    """The backfill against `engine`. `harvest` and `client` are injectable
    for tests; by default the real harvester and a fresh HTTP client."""
    dry = not args.apply
    started = time.monotonic()
    out(f"mode: {'DRY RUN (no writes)' if dry else 'APPLY (writes)'}")

    if not dry and not args.no_migrate:
        from backend.migrations.add_company_logos import run_migration

        run_migration(engine)
    has_store = inspect(engine).has_table("company_logos")
    if not dry and not has_store:
        raise SystemExit("company_logos does not exist: run without --no-migrate")
    if not has_store:
        out("company_logos does not exist here: planning as if nothing is stored yet")

    previous_cooldown = logo_harvester.LINKEDIN_BLOCK_COOLDOWN
    logo_harvester.LINKEDIN_BLOCK_COOLDOWN = args.linkedin_cooldown or None
    harvest = harvest or functools.partial(
        logo_harvester.harvest_company_logo, time_cap=args.timeout + 60
    )
    stats = new_harvest_stats()
    outcomes: list[HarvestOutcome] = []
    guard = read_only(engine) if dry else contextlib.nullcontext()
    db = (ReadOnlySession if dry else Session)(bind=engine, autoflush=False)
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(follow_redirects=True, timeout=15)
    try:
        with guard:
            names_by_key = company_names_by_key(db)
            before = coverage(db)

            # Wrong picks named with --reharvest: demoted first, so step 0
            # does not re-point rows at them and step 1 picks them up.
            if args.reharvest and not has_store:
                raise SystemExit("--reharvest: company_logos does not exist here, nothing is stored")
            for name in args.reharvest:
                done = logo_cache.demote_logo(
                    db, name, names=names_by_key.get(company_key(name), []), dry_run=dry
                )
                if done is None:
                    out(f"reharvest {name}: no stored logo, nothing to demote")
                    continue
                out(f"reharvest {name}: {'would demote' if dry else 'demoted'} "
                    f"{done['source'] or '?'} {done['source_url'][:100]} ({done['sha'][:12]}); "
                    f"{done['rows']} rows {'would get' if dry else 'got'} back "
                    f"{done['restored_to'][:100] or 'no logo'}")

            # Step 0: rows of employers already stored.
            if has_store:
                stats["repropagated_rows"] = repropagate_known_logos(
                    db, names_by_key, max_companies=None, dry_run=dry
                )
            out(f"step 0: {stats['repropagated_rows']} rows "
                f"{'would be ' if dry else ''}re-pointed at logos already stored")

            # Step 1: the work list.
            plans = plan_harvest(
                db, names_by_key, logo_harvester.LogoHints,
                limit=args.limit, only=(args.company + args.reharvest) or None,
                retry_misses=args.retry_misses, has_store=has_store,
                reharvest=args.reharvest,
            )
            stats["companies_considered"] = len(plans)
            out(f"step 1: {len(plans)} employers to harvest, "
                f"{sum(p.rows for p in plans)} visible rows")
            borrowed = [p for p in plans if p.aliases]
            for p in borrowed[:15]:
                out(f"  seeded from a longer name: {p.display} <- {', '.join(p.aliases)}")
            if len(borrowed) > 15:
                out(f"  ... {len(borrowed) - 15} more seeded from a longer name")

            # Steps 2+3: harvest in batches; each batch is written before the
            # next starts, so an interrupted run keeps what it found.
            done = 0
            finished: dict[str, float] = {}

            def progress(outcome: HarvestOutcome) -> None:
                nonlocal done
                done += 1
                finished[outcome.plan.key] = time.monotonic()
                what = outcome.result.source if outcome.status == "ok" else outcome.status
                out(f"  [{done}/{len(plans)}] {what:16s} {outcome.plan.display} "
                    f"({outcome.plan.rows} rows)")

            for batch in _chunked(plans, max(args.concurrency * 10, 1)):
                # Hand the connection back before minutes of network work:
                # Neon's pooler drops idle ones, and the next query checks
                # out a fresh, pre-pinged connection instead.
                db.rollback()
                got = await run_harvest(
                    client, batch, harvest, budget_s=math.inf,
                    concurrency=args.concurrency, per_company_timeout=args.timeout,
                    on_done=progress,
                )
                li = logo_harvester.linkedin_stats(client)
                gave_up = bool(args.linkedin_cooldown and li["blocked"])
                if gave_up:
                    # Whatever finished after LinkedIn was given up on went
                    # without its best source: store none of it now (a
                    # wordmark would be kept for good); the next run retries.
                    got = [
                        o._replace(status="deferred")
                        if finished.get(o.plan.key, 0.0) >= (li["blocked_at"] or 0.0)
                        and not (o.status == "ok" and o.result.source.startswith("linkedin"))
                        else o
                        for o in got
                    ]
                outcomes += got
                if args.dump:
                    os.makedirs(args.dump, exist_ok=True)
                    for o in got:
                        if o.status == "ok":
                            _dump(o, args.dump)
                if not dry:
                    apply_outcomes(db, [o for o in got if o.status != "deferred"], stats,
                                   record_timeouts=False)
                if gave_up:
                    left = len(plans) - len(outcomes)
                    out(f"  LinkedIn stopped answering: stopping here; {left} employers not "
                        f"tried and {sum(o.status == 'deferred' for o in got)} deferred. "
                        f"Re-run later to finish.")
                    break

            # Report.
            if dry:
                stored_keys = {o.plan.key for o in outcomes if o.status == "ok"}
                if has_store:
                    stored_keys |= {k for k, r in load_branding(db, names_by_key).items() if r.logo}
                after = _totals(project(before, stored_keys))
                after_label = "projected"
            else:
                after = _totals(coverage(db))
                after_label = "after"
    finally:
        logo_harvester.LINKEDIN_BLOCK_COOLDOWN = previous_cooldown
        if own_client:
            await client.aclose()
        try:
            db.close()
        except Exception as exc:  # a dropped connection must not eat the report
            out(f"(closing the session failed: {exc.__class__.__name__})")

    table = _print_sources(outcomes, out)
    _print_coverage(_totals(before), after, after_label, out)
    li = logo_harvester.linkedin_stats(client)
    out(f"\nLinkedIn: {li['calls']} calls, {li['blocks']} rate-limit blocks"
        f"{', gave up for the rest of the run' if li['blocked'] else ''}")
    remaining = sorted(
        (o for o in outcomes if o.status != "ok"), key=lambda o: (-o.plan.rows, o.plan.key)
    )
    if remaining:
        out(f"\ntop remaining misses ({len(remaining)} employers, "
            f"{sum(o.plan.rows for o in remaining)} rows):")
        for o in remaining[:args.top]:
            bogus = f"  bogus: {', '.join(o.bogus)}" if o.bogus else ""
            out(f"  {o.plan.rows:6d}  {o.status:8s} {o.plan.display}{bogus}")
    elapsed = time.monotonic() - started
    out(f"\n{'dry run' if dry else 'applied'} in {elapsed:.0f}s")
    return {
        "dry_run": dry,
        "stats": stats,
        "sources": table,
        "before": _totals(before),
        "after": after,
        "outcomes": outcomes,
        "seconds": elapsed,
    }


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true",
                        help="write to the database (default: dry run, writes nothing)")
    parser.add_argument("--limit", type=int, default=None, help="at most N employers")
    parser.add_argument("--company", action="append", default=[], metavar="NAME",
                        help="only this employer (repeatable)")
    parser.add_argument("--reharvest", action="append", default=[], metavar="NAME",
                        help="its stored logo is wrong: demote and block it, give its rows back "
                             "the hotlink it replaced, and harvest it again (repeatable; "
                             "implies --company NAME)")
    parser.add_argument("--concurrency", type=int, default=4,
                        help="employers harvested at once (LinkedIn is paced separately)")
    parser.add_argument("--retry-misses", action="store_true",
                        help="also retry employers whose miss backoff is not due yet")
    parser.add_argument("--no-migrate", action="store_true",
                        help="with --apply: do not create company_logos first")
    parser.add_argument("--timeout", type=float, default=120.0,
                        help="seconds per employer; a timeout is reported, not recorded")
    parser.add_argument("--linkedin-cooldown", type=float, default=60.0,
                        help="pause after a LinkedIn 429 (doubling); 0 skips LinkedIn instead")
    parser.add_argument("--dump", default="", metavar="DIR",
                        help="write each harvested logo (normalized) into DIR")
    parser.add_argument("--top", type=int, default=25, help="misses listed at the end")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    # Harvested names and URLs can hold non-ASCII (Commons filenames); never
    # let a Windows cp1252 console kill the run over a progress print.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    from backend.db.database import engine

    host = engine.url.host or engine.url.database
    print(f"database: {engine.url.get_backend_name()} @ {host}")
    # Flushed per line so a redirected log shows progress while it runs.
    asyncio.run(run(args, engine, out=functools.partial(print, flush=True)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
