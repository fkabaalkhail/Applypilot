"""Backfill cron: bounded description retries + location/domain repair."""

import pytest

import backend.auth.dependencies as auth_deps
import backend.services.logo_harvester as logo_harvester
from backend.db.models import ScrapedJob

SECRET = "test-cron-secret"


@pytest.fixture(autouse=True)
def _no_network_harvest(monkeypatch):
    """The logo-harvest phase must never hit real homepages/Wikidata in tests."""
    async def fake_harvest(client, domain, company, linkedin_job_url=""):
        return ""
    monkeypatch.setattr(logo_harvester, "harvest_logo", fake_harvest)


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


def test_backfill_harvests_real_logo_and_marks_probed(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-logo-1")
    row.company_domain = "kinaxis.com"
    row.company_logo = "https://www.google.com/s2/favicons?domain=kinaxis.com&sz=128"
    other = _mk(db_session, "https://x.test/backfill-logo-2", company="NoLogo Corp")
    other.company_domain = "nologo.example"
    other.company_logo = ""
    db_session.commit()

    async def fake_extract(client_, url):
        return ""

    async def fake_harvest(client_, domain, company, linkedin_job_url=""):
        return "https://cdn.example.com/real-logo.png" if domain == "kinaxis.com" else ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    import backend.services.logo_harvester as lh
    monkeypatch.setattr(lh, "harvest_logo", fake_harvest)

    res = client.post("/jobs/cron-backfill", headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["logos_harvested"] == 1
    db_session.refresh(row)
    db_session.refresh(other)
    assert row.company_logo == "https://cdn.example.com/real-logo.png"
    # Failed harvest leaves the sz=256 sentinel so the domain is never re-probed.
    assert "sz=256" in other.company_logo
