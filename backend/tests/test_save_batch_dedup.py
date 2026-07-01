"""
Unit tests for save_job_batch deduplication logic.
Tests empty batch, all-duplicates batch, and mixed batch scenarios.
"""

import pytest
from backend.db.models import ScrapedJob


def _make_job(url, title="Test Job", company="Test Co"):
    return {"title": title, "company": company, "url": url, "location": "", "easyApply": 1, "atsType": "easy_apply"}


def test_empty_batch(client):
    """Empty batch returns saved=0, duplicates=0, total=0."""
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": []})
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"saved": 0, "duplicates": 0, "total": 0}


def test_all_new_jobs(client):
    """Batch of unique new jobs all get saved."""
    jobs = [_make_job(f"https://www.linkedin.com/jobs/view/{i}") for i in range(1, 4)]
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": jobs})
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] == 3
    assert data["duplicates"] == 0
    assert data["total"] == 3


def test_all_duplicates_against_db(client, db_session):
    """Batch where all URLs already exist in DB returns saved=0."""
    # Pre-populate
    for i in range(1, 4):
        db_session.add(ScrapedJob(
            title="Existing", company="Co", url=f"https://www.linkedin.com/jobs/view/{i}",
            location="", easy_apply=1, ats_type="easy_apply", platform="linkedin",
        ))
    db_session.commit()

    jobs = [_make_job(f"https://www.linkedin.com/jobs/view/{i}") for i in range(1, 4)]
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": jobs})
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] == 0
    assert data["duplicates"] == 3
    assert data["total"] == 3


def test_mixed_batch(client, db_session):
    """Batch with some existing and some new URLs."""
    # Pre-populate URL 1
    db_session.add(ScrapedJob(
        title="Existing", company="Co", url="https://www.linkedin.com/jobs/view/1",
        location="", easy_apply=1, ats_type="easy_apply", platform="linkedin",
    ))
    db_session.commit()

    jobs = [
        _make_job("https://www.linkedin.com/jobs/view/1"),  # duplicate
        _make_job("https://www.linkedin.com/jobs/view/2"),  # new
        _make_job("https://www.linkedin.com/jobs/view/3"),  # new
    ]
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": jobs})
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] == 2
    assert data["duplicates"] == 1
    assert data["total"] == 3


def test_within_batch_duplicates(client):
    """Batch containing duplicate URLs within itself."""
    jobs = [
        _make_job("https://www.linkedin.com/jobs/view/1"),
        _make_job("https://www.linkedin.com/jobs/view/1"),  # within-batch dup
        _make_job("https://www.linkedin.com/jobs/view/2"),
    ]
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": jobs})
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] == 2
    assert data["duplicates"] == 1
    assert data["total"] == 3


def test_jobs_without_url_skipped(client):
    """Jobs with empty URL are skipped (not counted as saved or duplicate)."""
    jobs = [
        _make_job(""),
        _make_job("https://www.linkedin.com/jobs/view/1"),
        {"title": "No URL", "company": "Co"},
    ]
    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": jobs})
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] == 1
    assert data["duplicates"] == 0
    assert data["total"] == 3
