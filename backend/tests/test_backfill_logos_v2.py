"""The one-time logo backfill script: work-list selection, the dry run's
write-free guarantee (it is meant to run against production), and --apply.
The harvest itself is faked; no network."""

import asyncio
import hashlib
import time
from dataclasses import dataclass
from typing import NamedTuple

import httpx
import pytest
from sqlalchemy import event, text

from backend.data import company_registry
from backend.db.models import CompanyLogo, ScrapedJob
from backend.migrations import add_company_logos
from backend.scripts import backfill_logos_v2 as script
from backend.services import logo_cache
from backend.services import logo_harvester as lh

S2 = "https://www.google.com/s2/favicons?domain={}&sz=256"
LICDN = ("https://media.licdn.com/dms/image/v2/C4D0BAQE/company-logo_100_100/"
         "company-logo_100_100/0/1/magna_logo?e=2147483647&v=beta&t=abc")


class FakeLogo(NamedTuple):
    data: bytes
    sha: str
    fmt: str
    width: int
    height: int


@dataclass
class FakeResult:
    logo: FakeLogo
    source: str
    source_url: str = ""
    verified_domain: str | None = None


def _logo(seed: bytes) -> FakeLogo:
    data = b"\x89PNG\r\n\x1a\n" + seed * 40
    return FakeLogo(data, hashlib.sha1(data).hexdigest(), "png", 128, 128)


def _row(db, url, company, logo="", domain="", listing_status="active"):
    row = ScrapedJob(
        title="Software Engineer Intern", company=company, url=url,
        location="Toronto, ON, CA", description="", country="CA", work_type="onsite",
        source_platform="ats", experience_level="internship", easy_apply=0,
        match_score=0, company_logo=logo, company_domain=domain,
        listing_status=listing_status,
    )
    db.add(row)
    db.commit()
    return row


@pytest.fixture
def catalogue(db_session, monkeypatch):
    """Magna (3 rows, favicon only) whose longer name has a LinkedIn logo,
    Kinaxis (stored, plus one row planted after the store), No Logo Co (a
    miss whose guessed domain is bogus) and Slow Co (times out)."""
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {"Magna": S2.format("magna.com")})
    for i in range(3):
        _row(db_session, f"https://magna.wd3.myworkdayjobs.com/Magna/job/{i}", "Magna",
             S2.format("magna.com"), "magna.com")
    _row(db_session, "https://x.test/mi", "Magna International", LICDN, listing_status="expired")
    _row(db_session, "https://x.test/kx-1", "Kinaxis")
    logo_cache.store_logo(db_session, "Kinaxis", FakeResult(_logo(b"k"), "linkedin_job"))
    _row(db_session, "https://x.test/kx-2", "Kinaxis", "https://www.kinaxis.com/og/share.jpg")
    for i in range(2):
        _row(db_session, f"https://x.test/nl-{i}", "No Logo Co", S2.format("nologo.com"), "nologo.com")
    _row(db_session, "https://x.test/slow", "Slow Co")

    async def bogus(client, domain):
        return domain == "nologo.com"

    monkeypatch.setattr(logo_cache, "domain_is_bogus", bogus)
    return db_session


def _harvest(seen: list):
    async def harvest(client, hints):
        seen.append(hints)
        if hints.company == "Magna":
            assert hints.existing_logo_urls == [LICDN]  # the Phase 3 hints, alias seed included
            return FakeResult(_logo(b"m"), "existing", LICDN)
        if hints.company == "Slow Co":
            await asyncio.sleep(5)
        return None
    return harvest


def _snapshot(db):
    db.expire_all()
    rows = db.query(ScrapedJob.id, ScrapedJob.company_logo, ScrapedJob.company_domain).order_by(ScrapedJob.id).all()
    logos = db.query(CompanyLogo.company_key, CompanyLogo.status, CompanyLogo.attempts,
                     CompanyLogo.sha).order_by(CompanyLogo.company_key).all()
    return [tuple(r) for r in rows], [tuple(r) for r in logos]


def _run(db, argv, harvest, lines=None):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404))) as client:
            return await script.run(script.parse_args(argv), db.get_bind(), harvest=harvest,
                                    client=client, out=(lines if lines is not None else []).append)
    return asyncio.run(go())


