"""
One-time feed cleanup: bring the catalogue, now, to the state the new
lifecycle code would converge to over days of cron runs.

Phases (each idempotent, column-only reads, descriptions never selected):

  a  GitHub-list data fixes. Year-less list dates the old parser stamped with
     the current year go back a year (they topped the date-sorted feed and
     escaped expiry); markdown emphasis leaves company/title through the
     parser's own clean-up (the '*' letter avatar); utm_* URL twins get
     ``duplicate_of`` pointing at the canonical row (soft hide, never a
     delete, saved-job and application FKs untouched).
  b  The lifecycle sweeps cron-freshness runs, called straight from
     listing_freshness: legacy board_key adoption, stale sweep, aggregator
     expiry. Its last step, terminal expiry, runs after phase c (as
     cron-freshness runs it after its checks): it only ends a row a check
     has reached since its last positive evidence. Right before it, stale
     rows on boards no crawl reconciles get ``last_seen_at`` set back to when
     they went stale: the old verifier stamped it on every probe, so those
     stamps are not evidence.
  c  Every still-visible row checked against its platform
     (platform_liveness.check_listings, per-host politeness built in) and the
     verdict applied by listing_freshness.record_liveness: dead -> removed,
     authoritative alive -> confirmed (a stale row revives), anything else
     only stamps ``last_probed_at``. A check that got no answer (host
     skipped, never got its turn, rate-limited) is deferred, not stamped.
  d  Report only: rows still visible whose verdict was unknown, by host, i.e.
     what nothing can verify (Indeed, bot-walled career sites).

DRY RUN is the default: no DB write and no migration. Every statement goes
through a guard that refuses anything but SELECT/SHOW, and the database
enforces it too (SQLite ``PRAGMA query_only``, Postgres ``SET TRANSACTION
READ ONLY`` per transaction, which is safe behind Neon's pooler). The
listing_freshness functions run against a recording session that captures
each UPDATE (ids + values) instead of executing it, so the dry-run numbers
come from the exact filters cron-freshness uses. Phase c still makes its
outbound HTTP checks (reads against the job platforms) so the report shows
real verdicts.

Usage (from the repo root):
    DATABASE_URL=postgres://... python backend/scripts/cleanup_feed.py           # dry run
    DATABASE_URL=postgres://... python backend/scripts/cleanup_feed.py --apply
        [--phase a,b,c,d] [--limit N] [--sample] [--host-filter myworkdayjobs.com]
        [--concurrency 8] [--deadline-minutes 90] [--recheck-hours H] [--no-migrate]

``--limit`` and ``--host-filter`` narrow phase c only. ``--sample`` checks a
random subset instead of least-recently-probed first, so a ``--limit`` dry
run gives a representative projection. After an interrupted ``--apply``,
re-run with ``--recheck-hours 6`` to skip the rows already checked.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import os
import random
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlsplit

# Titles and URLs are full of non-ASCII; never let a Windows cp1252 console
# kill a run over a progress print. Line-buffered so progress shows up live
# when the output is redirected to a log file.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except (AttributeError, ValueError):  # a test runner's captured stream
    pass

# Captured before any backend import: backend.db.database calls load_dotenv(),
# which would otherwise fill DATABASE_URL from a .env further up the tree and
# point the script at a database nobody named on the command line.
_DATABASE_URL = os.environ.get("DATABASE_URL", "")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import event, func, inspect, nulls_first, or_  # noqa: E402
from sqlalchemy.orm import Query, Session  # noqa: E402
from sqlalchemy.sql import operators  # noqa: E402
from sqlalchemy.sql.elements import BinaryExpression, BindParameter  # noqa: E402

from backend.db.models import ScrapedJob  # noqa: E402
from backend.services import listing_freshness, platform_liveness  # noqa: E402
from backend.services.cross_source_dedup import (  # noqa: E402
    _SOURCE_TIER,
    canonical_url,
    effective_source,
    normalize_title,
)
from backend.services.listing_freshness import (  # noqa: E402
    HIDDEN_LISTING_STATUSES,
    LISTING_ACTIVE,
    LISTING_REMOVED,
    LISTING_STALE,
)
from backend.services.markdown_parser import clean_cell_text, clean_company_name  # noqa: E402

PHASES = "abcd"

# The parser's own tolerance for list-vs-server clock skew
# (markdown_parser._FUTURE_TOLERANCE): a year-less date more than this far
# past the day we first saw the row was given the wrong year.
FUTURE_TOLERANCE = datetime.timedelta(days=2)

CHUNK = 200  # rows per commit (phases a and c) and per liveness batch
SAMPLE_SIZE = 5  # ids/urls printed per step
DEAD_SAMPLES = 20
ALIVE_SAMPLES = 10
UNKNOWN_HOSTS_SHOWN = 30

_IN_CHUNK = 400  # keep IN () lists comfortably under driver parameter limits


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _utcnow() -> datetime.datetime:
    """Naive UTC, like the columns and listing_freshness._utcnow."""
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


# ─── Dry-run write guard ─────────────────────────────────────────────────────

class DryRunWriteError(RuntimeError):
    """A dry run tried to write. Nothing was sent to the database."""


_TXN_READ_ONLY = "SET TRANSACTION READ ONLY"
_LEADING_COMMENTS_RE = re.compile(r"^\s*(?:/\*.*?\*/\s*|--[^\n]*(?:\n|$)\s*)*", re.DOTALL)
_READ_ONLY_RE = re.compile(r"^(?:select|show)\b", re.IGNORECASE)
# SELECT ... INTO creates a table on Postgres.
_SELECT_INTO_RE = re.compile(r"\binto\b", re.IGNORECASE)
# SQLite's schema reads ('PRAGMA main.table_xinfo("scraped_jobs")'); an
# assignment ('PRAGMA x = y') never matches.
_PRAGMA_READ_RE = re.compile(r"^pragma\s+[\w.]+\s*(?:\([^)=]*\))?\s*;?$", re.IGNORECASE)


def is_read_only_statement(statement: str) -> bool:
    """True for a plain SELECT/SHOW, a SQLite schema-read PRAGMA, or the
    read-only transaction marker the guard itself issues. Everything else,
    DML, DDL, PRAGMA assignments, SET, is refused."""
    text = _LEADING_COMMENTS_RE.sub("", statement or "").strip()
    if text.upper() == _TXN_READ_ONLY or _PRAGMA_READ_RE.match(text):
        return True
    return bool(_READ_ONLY_RE.match(text)) and not _SELECT_INTO_RE.search(text)


def install_read_only_guard(engine) -> list[str]:
    """Make ``engine`` read-only for this process. Returns the list every
    statement it lets through is appended to (tests assert on it).

    Two independent layers: a before_cursor_execute hook that raises
    DryRunWriteError on anything but SELECT/SHOW before it reaches the
    driver, and the database's own read-only mode, so even a statement the
    hook misjudged is refused server-side."""
    seen: list[str] = []

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        if not is_read_only_statement(statement):
            raise DryRunWriteError(f"dry run refused a write: {statement.strip()[:160]}")
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", before_cursor_execute)

    if engine.dialect.name == "sqlite":
        def sqlite_query_only(dbapi_conn, _record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA query_only = ON")
            cursor.close()
        event.listen(engine, "connect", sqlite_query_only)
    elif engine.dialect.name == "postgresql":
        # Transaction-scoped on purpose: a SESSION-level setting would ride a
        # pooled server connection (Neon's PgBouncer runs transaction mode)
        # into some other client's session.
        def postgres_read_only(conn):
            conn.exec_driver_sql(_TXN_READ_ONLY)
        event.listen(engine, "begin", postgres_read_only)

    # Pooled connections opened before the listeners never ran the connect hook.
    engine.dispose()
    return seen


def assert_database_read_only(db: Session) -> None:
    """Belt and braces for a dry run on Postgres: the server itself must say
    this transaction is read-only before anything else happens."""
    if db.get_bind().dialect.name != "postgresql":
        return
    state = db.connection().exec_driver_sql("SHOW transaction_read_only").scalar()
    if str(state).lower() != "on":
        raise DryRunWriteError(f"expected a read-only transaction, server says {state!r}")


# ─── Recording session ───────────────────────────────────────────────────────

@dataclass
class Write:
    step: str
    ids: list[int]
    values: dict


@dataclass
class Recorder:
    """Every UPDATE the listing_freshness functions issue, with the ids it
    matches, so both modes report exactly what changed (or would)."""
    writes: list[Write] = field(default_factory=list)
    step: str = ""

    def since(self, index: int) -> list[Write]:
        return self.writes[index:]


def _single_row_id(query: Query):
    """The id when a query's WHERE is exactly ``ScrapedJob.id == <value>``
    (record_liveness, backfill_board_keys): recorded without a round trip."""
    clause = query.whereclause
    if not isinstance(clause, BinaryExpression) or clause.operator is not operators.eq:
        return None
    left, right = clause.left, clause.right
    table = getattr(getattr(left, "table", None), "name", None)
    if getattr(left, "name", None) == "id" and table == ScrapedJob.__tablename__ \
            and isinstance(right, BindParameter):
        return right.value
    return None


class _RecordingQuery:
    """A Query stand-in: reads pass through untouched; ``update`` records
    the matched ids and the new values, and only executes when writing."""

    def __init__(self, query: Query, session: "RecordingSession"):
        self._query = query
        self._session = session

    def __getattr__(self, name):
        attr = getattr(self._query, name)
        if not callable(attr):
            return attr

        def call(*args, **kwargs):
            result = attr(*args, **kwargs)
            return _RecordingQuery(result, self._session) if isinstance(result, Query) else result
        return call

    def __iter__(self):
        return iter(self._query)

    def update(self, values: dict, synchronize_session="auto", **kwargs) -> int:
        row_id = _single_row_id(self._query)
        if row_id is not None:
            ids = [row_id]
        else:
            ids = [row[0] for row in self._query.with_entities(ScrapedJob.id).all()]
        self._session.recorder.writes.append(
            Write(self._session.recorder.step, ids, dict(values)))
        if not self._session.write:
            return len(ids)
        return self._query.update(values, synchronize_session=synchronize_session, **kwargs)

    def delete(self, *args, **kwargs):
        raise DryRunWriteError("cleanup_feed never deletes rows")


class RecordingSession:
    """The session the lifecycle functions run against. ``write=False`` is
    the dry run: updates are recorded, never sent, and commit is a no-op
    (the engine guard still stands behind it)."""

    def __init__(self, db: Session, recorder: Recorder, *, write: bool):
        self._db = db
        self.recorder = recorder
        self.write = write

    def query(self, *entities, **kwargs):
        return _RecordingQuery(self._db.query(*entities, **kwargs), self)

    def commit(self):
        if self.write:
            self._db.commit()

    def flush(self, *args, **kwargs):
        if self.write:
            self._db.flush(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._db, name)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _visible_filters():
    """The feed's own filter (routers/jobs.py list_jobs)."""
    return (
        ScrapedJob.duplicate_of.is_(None),
        ScrapedJob.listing_status.in_((LISTING_ACTIVE, LISTING_STALE)),
        func.trim(func.coalesce(ScrapedJob.company, "")) != "",
    )


