"""
Tests for POST /jobs/ingest-batch, the batched, authenticated ingest path
for the JobSpy/LinkedIn scraper scripts (plan §4).

This file previously targeted /api/extension/jobs/save-batch, an endpoint
that no longer exists; the scenarios (empty batch, DB duplicates,
within-batch duplicates, missing URLs) carry over to the new endpoint.

Contract:
- auth via cron secret (x-cron-secret header), NOT user JWT
- ONE dedup query per batch (SELECT url WHERE url IN ...), never per job
- bulk insert of the non-duplicate rows
"""

import pytest

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob

SECRET = "test-cron-secret"


@pytest.fixture
def cron_headers(monkeypatch):
    """Pin the cron secret so tests don't depend on the local environment."""
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def _job(url, title="Software Intern", company="Test Co", **extra):
    payload = {
        "title": title,
        "company": company,
        "url": url,
        "location": "Ottawa, ON",
    }
    payload.update(extra)
    return payload


def test_rejects_missing_secret(client, monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    resp = client.post("/jobs/ingest-batch", json={"jobs": []})
    assert resp.status_code == 403


def test_rejects_wrong_secret(client, monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    resp = client.post(
        "/jobs/ingest-batch",
        json={"jobs": []},
        headers={"x-cron-secret": "nope"},
    )
    assert resp.status_code == 403


def test_empty_batch(client, cron_headers):
    resp = client.post("/jobs/ingest-batch", json={"jobs": []}, headers=cron_headers)
    assert resp.status_code == 200
    assert resp.json() == {"received": 0, "created": 0, "duplicates": 0, "skipped": 0}


def test_all_new_jobs_are_created(client, cron_headers, db_session):
    jobs = [_job(f"https://ca.indeed.com/viewjob?jk={i}") for i in range(1, 4)]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"received": 3, "created": 3, "duplicates": 0, "skipped": 0}
    assert db_session.query(ScrapedJob).count() == 3


def test_all_duplicates_against_db(client, cron_headers, db_session):
    for i in range(1, 4):
        db_session.add(
            ScrapedJob(
                title="Existing",
                company="Co",
                url=f"https://ca.indeed.com/viewjob?jk={i}",
                location="",
            )
        )
    db_session.commit()

    jobs = [_job(f"https://ca.indeed.com/viewjob?jk={i}") for i in range(1, 4)]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["created"] == 0
    assert data["duplicates"] == 3
    assert db_session.query(ScrapedJob).count() == 3


def test_mixed_batch(client, cron_headers, db_session):
    db_session.add(
        ScrapedJob(title="Existing", company="Co", url="https://x.test/1", location="")
    )
    db_session.commit()

    jobs = [_job("https://x.test/1"), _job("https://x.test/2"), _job("https://x.test/3")]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    data = resp.json()
    assert data == {"received": 3, "created": 2, "duplicates": 1, "skipped": 0}


def test_within_batch_duplicates(client, cron_headers, db_session):
    jobs = [_job("https://x.test/1"), _job("https://x.test/1"), _job("https://x.test/2")]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    data = resp.json()
    assert data == {"received": 3, "created": 2, "duplicates": 1, "skipped": 0}
    assert db_session.query(ScrapedJob).count() == 2


def test_jobs_without_url_are_skipped(client, cron_headers, db_session):
    jobs = [_job(""), _job("https://x.test/1")]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    data = resp.json()
    assert data == {"received": 2, "created": 1, "duplicates": 0, "skipped": 1}
    assert db_session.query(ScrapedJob).count() == 1


def test_row_fields_and_defaults(client, cron_headers, db_session):
    jobs = [
        _job(
            "https://x.test/full",
            title="Data Science Intern",
            company="Acme Widgets",
            source_platform="indeed",
            experience_level="internship",
            work_type="remote",
            country="US",
            posted_date="2026-07-10",
        ),
        _job("https://x.test/defaults", title="New Grad Software Engineer"),
    ]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    assert resp.json()["created"] == 2

    full = db_session.query(ScrapedJob).filter_by(url="https://x.test/full").one()
    assert full.title == "Data Science Intern"
    assert full.source_platform == "indeed"
    assert full.experience_level == "internship"
    assert full.work_type == "remote"
    assert full.country == "US"
    assert full.posted_date is not None and full.posted_date.year == 2026
    assert full.role_category  # classified from the title, not left blank
    assert "acmewidgets.com" in (full.company_logo or "")

    defaults = db_session.query(ScrapedJob).filter_by(url="https://x.test/defaults").one()
    assert defaults.source_platform == "linkedin"
    assert defaults.experience_level == "new_grad"
    assert defaults.work_type == "onsite"
    assert defaults.country == "CA"
    assert defaults.posted_date is None


def test_bad_posted_date_is_ignored(client, cron_headers, db_session):
    jobs = [_job("https://x.test/1", posted_date="not-a-date")]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    assert resp.json()["created"] == 1
    row = db_session.query(ScrapedJob).one()
    assert row.posted_date is None


def test_oversized_batch_rejected(client, cron_headers):
    jobs = [_job(f"https://x.test/{i}") for i in range(501)]
    resp = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=cron_headers)
    assert resp.status_code == 422
