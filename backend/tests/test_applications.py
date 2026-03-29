"""
Tests for the application tracking API endpoints.
"""

import datetime
import pytest
from backend.db.models import ApplicationRecord, ApplicationStatus


def _seed_applications(db_session, count=5):
    """Insert sample application records."""
    for i in range(count):
        record = ApplicationRecord(
            platform="linkedin",
            company=f"Company {i}",
            role=f"Role {i}",
            url=f"https://example.com/job/{i}",
            status=ApplicationStatus.APPLIED,
            applied_at=datetime.datetime.utcnow() - datetime.timedelta(days=i),
        )
        db_session.add(record)
    db_session.commit()


class TestListApplications:
    """Tests for GET /applications."""

    def test_list_empty(self, client):
        r = client.get("/applications")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_returns_seeded(self, client, db_session):
        _seed_applications(db_session, 3)
        r = client.get("/applications")
        assert r.status_code == 200
        assert len(r.json()) == 3

    def test_filter_by_status(self, client, db_session):
        _seed_applications(db_session, 3)
        # Update one to INTERVIEWING
        record = db_session.query(ApplicationRecord).first()
        record.status = ApplicationStatus.INTERVIEWING
        db_session.commit()

        r = client.get("/applications", params={"status": "interviewing"})
        assert r.status_code == 200
        assert len(r.json()) == 1

    def test_pagination(self, client, db_session):
        _seed_applications(db_session, 10)
        r = client.get("/applications", params={"page": 1, "page_size": 3})
        assert len(r.json()) == 3


class TestUpdateApplication:
    """Tests for PATCH /applications/{id}."""

    def test_update_status(self, client, db_session):
        _seed_applications(db_session, 1)
        record = db_session.query(ApplicationRecord).first()
        r = client.patch(
            f"/applications/{record.id}",
            json={"status": "interviewing"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "interviewing"

    def test_update_notes(self, client, db_session):
        _seed_applications(db_session, 1)
        record = db_session.query(ApplicationRecord).first()
        r = client.patch(
            f"/applications/{record.id}",
            json={"notes": "Had a great call"},
        )
        assert r.status_code == 200
        assert r.json()["notes"] == "Had a great call"

    def test_update_not_found(self, client):
        r = client.patch("/applications/999", json={"status": "applied"})
        assert r.status_code == 404


class TestApplicationStats:
    """Tests for GET /applications/stats."""

    def test_stats_empty(self, client):
        r = client.get("/applications/stats")
        assert r.status_code == 200
        data = r.json()
        assert data["total"] == 0
        assert data["this_week"] == 0

    def test_stats_with_data(self, client, db_session):
        _seed_applications(db_session, 5)
        r = client.get("/applications/stats")
        data = r.json()
        assert data["total"] == 5
        assert data["by_platform"]["linkedin"] == 5

def _seed_review_applications(db_session, count=3):
    """Insert application records with review-specific fields populated."""
    from backend.db.models import ScrapedJob, JobStatus, ConnectionRequest

    for i in range(count):
        job = ScrapedJob(
            title=f"Engineer {i}",
            company=f"Acme {i}",
            location="Ottawa, ON",
            url=f"https://linkedin.com/jobs/{i}",
            description=f"Build things at Acme {i}. 3+ years experience required.",
            experience_years_required=3,
            ats_type="easy_apply",
            status=JobStatus.APPLIED,
        )
        db_session.add(job)
        db_session.flush()

        record = ApplicationRecord(
            platform="linkedin",
            company=f"Acme {i}",
            role=f"Engineer {i}",
            url=f"https://linkedin.com/jobs/{i}",
            status=ApplicationStatus.APPLIED,
            applied_at=datetime.datetime.utcnow() - datetime.timedelta(days=i),
            job_id=job.id,
            screenshot_path=f"data/screenshots/job_{i}.png",
            cover_letter_text=f"Dear Acme {i}, I am excited...",
            questions_answered=[{"question": "Visa?", "answer": "Yes", "source": "prefilled"}],
            ats_type="easy_apply",
            resume_version="tailored" if i % 2 == 0 else "original",
        )
        db_session.add(record)

    # Add a connection request for the first job
    conn = ConnectionRequest(
        job_id=1,
        contact_name="Jane Recruiter",
        contact_title="Senior Recruiter",
        company="Acme 0",
        role_applied="Engineer 0",
        message_sent="Hi Jane, I just applied...",
        status="sent",
    )
    db_session.add(conn)
    db_session.commit()


class TestReviewApplications:
    """Tests for GET /applications/review."""

    def test_review_empty(self, client):
        r = client.get("/applications/review")
        assert r.status_code == 200
        assert r.json() == []

    def test_review_returns_extended_fields(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/review")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 3
        first = data[0]
        assert "screenshot_path" in first
        assert "cover_letter_text" in first
        assert "questions_answered" in first
        assert "ats_type" in first
        assert "resume_version" in first

    def test_review_filter_by_status(self, client, db_session):
        _seed_review_applications(db_session)
        # Change one to FAILED
        record = db_session.query(ApplicationRecord).first()
        record.status = ApplicationStatus.FAILED
        db_session.commit()

        r = client.get("/applications/review", params={"status": "failed"})
        assert r.status_code == 200
        assert len(r.json()) == 1
        assert r.json()[0]["status"] == "failed"

    def test_review_search_by_company(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/review", params={"search": "Acme 1"})
        assert r.status_code == 200
        assert len(r.json()) == 1
        assert r.json()[0]["company"] == "Acme 1"

    def test_review_search_by_role(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/review", params={"search": "Engineer 2"})
        assert r.status_code == 200
        assert len(r.json()) == 1
        assert r.json()[0]["role"] == "Engineer 2"

    def test_review_pagination(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/review", params={"page": 1, "page_size": 2})
        assert r.status_code == 200
        assert len(r.json()) == 2

        r2 = client.get("/applications/review", params={"page": 2, "page_size": 2})
        assert r2.status_code == 200
        assert len(r2.json()) == 1


class TestExportApplicationsCSV:
    """Tests for GET /applications/export."""

    def test_export_empty(self, client):
        r = client.get("/applications/export")
        assert r.status_code == 200
        assert r.headers["content-type"] == "text/csv; charset=utf-8"
        lines = r.text.strip().split("\n")
        # Header row only
        assert len(lines) == 1
        assert "Job ID" in lines[0]

    def test_export_with_data(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/export")
        assert r.status_code == 200
        assert "content-disposition" in r.headers
        assert "applications_export.csv" in r.headers["content-disposition"]

        lines = r.text.strip().split("\n")
        # Header + 3 data rows
        assert len(lines) == 4

    def test_export_csv_header_columns(self, client):
        r = client.get("/applications/export")
        header = r.text.strip().split("\n")[0]
        expected_cols = [
            "Job ID", "Title", "Company", "Location", "Work Style",
            "Description Excerpt", "Experience Required", "Skills",
            "HR Contact Name", "HR Contact Link", "Resume Used",
            "Date Posted", "Date Applied", "Job Link",
            "Questions Found", "Status",
        ]
        for col in expected_cols:
            assert col in header, f"Missing column: {col}"

    def test_export_includes_job_data(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/export")
        lines = r.text.strip().split("\n")
        # Check that a data row contains job-level info (location from ScrapedJob)
        assert "Ottawa" in r.text

    def test_export_includes_hr_contact(self, client, db_session):
        _seed_review_applications(db_session)
        r = client.get("/applications/export")
        assert "Jane Recruiter" in r.text
