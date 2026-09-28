"""Backfill cron: bounded description retries + location/domain repair +
the self-hosted logo harvest (Phase 3)."""

import asyncio
import datetime
import hashlib
from dataclasses import dataclass, field
from typing import NamedTuple

import pytest

import backend.auth.dependencies as auth_deps
import backend.services.logo_harvester as logo_harvester
from backend.data import company_registry
from backend.db.models import CompanyLogo, ScrapedJob
from backend.services import logo_cache

SECRET = "test-cron-secret"
S2 = "https://www.google.com/s2/favicons?domain={}&sz=256"
LICDN = ("https://media.licdn.com/dms/image/v2/C4D0BAQE/company-logo_100_100/"
         "company-logo_100_100/0/1/kinaxis_logo?e=2147483647&v=beta&t=abc")


@dataclass
class FakeHints:
    """Mirror of the logo_harvester.LogoHints contract."""
    company: str
    domains: list = field(default_factory=list)
    job_urls: list = field(default_factory=list)
    existing_logo_urls: list = field(default_factory=list)


class FakeLogo(NamedTuple):
    data: bytes
    sha: str
    fmt: str
    width: int
    height: int


@dataclass
class FakeResult:
    logo: FakeLogo
    source: str = "linkedin"
    source_url: str = ""
    verified_domain: str | None = None


def _fake_logo(seed=b"k"):
    data = b"\x89PNG\r\n\x1a\n" + seed * 40
    return FakeLogo(data, hashlib.sha1(data).hexdigest(), "png", 128, 128)


@pytest.fixture(autouse=True)
def _no_network_harvest(monkeypatch):
    """The logo-harvest phase must never hit the network in tests."""
    async def fake_harvest(client, hints):
        return None

    async def never_bogus(client, domain):
        return False

    monkeypatch.setattr(logo_harvester, "LogoHints", FakeHints, raising=False)
    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)
    monkeypatch.setattr(logo_cache, "domain_is_bogus", never_bogus)
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})


def _cron_headers(monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def _mk(db_session, url, description="", attempts=0, location="Ottawa, ON, CA",
        location_search="", company="Kinaxis"):
    row = ScrapedJob(
        title="Engineer", company=company, url=url, location=location,
        description=description, country="CA", work_type="onsite",
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0, desc_fetch_attempts=attempts,
        location_search=location_search,
    )
    db_session.add(row)
    db_session.commit()
    return row


async def _no_description(client_, url):
    return ""


def test_backfill_fetches_description_and_repairs_row(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-1")

    async def fake_extract(client_, url):
        return "A long and detailed description of the role " * 5

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    res = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["descriptions_fixed"] >= 1
    db_session.refresh(row)
    assert len(row.description) > 100
    assert row.desc_fetch_attempts == 1
    assert "|ottawa|" in row.location_search
    assert row.company_domain == "kinaxis.com"


def test_backfill_skips_rows_at_attempt_cap(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-2", attempts=3)
    called = {"n": 0}

    async def fake_extract(client_, url):
        called["n"] += 1
        return ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    db_session.refresh(row)
    assert row.desc_fetch_attempts == 3
    assert called["n"] == 0


def test_backfill_increments_attempts_on_failure(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-3")

    async def fake_extract(client_, url):
        return ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    db_session.refresh(row)
    assert row.desc_fetch_attempts == 1
    assert (row.description or "") == ""


def test_backfill_prioritizes_direct_urls_over_linkedin(client, db_session, monkeypatch):
    # The LinkedIn row is NEWER but the direct row must get the batch slot.
    direct = _mk(db_session, "https://boards.greenhouse.io/acme/jobs/9")
    linkedin = _mk(db_session, "https://www.linkedin.com/jobs/view/999999")

    async def fake_extract(client_, url):
        return ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    client.post("/jobs/cron-backfill", params={"batch_size": 1}, headers=_cron_headers(monkeypatch))
    db_session.refresh(direct)
    db_session.refresh(linkedin)
    assert direct.desc_fetch_attempts == 1
    assert (linkedin.desc_fetch_attempts or 0) == 0


# --- Phase 3: self-hosted logos ------------------------------------------------

def test_backfill_harvests_stores_and_propagates(client, db_session, monkeypatch):
    rows = [_mk(db_session, f"https://boards.greenhouse.io/kinaxis/jobs/{i}") for i in range(3)]
    for row in rows:
        row.company_domain = "kinaxis.com"
        row.company_logo = S2.format("kinaxis.com")
    # A hidden LinkedIn twin still donates its posting URL and real logo.
    twin = _mk(db_session, "https://www.linkedin.com/jobs/view/4417990546",
               company="Kinaxis Inc.")
    twin.company_logo = LICDN
    twin.duplicate_of = rows[0].id
    db_session.commit()

    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {
        "kinaxis": "https://www.google.com/s2/favicons?domain=kinaxis.com&sz=128",
    })
    seen = {}

    async def fake_harvest(client_, hints):
        seen[hints.company] = hints
        return FakeResult(_fake_logo(), verified_domain="kinaxis.com")

    monkeypatch.setattr("backend.routers.jobs.extract_description_from_url", _no_description)
    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)

    res = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["logos_harvested"] == 1
    assert body["logo_domains_probed"] == 1
    assert body["logo_harvest"]["stored"] == 1

    hints = seen["Kinaxis"]
    assert hints.domains[0] == "kinaxis.com"
    assert hints.job_urls[0] == twin.url  # LinkedIn postings first, hidden ones included
    assert "https://boards.greenhouse.io/kinaxis/jobs/2" in hints.job_urls
    assert hints.existing_logo_urls == [LICDN]

    path = logo_cache.lookup_logo(db_session, "Kinaxis")
    db_session.expire_all()
    for row in rows:
        assert db_session.get(ScrapedJob, row.id).company_logo == path
    assert db_session.get(ScrapedJob, twin.id).company_logo == LICDN  # trusted, kept


def test_backfill_miss_backs_off_and_clears_bogus_domain(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/nologo-1", company="NoLogo Corp")
    row.company_domain = "nologo.com"  # the name guess
    row.company_logo = S2.format("nologo.com")
    db_session.commit()
    calls = []

    async def fake_harvest(client_, hints):
        calls.append(hints.company)
        return None

    async def bogus(client_, domain):
        return domain == "nologo.com"

    monkeypatch.setattr("backend.routers.jobs.extract_description_from_url", _no_description)
    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)
    monkeypatch.setattr(logo_cache, "domain_is_bogus", bogus)

    body = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch)).json()
    assert body["logo_harvest"]["missed"] == 1
    assert body["logo_harvest"]["domains_rejected"] == 1
    db_session.expire_all()
    stored = db_session.get(ScrapedJob, row.id)
    assert stored.company_domain == ""
    assert stored.company_logo == ""
    record = db_session.query(CompanyLogo).filter_by(company_key="nologo").one()
    assert record.status == "miss" and record.attempts == 1
    assert record.next_retry_at > datetime.datetime.utcnow() + datetime.timedelta(days=13)

    # Not due yet: the next run leaves it alone, and the description phase's
    # domain repair must not plant the bogus guess again.
    body = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch)).json()
    assert calls == ["NoLogo Corp"]
    assert body["logo_harvest"]["companies_considered"] == 0
    db_session.expire_all()
    assert db_session.get(ScrapedJob, row.id).company_domain == ""


