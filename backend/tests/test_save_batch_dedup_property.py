"""
Property-based test for save_job_batch server-side deduplication.
Feature: deep-scrape-pagination, Property 7: Server-side deduplication accounting

Uses Hypothesis to verify: saved + duplicates == total (jobs with non-empty URLs).
"""

import pytest
from hypothesis import given, settings, HealthCheck, strategies as st

from backend.db.models import ScrapedJob


# Strategy: generate a job dict with a URL from a small pool (to create duplicates)
job_url_pool = [f"https://www.linkedin.com/jobs/view/{i}" for i in range(1, 20)]

job_strategy = st.fixed_dictionaries({
    "title": st.text(min_size=1, max_size=50, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "company": st.text(min_size=1, max_size=50, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "url": st.sampled_from(job_url_pool),
    "location": st.text(max_size=30, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "easyApply": st.sampled_from([0, 1]),
    "atsType": st.sampled_from(["easy_apply", "external"]),
})

batch_strategy = st.lists(job_strategy, min_size=0, max_size=30)
pre_existing_strategy = st.lists(st.sampled_from(job_url_pool), min_size=0, max_size=10)


@given(batch=batch_strategy, pre_existing=pre_existing_strategy)
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
def test_save_batch_dedup_accounting(client, db_session, batch, pre_existing):
    """
    Property 7: For any batch of jobs where some URLs already exist in DB,
    saved + duplicates == count of jobs with non-empty URLs.
    """
    # Rollback any pending state, then clean slate
    db_session.rollback()
    db_session.query(ScrapedJob).delete()
    db_session.commit()

    # Pre-populate DB with some existing jobs
    for url in set(pre_existing):
        existing = ScrapedJob(
            title="Existing",
            company="Existing Co",
            url=url,
            location="",
            easy_apply=1,
            ats_type="easy_apply",
            platform="linkedin",
        )
        db_session.add(existing)
    db_session.commit()

    resp = client.post("/api/extension/jobs/save-batch", json={"jobs": batch})
    assert resp.status_code == 200

    data = resp.json()
    saved = data["saved"]
    duplicates = data["duplicates"]
    total = data["total"]

    # total == len(batch)
    assert total == len(batch)

    # Only jobs with non-empty URLs count toward saved + duplicates
    jobs_with_url = [j for j in batch if j.get("url")]
    assert saved + duplicates == len(jobs_with_url)
    assert saved >= 0
    assert duplicates >= 0
