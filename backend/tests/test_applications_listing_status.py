"""GET /jobs/applications carries the linked listing's lifecycle state, so the
Applications page can show a closed posting as closed instead of linking it."""

from backend.db.models import ApplicationRecord, ScrapedJob
from backend.tests.conftest import TEST_USER_ID


def _job(db_session, url, **fields):
    fields.setdefault("title", "Software Engineer")
    fields.setdefault("company", "Acme")
    job = ScrapedJob(url=url, description="", **fields)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _application(db_session, job_id, role, url):
    record = ApplicationRecord(user_id=TEST_USER_ID, job_id=job_id, company="Acme", role=role, url=url)
    db_session.add(record)
    db_session.commit()
    return record


def test_applications_include_the_linked_listing_status(client, db_session):
    closed = _job(db_session, "https://jobs.lever.co/acme/closed", listing_status="removed")
    live = _job(db_session, "https://jobs.lever.co/acme/live", listing_status="active")
    _application(db_session, closed.id, "Closed Role", closed.url)
    _application(db_session, live.id, "Live Role", live.url)
    _application(db_session, None, "External Role", "https://careers.example.com/1")

    resp = client.get("/jobs/applications")

    assert resp.status_code == 200
    by_role = {row["role"]: row for row in resp.json()}
    assert by_role["Closed Role"]["listing_status"] == "removed"
    assert by_role["Live Role"]["listing_status"] == "active"
    # No linked listing: nothing is known about it, so nothing is claimed.
    assert by_role["External Role"]["listing_status"] is None


def test_mark_applied_still_serializes_an_application(client, db_session):
    # ApplicationOut is built straight from the ORM record here, which has no
    # listing_status attribute: the new field must default, not fail.
    job = _job(db_session, "https://jobs.lever.co/acme/mark", listing_status="active")

    resp = client.post(f"/jobs/{job.id}/mark-applied")

    assert resp.status_code == 200
    assert resp.json()["role"] == "Software Engineer"
    assert "listing_status" in resp.json()
