"""Ingest paths must populate structured location fields and never guess
icon.horse domains."""

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob

SECRET = "test-cron-secret"


def _cron_headers(monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def test_ingest_batch_populates_location_fields(client, db_session, monkeypatch):
    payload = {"jobs": [{
        "title": "Software Intern",
        "company": "Kinaxis",
        "location": "Ottawa, ON, CA",
        "url": "https://example.com/jobs/ottawa-1",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/ottawa-1")
        .one()
    )
    assert row.city == "ottawa"
    assert row.region == "ON"
    assert "|ottawa|" in row.location_search
    assert row.locations_json[0]["city"] == "Ottawa"
    assert "icon.horse" not in (row.company_logo or "")
    assert row.company_domain == "kinaxis.com"


def test_ingest_batch_multi_location_blob(client, db_session, monkeypatch):
    payload = {"jobs": [{
        "title": "EPM Consultant",
        "company": "Acme",
        "location": "Ottawa,Ontario,Canada; Kraków,Kraków,Poland",
        "url": "https://example.com/jobs/multi-1",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "new_grad",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/multi-1")
        .one()
    )
    assert "|ottawa|" in row.location_search
    assert "|krakow|" in row.location_search
    assert len(row.locations_json) == 2