def visible_ids(db: Session) -> set[int]:
    return {row[0] for row in db.query(ScrapedJob.id).filter(*_visible_filters()).all()}


def has_probe_column(db: Session) -> bool:
    """Prod gets ``last_probed_at`` from the wave-1 migration; until then a
    dry run must not name it in any query."""
    columns = inspect(db.get_bind()).get_columns(ScrapedJob.__tablename__)
    return any(column["name"] == "last_probed_at" for column in columns)


def _urls_for(db: Session, ids: list[int]) -> dict[int, str]:
    found: dict[int, str] = {}
    for chunk in _chunks(list(ids), _IN_CHUNK):
        for row_id, url in db.query(ScrapedJob.id, ScrapedJob.url).filter(ScrapedJob.id.in_(chunk)):
            found[row_id] = url or ""
    return found


def _print_samples(db: Session, ids: list[int], label: str = "sample") -> None:
    if not ids:
        return
    picked = sorted(ids)[:SAMPLE_SIZE]
    urls = _urls_for(db, picked)
    for row_id in picked:
        print(f"      {label} id={row_id} {urls.get(row_id, '')[:150]}")


def minus_one_year(stamp: datetime.datetime) -> datetime.datetime:
    try:
        return stamp.replace(year=stamp.year - 1)
    except ValueError:  # Feb 29
        return stamp.replace(year=stamp.year - 1, day=28)


