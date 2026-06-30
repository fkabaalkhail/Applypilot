"""End-to-end tests for per-user job saving (the bookmark button).

Saving writes to user_saved_jobs; the listing/stats read path must reflect that
same per-user state (not the global ScrapedJob.saved column). The conftest client
fixture authenticates every request as TEST_USER_ID (1).
"""

from backend.db.models import ScrapedJob, UserSavedJob

TEST_USER_ID = 1
OTHER_USER_ID = 2


def _make_job(db, url, company="Acme"):
    job = ScrapedJob(
        title="Engineer",
        company=company,
        url=url,
        location="NYC",
        match_score=80,
        source_platform="linkedin",
        country="US",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def _find(jobs, job_id):
    return next((j for j in jobs if j["id"] == job_id), None)


def test_save_then_list_reflects_saved(client, db_session):
    job = _make_job(db_session, "https://example.com/jobs/1")

    # Initially unsaved.
    listing = client.get("/jobs").json()
    assert _find(listing, job.id)["saved"] == 0

    # Save → response reports saved, and a UserSavedJob row exists.
    resp = client.post(f"/jobs/{job.id}/save")
    assert resp.status_code == 200
    assert resp.json()["saved"] == 1
    assert (
        db_session.query(UserSavedJob)
        .filter(UserSavedJob.user_id == TEST_USER_ID, UserSavedJob.job_id == job.id)
        .count()
        == 1
    )

    # Listing now shows it saved, and it persists (no reliance on optimistic UI).
    listing = client.get("/jobs").json()
    assert _find(listing, job.id)["saved"] == 1

    # The "Liked" tab (saved=1) includes it; stats count it.
    liked = client.get("/jobs?saved=1").json()
    assert _find(liked, job.id) is not None
    assert client.get("/jobs/stats").json()["saved_count"] == 1


def test_unsave_removes_it(client, db_session):
    job = _make_job(db_session, "https://example.com/jobs/2")
    client.post(f"/jobs/{job.id}/save")

    resp = client.post(f"/jobs/{job.id}/unsave")
    assert resp.status_code == 200
    assert resp.json()["saved"] == 0

    listing = client.get("/jobs").json()
    assert _find(listing, job.id)["saved"] == 0
    assert client.get("/jobs?saved=1").json() == []
    assert client.get("/jobs/stats").json()["saved_count"] == 0


def test_save_is_idempotent(client, db_session):
    """Saving the same job twice creates exactly one row (no duplicate bookmark)."""
    job = _make_job(db_session, "https://example.com/jobs/3")
    client.post(f"/jobs/{job.id}/save")
    client.post(f"/jobs/{job.id}/save")
    assert (
        db_session.query(UserSavedJob)
        .filter(UserSavedJob.user_id == TEST_USER_ID, UserSavedJob.job_id == job.id)
        .count()
        == 1
    )


def test_saved_state_is_per_user(client, db_session):
    """Another user's save must not leak into this user's view."""
    job = _make_job(db_session, "https://example.com/jobs/4")
    # A different user saved it directly.
    db_session.add(UserSavedJob(user_id=OTHER_USER_ID, job_id=job.id))
    db_session.commit()

    # TEST_USER_ID (the caller) should still see it as unsaved.
    listing = client.get("/jobs").json()
    assert _find(listing, job.id)["saved"] == 0
    assert client.get("/jobs?saved=1").json() == []
    assert client.get("/jobs/stats").json()["saved_count"] == 0


def test_save_unknown_job_404(client, db_session):
    assert client.post("/jobs/999999/save").status_code == 404
