"""Backfill cron: bounded description retries + location/domain repair."""

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob

SECRET = "test-cron-secret"


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