def corrected_posted_date(posted: datetime.datetime | None,
                          reference: datetime.datetime | None) -> datetime.datetime | None:
    """A year-less list date the old parser put in the wrong year: step back
    a year until it is no longer past ``reference`` (when we first saw the
    row) plus the parser's tolerance, the same rule markdown_parser now
    applies at parse time. Anything else is returned unchanged."""
    if posted is None or reference is None:
        return posted
    limit = reference + FUTURE_TOLERANCE
    fixed = posted
    for _ in range(3):
        if fixed <= limit:
            break
        fixed = minus_one_year(fixed)
    return fixed if fixed <= limit else posted


def has_utm(url: str) -> bool:
    try:
        query = urlsplit(url or "").query
    except ValueError:
        return False
    return any(key.lower().startswith("utm_")
               for key, _value in parse_qsl(query, keep_blank_values=True))


_PLATFORM_FAMILIES = (
    ("myworkdayjobs.com", "workday"), ("myworkdaysite.com", "workday"),
    ("smartrecruiters.com", "smartrecruiters"), ("greenhouse.io", "greenhouse"),
    ("lever.co", "lever"), ("ashbyhq.com", "ashby"), ("oraclecloud.com", "oracle_hcm"),
    ("linkedin.com", "linkedin"), ("indeed.com", "indeed"), ("taleo.net", "taleo"),
    ("successfactors.com", "successfactors"), ("successfactors.eu", "successfactors"),
    ("icims.com", "icims"), ("eightfold.ai", "eightfold"), ("workable.com", "workable"),
    ("bamboohr.com", "bamboohr"), ("jobvite.com", "jobvite"), ("breezy.hr", "breezy"),
    ("recruitee.com", "recruitee"), ("phenompeople.com", "phenom"),
)


def host_of(url: str) -> str:
    try:
        return (urlsplit(url or "").hostname or "").lower()
    except ValueError:
        return ""


def _board_of(url: str) -> str:
    """host + first path segment ('boards.greenhouse.io/carvana'): the
    buckets report samples are spread across."""
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return ""
    first = next((segment for segment in parts.path.split("/") if segment), "")
    return f"{(parts.hostname or '').lower()}/{first}"


def _spread(buckets: dict[str, list], limit: int) -> list:
    """Round-robin across buckets, up to ``limit`` items."""
    picked: list = []
    queues = list(buckets.values())
    depth = 0
    while len(picked) < limit and any(depth < len(queue) for queue in queues):
        for queue in queues:
            if depth < len(queue) and len(picked) < limit:
                picked.append(queue[depth])
        depth += 1
    return picked


def host_family(url: str) -> str:
    """Coarse platform bucket for the report."""
    host = host_of(url)
    if "gh_jid=" in (url or ""):
        return "greenhouse"
    for suffix, family in _PLATFORM_FAMILIES:
        if host == suffix or host.endswith("." + suffix):
            return family
    return "other" if host else "malformed"