# --- dry run -------------------------------------------------------------------------

def test_dry_run_writes_nothing(catalogue, monkeypatch):
    db = catalogue

    def no_migrations(*a, **k):
        raise AssertionError("a dry run must not run migrations")

    monkeypatch.setattr(add_company_logos, "run_migration", no_migrations)
    statements: list[str] = []

    def spy(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = db.get_bind()
    before = _snapshot(db)
    event.listen(engine, "before_cursor_execute", spy)
    try:
        seen: list = []
        lines: list[str] = []
        report = _run(db, ["--timeout", "0.2"], _harvest(seen), lines)
    finally:
        event.remove(engine, "before_cursor_execute", spy)

    assert _snapshot(db) == before
    heads = {s.lstrip().split(None, 1)[0].upper() for s in statements}
    assert heads <= {"SELECT", "PRAGMA"}
    # PRAGMA only for the table probe that runs before the guard is armed
    assert all("table" in s.lower() for s in statements if s.lstrip().upper().startswith("PRAGMA"))
    assert report["dry_run"] is True
    assert report["stats"]["repropagated_rows"] == 1  # the planted Kinaxis row, counted only
    assert [h.company for h in seen] == ["Magna", "No Logo Co", "Slow Co"]
    by_status = {o.plan.display: o.status for o in report["outcomes"]}
    assert by_status == {"Magna": "ok", "No Logo Co": "miss", "Slow Co": "timeout"}
    assert report["sources"]["existing"] == [1, 3]
    assert report["sources"]["miss"] == [1, 2]
    # Projected: Magna's 3 rows and the planted Kinaxis row move to self-hosted.
    assert (report["before"]["self_hosted"], report["before"]["none"]) == (1, 7)
    assert (report["after"]["self_hosted"], report["after"]["none"]) == (5, 3)
    text_out = "\n".join(lines)
    assert "DRY RUN" in text_out and "would be re-pointed" in text_out
    assert "Magna <- magna international" in text_out
    assert "No Logo Co  bogus: nologo.com" in text_out


def test_dry_run_without_the_logo_table(catalogue, monkeypatch):
    """Production before the deploy: company_logos does not exist yet."""
    db = catalogue
    engine = db.get_bind()
    CompanyLogo.__table__.drop(engine)
    seen: list = []
    report = _run(db, ["--timeout", "0.2", "--company", "Magna"], _harvest(seen))
    assert [h.company for h in seen] == ["Magna"]
    assert report["stats"]["repropagated_rows"] == 0
    assert report["after"]["self_hosted"] == report["before"]["self_hosted"] + 3
    # still nothing written
    assert db.execute(text("SELECT count(*) FROM scraped_jobs WHERE company_logo LIKE '/jobs/logo/%'")).scalar() == 1


def test_read_only_guard_refuses_writes(db_session):
    engine = db_session.get_bind()
    with script.read_only(engine):
        with engine.connect() as conn:
            assert conn.execute(text("SELECT count(*) FROM scraped_jobs")).scalar() == 0
            with pytest.raises(script.ReadOnlyViolation):
                conn.execute(text("UPDATE scraped_jobs SET company = 'x'"))
            with pytest.raises(script.ReadOnlyViolation):
                conn.execute(text("DELETE FROM company_logos"))
            with pytest.raises(script.ReadOnlyViolation):
                conn.execute(text("CREATE TABLE sneaky (id INTEGER)"))
    assert not event.contains(engine, "before_cursor_execute", script._refuse_writes)
    session = script.ReadOnlySession(bind=engine)
    with pytest.raises(script.ReadOnlyViolation):
        session.commit()
    session.add(CompanyLogo(company_key="x", status="miss"))
    with pytest.raises(script.ReadOnlyViolation):
        session.flush()
    session.close()


# --- work list ---------------------------------------------------------------------------

def test_work_list_selection(catalogue):
    db = catalogue
    logo_cache.record_miss(db, "No Logo Co")  # backoff not due yet
    seen: list = []
    _run(db, ["--timeout", "0.2"], _harvest(seen))
    assert [h.company for h in seen] == ["Magna", "Slow Co"]  # busiest first; Kinaxis is stored

    seen.clear()
    _run(db, ["--timeout", "0.2", "--retry-misses"], _harvest(seen))
    assert [h.company for h in seen] == ["Magna", "No Logo Co", "Slow Co"]

    seen.clear()
    _run(db, ["--timeout", "0.2", "--retry-misses", "--limit", "2"], _harvest(seen))
    assert [h.company for h in seen] == ["Magna", "No Logo Co"]

    seen.clear()
    _run(db, ["--timeout", "0.2", "--company", "slow co", "--company", "Kinaxis"], _harvest(seen))
    assert [h.company for h in seen] == ["Slow Co"]


# --- apply -----------------------------------------------------------------------------

def test_apply_stores_propagates_and_records(catalogue):
    db = catalogue
    lines: list[str] = []
    report = _run(db, ["--apply", "--timeout", "0.2"], _harvest([]), lines)
    db.expire_all()
    stats = report["stats"]
    assert stats["repropagated_rows"] == 1
    assert stats["stored"] == 1 and stats["missed"] == 1 and stats["timeouts"] == 1
    path = logo_cache.lookup_logo(db, "Magna")
    assert path and path.startswith("/jobs/logo/")
    assert {r.company_logo for r in db.query(ScrapedJob.company_logo).filter(ScrapedJob.company == "Magna")} == {path}
    record = db.query(CompanyLogo).filter_by(company_key="magna").one()
    assert record.source == "existing" and record.source_url == LICDN
    miss = db.query(CompanyLogo).filter_by(company_key="no logo").one()
    assert miss.status == "miss" and miss.rejected_domains == ["nologo.com"]
    assert {r.company_domain for r in db.query(ScrapedJob.company_domain).filter(ScrapedJob.company == "No Logo Co")} == {""}
    # A timeout is not a miss: the next run tries Slow Co again.
    assert db.query(CompanyLogo).filter_by(company_key="slow").count() == 0
    assert report["after"]["self_hosted"] == 5
    assert "APPLY" in "\n".join(lines)

    # Idempotent: a second run only has Slow Co left.
    seen: list = []
    _run(db, ["--apply", "--timeout", "0.2"], _harvest(seen))
    assert [h.company for h in seen] == ["Slow Co"]


def _blocking_harvest(source: str):
    """LinkedIn is given up on as soon as the harvest starts."""
    async def harvest(client, hints):
        gate = lh._linkedin_gates.get(client)
        if gate is None:
            gate = lh._linkedin_gates[client] = lh._LinkedInGate()
        if not gate.blocked:
            gate.blocked, gate.blocked_at = True, time.monotonic()
        if hints.company == "Magna":
            return FakeResult(_logo(b"m"), source, LICDN)
        return None
    return harvest


@pytest.mark.parametrize("source,stored", [("ats_workday", False), ("linkedin_search", True)])
def test_linkedin_giving_up_stops_the_run_and_stores_nothing_degraded(catalogue, source, stored):
    db = catalogue
    lines: list[str] = []
    report = _run(db, ["--apply", "--timeout", "0.2", "--concurrency", "1"],
                  _blocking_harvest(source), lines)
    statuses = {o.plan.display: o.status for o in report["outcomes"]}
    assert statuses["No Logo Co"] == "deferred" and statuses["Slow Co"] == "deferred"
    assert statuses["Magna"] == ("ok" if stored else "deferred")
    db.expire_all()
    assert (logo_cache.lookup_logo(db, "Magna") is not None) is stored
    # deferred misses are not recorded either: the next run retries them
    assert db.query(CompanyLogo).filter_by(company_key="no logo").count() == 0
    assert "LinkedIn stopped answering" in "\n".join(lines)


def test_apply_can_skip_migrations(catalogue, monkeypatch):
    called = []
    monkeypatch.setattr(add_company_logos, "run_migration", lambda engine=None: called.append(engine))
    _run(catalogue, ["--apply", "--no-migrate", "--company", "Magna"], _harvest([]))
    assert called == []
    _run(catalogue, ["--apply", "--company", "Magna", "--retry-misses"], _harvest([]))
    assert len(called) == 1