def test_backfill_retries_a_due_miss(client, db_session, monkeypatch):
    _mk(db_session, "https://x.test/due-1", company="Retry Me")
    db_session.add(CompanyLogo(
        company_key="retry me", status="miss", attempts=2,
        next_retry_at=datetime.datetime.utcnow() - datetime.timedelta(hours=1),
    ))
    db_session.commit()
    calls = []

    async def fake_harvest(client_, hints):
        calls.append(hints.company)
        return None

    monkeypatch.setattr("backend.routers.jobs.extract_description_from_url", _no_description)
    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)
    client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    assert calls == ["Retry Me"]
    db_session.expire_all()
    assert db_session.query(CompanyLogo).filter_by(company_key="retry me").one().attempts == 3


def test_backfill_repoints_rows_planted_after_a_store(client, db_session, monkeypatch):
    first = _mk(db_session, "https://x.test/kx-1")
    logo_cache.store_logo(db_session, "Kinaxis", FakeResult(_fake_logo()))
    planted = _mk(db_session, "https://x.test/kx-2")
    planted.company_logo = "https://www.kinaxis.com/og/share.jpg"
    db_session.commit()
    calls = []

    async def fake_harvest(client_, hints):
        calls.append(hints.company)
        return None

    monkeypatch.setattr("backend.routers.jobs.extract_description_from_url", _no_description)
    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)
    body = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch)).json()
    assert body["logo_harvest"]["repropagated_rows"] == 1
    assert calls == []  # already stored, never re-harvested
    db_session.expire_all()
    path = logo_cache.lookup_logo(db_session, "Kinaxis")
    assert db_session.get(ScrapedJob, first.id).company_logo == path
    assert db_session.get(ScrapedJob, planted.id).company_logo == path


def test_harvest_respects_the_wall_clock_budget(db_session, monkeypatch):
    _mk(db_session, "https://x.test/budget-1", company="Late Co")
    calls = []

    async def fake_harvest(client_, hints):
        calls.append(hints.company)
        return None

    monkeypatch.setattr(logo_harvester, "harvest_company_logo", fake_harvest, raising=False)
    stats = asyncio.run(logo_cache.harvest_missing_logos(db_session, None, budget_s=0))
    assert stats["skipped_budget"] == 1
    assert calls == []
    # Skipped is not a miss: nothing recorded, so the next run tries it.
    assert db_session.query(CompanyLogo).count() == 0


def test_backfill_without_the_harvester_contract_still_succeeds(client, db_session, monkeypatch):
    _mk(db_session, "https://x.test/nh-1")
    monkeypatch.delattr(logo_harvester, "harvest_company_logo", raising=False)
    monkeypatch.setattr("backend.routers.jobs.extract_description_from_url", _no_description)
    res = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    assert res.json()["logo_harvest"]["harvester_available"] is False