# ─── Report ──────────────────────────────────────────────────────────────────

@dataclass
class Report:
    dry_run: bool
    visible_start: set[int] = field(default_factory=set)
    # id -> what hides it ("a:utm_twin", "b:sweep_aggregator_expiry", "c:dead")
    hidden: dict[int, str] = field(default_factory=dict)
    phase_a: dict = field(default_factory=dict)
    phase_b: dict = field(default_factory=dict)
    phase_c: dict = field(default_factory=dict)
    unknown_by_host: Counter = field(default_factory=Counter)
    unknown_by_family: Counter = field(default_factory=Counter)
    weak_alive_by_family: Counter = field(default_factory=Counter)

    def hide(self, ids, why: str) -> int:
        """Record rows a phase takes out of the feed; returns how many of
        them were visible when the run started."""
        newly = 0
        for row_id in ids:
            if row_id in self.visible_start and row_id not in self.hidden:
                self.hidden[row_id] = why
                newly += 1
        return newly

    @property
    def visible_after(self) -> int:
        return len(self.visible_start) - len(self.hidden)


# ─── Phase a: GitHub-list data fixes ─────────────────────────────────────────

def phase_a(db: Session, report: Report, *, write: bool) -> dict:
    stats = {"dates_fixed": 0, "companies_cleaned": 0, "titles_cleaned": 0,
             "utm_groups": 0, "utm_twins_hidden": 0, "utm_twins_hidden_visible": 0}
    session = RecordingSession(db, Recorder(), write=write)
    verb = "fixed" if write else "would fix"

    # a1: year-less dates stamped with the current year.
    rows = (
        db.query(ScrapedJob.id, ScrapedJob.posted_date,
                 ScrapedJob.first_seen_at, ScrapedJob.scraped_at)
        .filter(ScrapedJob.source_platform == "github", ScrapedJob.posted_date.isnot(None))
        .order_by(ScrapedJob.id)
        .all()
    )
    date_fixes = []
    for row_id, posted, first_seen, scraped in rows:
        fixed = corrected_posted_date(posted, first_seen or scraped)
        if fixed != posted:
            date_fixes.append((row_id, posted, fixed))
    for chunk in _chunks(date_fixes, CHUNK):
        for row_id, _posted, fixed in chunk:
            session.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                {"posted_date": fixed}, synchronize_session=False)
        session.commit()
    stats["dates_fixed"] = len(date_fixes)
    print(f"  [a] github posted_date {verb}: {len(date_fixes)} of {len(rows)} dated github rows")
    for row_id, posted, fixed in date_fixes[:SAMPLE_SIZE]:
        print(f"      id={row_id} {posted:%Y-%m-%d} -> {fixed:%Y-%m-%d}")

    # a2: markdown emphasis in company/title, through the parser's clean-up.
    rows = (
        db.query(ScrapedJob.id, ScrapedJob.company, ScrapedJob.title, ScrapedJob.title_norm)
        .filter(ScrapedJob.source_platform == "github")
        .order_by(ScrapedJob.id)
        .all()
    )
    name_fixes = []
    for row_id, company, title, title_norm in rows:
        values: dict = {}
        clean_company = clean_company_name(company or "")
        if clean_company and clean_company != (company or ""):
            values["company"] = clean_company
        clean_title = clean_cell_text(title or "")
        if clean_title and clean_title != (title or ""):
            values["title"] = clean_title
            norm = normalize_title(clean_title)
            if norm and title_norm and title_norm != "\x01" and norm != title_norm:
                values["title_norm"] = norm
        if values:
            name_fixes.append((row_id, company, title, values))
    for chunk in _chunks(name_fixes, CHUNK):
        for row_id, _company, _title, values in chunk:
            session.query(ScrapedJob).filter(ScrapedJob.id == row_id).update(
                values, synchronize_session=False)
        session.commit()
    stats["companies_cleaned"] = sum(1 for fix in name_fixes if "company" in fix[3])
    stats["titles_cleaned"] = sum(1 for fix in name_fixes if "title" in fix[3])
    print(f"  [a] github names {verb}: {stats['companies_cleaned']} companies, "
          f"{stats['titles_cleaned']} titles")
    for row_id, company, title, values in name_fixes[:SAMPLE_SIZE]:
        print(f"      id={row_id} {company!r} -> {values.get('company', company)!r}; "
              f"{title!r} -> {values.get('title', title)!r}")

    # a3: utm_* URL twins.
    utm_hidden = collapse_utm_twins(db, session, report, stats)
    print(f"  [a] utm twins: {stats['utm_groups']} groups, {'set' if write else 'would set'} "
          f"duplicate_of on {stats['utm_twins_hidden']} rows "
          f"({stats['utm_twins_hidden_visible']} of them visible)")
    for row_id, keeper_id, url in utm_hidden[:SAMPLE_SIZE]:
        print(f"      id={row_id} -> {keeper_id} {url[:150]}")
    return stats


def collapse_utm_twins(db: Session, session: RecordingSession, report: Report,
                       stats: dict) -> list[tuple[int, int, str]]:
    """Rows whose URLs differ only by utm_* params are one posting: the URL
    UNIQUE constraint let the GitHub lists' '?utm_source=vansh' copies in
    beside the clean URL. In each group the one row left visible prefers the
    utm-free URL, then a live listing status, then cross_source_dedup's
    order (source tier, longer description, lower id); every other unhidden
    row gets ``duplicate_of`` = that row. Rows already hidden are left alone,
    so the keeper never points at a hidden row and there are no chains."""
    columns = (ScrapedJob.id, ScrapedJob.url, ScrapedJob.source_platform,
               ScrapedJob.listing_status, ScrapedJob.duplicate_of,
               func.length(func.coalesce(ScrapedJob.description, "")))
    rows = {row[0]: row for row in db.query(*columns).filter(ScrapedJob.url.ilike("%utm%")).all()
            if has_utm(row[1])}
    wanted: set[str] = set()
    for row in rows.values():
        canon = canonical_url(row[1])
        wanted.update((canon, canon + "/"))
    for chunk in _chunks(sorted(wanted), _IN_CHUNK):
        for row in db.query(*columns).filter(ScrapedJob.url.in_(chunk)).all():
            rows.setdefault(row[0], row)

    groups: dict[str, list] = {}
    for row in rows.values():
        groups.setdefault(canonical_url(row[1]), []).append(row)

    hidden: list[tuple[int, int, str]] = []
    pending = 0
    for _canon, members in sorted(groups.items()):
        unhidden = [row for row in members if row[4] is None]
        if len(members) < 2 or len(unhidden) < 2:
            continue
        stats["utm_groups"] += 1
        unhidden.sort(key=lambda r: (
            1 if has_utm(r[1]) else 0,
            1 if r[3] in HIDDEN_LISTING_STATUSES else 0,
            _SOURCE_TIER.get(effective_source(r[2] or "", r[1] or ""), 3),
            -(r[5] or 0),
            r[0],
        ))
        keeper = unhidden[0]
        for row in unhidden[1:]:
            session.query(ScrapedJob).filter(ScrapedJob.id == row[0]).update(
                {"duplicate_of": keeper[0]}, synchronize_session=False)
            hidden.append((row[0], keeper[0], row[1]))
            stats["utm_twins_hidden"] += 1
            stats["utm_twins_hidden_visible"] += report.hide([row[0]], "a:utm_twin")
            pending += 1
        if pending >= CHUNK:
            session.commit()
            pending = 0
    session.commit()
    return hidden


# ─── Phase b: lifecycle sweeps ───────────────────────────────────────────────

def _run_steps(db: Session, report: Report, recorder: Recorder, steps, stats: dict,
               *, write: bool) -> None:
    """Run lifecycle steps against the recording session, recording and
    reporting what each changed (or would)."""
    for name, call in steps:
        recorder.step = name
        start = len(recorder.writes)
        result = call()
        writes = recorder.since(start)
        ids = sorted({row_id for w in writes for row_id in w.ids})
        hiding = sorted({row_id for w in writes if w.values.get("listing_status")
                         in HIDDEN_LISTING_STATUSES for row_id in w.ids})
        newly_hidden = report.hide(hiding, f"b:{name}")
        stats[name] = {"rows": len(ids), "result": result, "hidden_visible": newly_hidden}
        # A dry run counts each UPDATE against the unchanged table, so the
        # per-statement counts of one sweep can overlap; ``rows`` is the union.
        detail = result if write else f"per-statement matches, may overlap: {result}"
        print(f"  [b] {name}: {len(ids)} rows ({detail}), "
              f"{newly_hidden} leave the visible feed")
        _print_samples(db, ids)


def phase_b(db: Session, report: Report, *, write: bool, now: datetime.datetime) -> dict:
    """The sweeps cron-freshness runs before its checks, in its order, from
    listing_freshness itself (terminal expiry comes after phase c, see
    phase_terminal). The dry run counts each against the current state, so
    knock-on effects inside one pass are not simulated: its projection is a
    lower bound."""
    recorder = Recorder()
    session = RecordingSession(db, recorder, write=write)
    stats: dict = {}

    # Legacy board_key adoption: 500 rows per call, committed per call.
    recorder.step = "backfill_board_keys"
    start = len(recorder.writes)
    adopted = 0
    if write:
        for _ in range(1000):
            before = len(recorder.writes)
            adopted += listing_freshness.backfill_board_keys(session, limit=500)
            if len(recorder.writes) == before:
                break
    else:
        # Nothing changes in a dry run, so one call over every candidate.
        adopted = listing_freshness.backfill_board_keys(session, limit=1_000_000)
    touched = [w.ids[0] for w in recorder.since(start)]
    stats["board_keys_adopted"] = adopted
    stats["board_keys_marked_unknown"] = len(touched) - adopted
    print(f"  [b] backfill_board_keys: {len(touched)} legacy rows keyed "
          f"({adopted} onto a real board, {len(touched) - adopted} 'unknown')")

    steps = (
        ("sweep_stale", lambda: listing_freshness.sweep_stale(session, now=now)),
        ("sweep_aggregator_expiry",
         lambda: listing_freshness.sweep_aggregator_expiry(session, now=now)),
    )
    _run_steps(db, report, recorder, steps, stats, write=write)
    return stats


def reset_legacy_seen(session) -> int:
    """Stale rows on boards no crawl reconciles: ``last_seen_at`` back to
    when the row went stale. The old verifier stamped ``last_seen_at`` on
    every probe, and on these boards nothing else writes it except an
    authoritative alive, which revives the row to active; so on a row still
    stale, a stamp after it went stale is one of those, not evidence.
    Column-only UPDATE through ``session``."""
    return (
        session.query(ScrapedJob)
        .filter(
            ScrapedJob.listing_status == LISTING_STALE,
            or_(ScrapedJob.board_key.is_(None), ScrapedJob.board_key.in_(("", "unknown"))),
            ScrapedJob.last_seen_at > ScrapedJob.listing_status_changed_at,
        )
        .update({"last_seen_at": ScrapedJob.listing_status_changed_at},
                synchronize_session=False)
    )


def phase_terminal(db: Session, report: Report, *, write: bool,
                   now: datetime.datetime) -> dict:
    """Phase b's last step, run after phase c: the legacy last_seen_at reset,
    then listing_freshness.sweep_terminal_expiry, which ends only rows a
    check has reached since their last positive evidence (phase c's checks
    count). A dry run records both against the unchanged table: it can't
    see phase c's stamps or the reset, so its count is a lower bound."""
    recorder = Recorder()
    session = RecordingSession(db, recorder, write=write)
    stats: dict = {}
    if not has_probe_column(db):
        print("  [b] sweep_terminal_expiry skipped: scraped_jobs.last_probed_at is missing "
              "(run the migration); nothing expires unchecked")
        if write:
            return {"skipped": "last_probed_at missing"}
        steps = (("reset_legacy_seen", lambda: reset_legacy_seen(session)),)
    else:
        steps = (
            ("reset_legacy_seen", lambda: reset_legacy_seen(session)),
            ("sweep_terminal_expiry",
             lambda: listing_freshness.sweep_terminal_expiry(session, now=now)),
        )
    _run_steps(db, report, recorder, steps, stats, write=write)
    return stats


# ─── Phase c: platform liveness ──────────────────────────────────────────────

@dataclass
class ProbeOptions:
    limit: int | None = None
    sample: bool = False
    seed: int = 7
    host_filter: str = ""
    concurrency: int = 8
    deadline_minutes: float = 90.0
    recheck_hours: float = 0.0


def phase_c_candidates(db: Session, report: Report, options: ProbeOptions,
                       *, probe_column: bool, now: datetime.datetime) -> tuple[list, int]:
    """(rows to check, how many visible rows were eligible before --limit).
    Rows are (id, url, listing_status, board_key). Column-only."""
    query = db.query(ScrapedJob.id, ScrapedJob.url, ScrapedJob.listing_status,
                     ScrapedJob.board_key).filter(*_visible_filters())
    if options.host_filter:
        query = query.filter(ScrapedJob.url.ilike(f"%{options.host_filter}%"))
    if probe_column and options.recheck_hours > 0:
        cutoff = now - datetime.timedelta(hours=options.recheck_hours)
        query = query.filter((ScrapedJob.last_probed_at.is_(None))
                             | (ScrapedJob.last_probed_at < cutoff))
    if probe_column:
        query = query.order_by(nulls_first(ScrapedJob.last_probed_at.asc()), ScrapedJob.id)
    else:
        query = query.order_by(ScrapedJob.id)
    rows = [row for row in query.all() if row[0] not in report.hidden]
    if options.host_filter:
        needle = options.host_filter.lower()
        rows = [row for row in rows if needle in host_of(row[1])]
    eligible = len(rows)
    if options.sample:
        random.Random(options.seed).shuffle(rows)
    if options.limit is not None:
        rows = rows[:options.limit]
    return rows, eligible


async def phase_c(db: Session, report: Report, options: ProbeOptions, *,
                  write: bool, now: datetime.datetime) -> dict:
    probe_column = has_probe_column(db)
    if write and not probe_column:
        print("  [c] scraped_jobs.last_probed_at is missing: run the migration "
              "(drop --no-migrate) before --apply; phase c skipped")
        return {"skipped": "last_probed_at missing"}

    rows, eligible = phase_c_candidates(db, report, options, probe_column=probe_column, now=now)
    # End the read transaction before minutes of network work: an idle open
    # transaction pins a pooled server connection for nothing.
    if write:
        db.commit()
    else:
        db.rollback()
    print(f"  [c] checking {len(rows)} of {eligible} eligible visible rows "
          f"(concurrency {options.concurrency}, deadline {options.deadline_minutes:g} min"
          f"{', random sample' if options.sample else ''})")

    recorder = Recorder(step="record_liveness")
    session = RecordingSession(db, recorder, write=write)
    combos: Counter = Counter()
    outcomes: Counter = Counter()
    # Samples are bucketed per board so one big board can't fill them all.
    dead_buckets: dict[str, list] = {}
    alive_buckets: dict[str, list] = {}
    deferred = 0
    deferred_reasons: Counter = Counter()
    started = time.monotonic()
    deadline = started + options.deadline_minutes * 60

    async with platform_liveness.make_client() as client:
        for index, chunk in enumerate(_chunks(rows, CHUNK)):
            # A fresh per-run state per chunk: a host that walled us (LinkedIn
            # 429s) gets another chance next chunk instead of being skipped
            # for the rest of a long run. LinkedIn stays paced, but this long
            # one-time run lifts the cron's per-run LinkedIn budget.
            results = await platform_liveness.check_listings(
                client, [row[1] for row in chunk],
                concurrency=options.concurrency, deadline=deadline,
                cache=platform_liveness.run_cache(linkedin_cap=None),
                board_keys={row[1]: row[3] or "" for row in chunk},
            )
            for row_id, url, listing_status, _board_key in chunk:
                result = results.get(url)
                if result is None:
                    deferred += 1
                    deferred_reasons["deadline"] += 1
                    continue
                if platform_liveness.is_deferred(result):
                    # No answer came back: not a probe, the row keeps its place.
                    deferred += 1
                    deferred_reasons[result.reason] += 1
                    continue
                family = host_family(url)
                combos[(result.verdict, result.reason, family)] += 1
                before = len(recorder.writes)
                listing_freshness.record_liveness(session, row_id, listing_status, result, now=now)
                values = recorder.writes[before].values if len(recorder.writes) > before else {}
                if values.get("listing_status") == LISTING_REMOVED:
                    outcome = "removed"
                    report.hide([row_id], "c:dead")
                    bucket = dead_buckets.setdefault(_board_of(url), [])
                    if len(bucket) < DEAD_SAMPLES:
                        bucket.append((url, result.reason))
                elif "last_seen_at" in values:
                    outcome = "revived" if values.get("listing_status") == LISTING_ACTIVE else "confirmed"
                else:
                    outcome = "unverified"
                    if result.verdict == platform_liveness.UNKNOWN:
                        report.unknown_by_host[host_of(url) or "(no host)"] += 1
                        report.unknown_by_family[family] += 1
                    else:  # a page that looked open, never proof (LinkedIn's CTA)
                        report.weak_alive_by_family[family] += 1
                outcomes[outcome] += 1
                if result.verdict == platform_liveness.ALIVE:
                    bucket = alive_buckets.setdefault(_board_of(url), [])
                    if len(bucket) < ALIVE_SAMPLES:
                        bucket.append((url, result.reason, result.authoritative))
            session.commit()
            done = min((index + 1) * CHUNK, len(rows))
            print(f"      {done}/{len(rows)} checked in {time.monotonic() - started:.0f}s: "
                  f"{dict(outcomes)}")

    dead_samples = _spread(dead_buckets, DEAD_SAMPLES)
    alive_samples = _spread(alive_buckets, ALIVE_SAMPLES)
    checked = sum(outcomes.values())
    stats = {
        "eligible": eligible, "selected": len(rows), "checked": checked,
        "deferred": deferred, "deferred_reasons": dict(deferred_reasons),
        "outcomes": dict(outcomes),
        "seconds": round(time.monotonic() - started, 1),
    }
    verb = "" if write else "would be "
    print(f"  [c] {checked} checked, {deferred} deferred {dict(deferred_reasons)}: "
          f"{outcomes['removed']} {verb}removed, {outcomes['confirmed']} {verb}confirmed, "
          f"{outcomes['revived']} {verb}revived, {outcomes['unverified']} unverified "
          f"({stats['seconds']}s)")
    print("  [c] verdict x reason x host family:")
    for (verdict, reason, family), count in sorted(combos.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"      {count:6d}  {verdict:<7} {reason:<26} {family}")
    print(f"  [c] dead samples ({len(dead_samples)}):")
    for url, reason in dead_samples:
        print(f"      {reason:<24} {url[:150]}")
    print(f"  [c] alive samples ({len(alive_samples)}):")
    for url, reason, authoritative in alive_samples:
        tag = "authoritative" if authoritative else "weak"
        print(f"      {reason:<24} {tag:<13} {url[:150]}")

    # With --limit, project the rest of the pool at the measured dead rate
    # (meaningful with --sample; a least-recently-probed slice is biased).
    unchecked = eligible - checked
    if checked and unchecked > 0:
        rate = outcomes["removed"] / checked
        stats["dead_rate"] = round(rate, 4)
        stats["extrapolated_dead"] = round(rate * unchecked)
        print(f"  [c] dead rate {rate:.1%} over {checked} checked; "
              f"{unchecked} eligible rows unchecked -> ~{stats['extrapolated_dead']} more dead "
              f"if the rate holds")
    stats["combos"] = {"|".join(key): count for key, count in combos.items()}
    stats["dead_samples"] = dead_samples
    stats["alive_samples"] = alive_samples
    return stats


# ─── Phase d: what stays unverifiable ────────────────────────────────────────

def phase_d(report: Report) -> dict:
    if not report.phase_c or "checked" not in report.phase_c:
        print("  [d] needs phase c in the same run; nothing to report")
        return {}
    total = sum(report.unknown_by_host.values())
    print(f"  [d] {total} checked rows stay visible with verdict 'unknown', by host family:")
    for family, count in report.unknown_by_family.most_common():
        print(f"      {count:6d}  {family}")
    print(f"  [d] top {UNKNOWN_HOSTS_SHOWN} hosts:")
    for host, count in report.unknown_by_host.most_common(UNKNOWN_HOSTS_SHOWN):
        print(f"      {count:6d}  {host}")
    weak = sum(report.weak_alive_by_family.values())
    if weak:
        print(f"  [d] plus {weak} that looked open but not by the platform's own API "
              f"(stay visible, age-out rules apply): {dict(report.weak_alive_by_family)}")
    return {"unknown_total": total,
            "by_family": dict(report.unknown_by_family),
            "top_hosts": report.unknown_by_host.most_common(UNKNOWN_HOSTS_SHOWN),
            "weak_alive_by_family": dict(report.weak_alive_by_family)}


# ─── Driver ──────────────────────────────────────────────────────────────────

async def run(db: Session, *, write: bool, phases: str = PHASES,
              options: ProbeOptions | None = None,
              now: datetime.datetime | None = None) -> Report:
    """Run the selected phases against ``db``. ``write=False`` records and
    reports only. Returns the Report (tests assert on it)."""
    options = options or ProbeOptions()
    now = now or _utcnow()
    report = Report(dry_run=not write)
    if not write:
        assert_database_read_only(db)

    report.visible_start = visible_ids(db)
    mode = "APPLY" if write else "DRY RUN (no writes)"
    print(f"== cleanup_feed {mode} at {now:%Y-%m-%d %H:%M}Z, phases {phases}: "
          f"{len(report.visible_start)} visible rows ==")

    if "a" in phases:
        print("== phase a: github data fixes ==")
        report.phase_a = phase_a(db, report, write=write)
    if "b" in phases:
        print("== phase b: lifecycle sweeps (listing_freshness) ==")
        report.phase_b = phase_b(db, report, write=write, now=now)
    after_ab = report.visible_after
    if "c" in phases:
        print("== phase c: platform liveness ==")
        report.phase_c = await phase_c(db, report, options, write=write, now=now)
    after_c = report.visible_after
    if "b" in phases:
        # After the checks, as cron-freshness runs it: terminal expiry only
        # ends rows a check has reached since their last positive evidence.
        print("== phase b (last step): terminal expiry ==")
        report.phase_b.update(phase_terminal(db, report, write=write, now=now))
    if "d" in phases:
        print("== phase d: unverifiable rows still visible ==")
        phase_d(report)

    print("== projection ==" if not write else "== result ==")
    print(f"  visible at start:         {len(report.visible_start)}")
    print(f"  after phases a+b:         {after_ab}")
    print(f"  after phase c (measured): {after_c}")
    print(f"  after terminal expiry:    {report.visible_after}")
    extra = report.phase_c.get("extrapolated_dead") if report.phase_c else None
    if extra:
        print(f"  after phase c (whole pool at the measured dead rate): "
              f"~{after_c - extra}")
    by_phase = Counter(why for why in report.hidden.values())
    print(f"  hidden by: {dict(by_phase)}")
    if write:
        print(f"  visible now (re-counted): {len(visible_ids(db))}")
    return report


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="One-time job feed cleanup (dry run by default).")
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    parser.add_argument("--phase", default=PHASES,
                        help="phases to run, e.g. 'a,b' or 'c' (default: all of a,b,c,d)")
    parser.add_argument("--limit", type=int, default=None, help="phase c: check at most N rows")
    parser.add_argument("--sample", action="store_true",
                        help="phase c: random subset instead of least-recently-probed first")
    parser.add_argument("--seed", type=int, default=7, help="phase c: --sample seed")
    parser.add_argument("--host-filter", default="",
                        help="phase c: only rows whose URL host contains this")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--deadline-minutes", type=float, default=90.0,
                        help="phase c: stop starting checks after this long")
    parser.add_argument("--recheck-hours", type=float, default=0.0,
                        help="phase c: skip rows probed within this many hours (resume)")
    parser.add_argument("--no-migrate", action="store_true",
                        help="--apply without running the idempotent DDL migrations")
    args = parser.parse_args(argv)
    phases = "".join(p for p in args.phase.lower() if p in PHASES)
    if not phases:
        parser.error(f"--phase must name some of {','.join(PHASES)}")
    args.phase = phases
    return args


def main(argv=None) -> int:
    args = _parse_args(argv)
    if not _DATABASE_URL:
        sys.exit("DATABASE_URL is required (set it in the environment, never from a .env)")

    from backend.db import database

    write = args.apply
    if write:
        if not args.no_migrate:
            # Idempotent DDL: record_liveness stamps last_probed_at.
            from backend.migrations.add_listing_probe_columns import run_migration
            run_migration()
    else:
        # --no-migrate is implied: a dry run never gets past the guard.
        install_read_only_guard(database.engine)

    options = ProbeOptions(
        limit=args.limit, sample=args.sample, seed=args.seed,
        host_filter=args.host_filter.strip(), concurrency=max(1, args.concurrency),
        deadline_minutes=args.deadline_minutes, recheck_hours=args.recheck_hours,
    )
    db = database.SessionLocal()
    try:
        asyncio.run(run(db, write=write, phases=args.phase, options=options))
    finally:
        if not write:
            db.rollback()
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
