"""
Property-based test for POST /jobs/ingest-batch server-side deduplication.
Feature: deep-scrape-pagination, Property 7: Server-side deduplication accounting

Written (1616ea7) against /api/extension/jobs/save-batch, a route that never
existed in this backend, so every example 404'd and the test was red from the
day it landed. /jobs/ingest-batch is the batched path the scrapers actually
call (31cc443); test_save_batch_dedup.py covers its fixed scenarios.

For any batch against any set of already-stored URLs:
- received == len(batch), and every job lands in exactly one bucket:
  created + duplicates + skipped + senior_skipped == received (skipped = no
  URL, senior_skipped = a plainly senior title);
- every new URL is inserted exactly once and nothing already stored is
  inserted again: created + cross_source_twins_skipped == new URLs
  (a cross-source twin is counted as a duplicate instead of created).
"""

from hypothesis import given, settings, HealthCheck, strategies as st
import pytest

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob
from backend.services.ats_scraper import HARD_SENIOR
from backend.services.cross_source_dedup import canonical_url

SECRET = "test-cron-secret"


# Strategy: a job whose URL comes from a small pool, to force duplicates. The
# utm_ variant canonicalizes onto its plain twin (a duplicate, not a new job),
# and "" is a job with no URL (skipped).
job_url_pool = [f"https://www.linkedin.com/jobs/view/{i}" for i in range(1, 20)]
batch_url_pool = job_url_pool + [
    "https://www.linkedin.com/jobs/view/3?utm_source=jobspy",
    "",
]

job_strategy = st.fixed_dictionaries({
    "title": st.text(min_size=1, max_size=50, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "company": st.text(min_size=1, max_size=50, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "url": st.sampled_from(batch_url_pool),
    "location": st.text(max_size=30, alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"))),
    "source_platform": st.sampled_from(["linkedin", "indeed", "ats"]),
})

batch_strategy = st.lists(job_strategy, min_size=0, max_size=30)
pre_existing_strategy = st.lists(st.sampled_from(job_url_pool), min_size=0, max_size=10)


@pytest.fixture
def cron_headers(monkeypatch):
    """Pin the cron secret so the test doesn't depend on the local environment."""
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


@given(batch=batch_strategy, pre_existing=pre_existing_strategy)
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
def test_save_batch_dedup_accounting(client, db_session, cron_headers, batch, pre_existing):
    """
    Property 7: For any batch of jobs where some URLs already exist in DB,
    created + duplicates == count of jobs with non-empty URLs, and each new
    URL is stored exactly once.
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

    resp = client.post("/jobs/ingest-batch", json={"jobs": batch}, headers=cron_headers)
    assert resp.status_code == 200, resp.text

    data = resp.json()
    created = data["created"]
    duplicates = data["duplicates"]

    assert data["received"] == len(batch)

    # Only jobs with non-empty URLs count toward created + duplicates, and
    # a plainly senior title (ats_scraper.HARD_SENIOR) is set aside first.
    jobs_with_url = [j for j in batch if j.get("url")]
    kept = [j for j in jobs_with_url if not HARD_SENIOR.search(j["title"])]
    assert created + duplicates == len(kept)
    assert data["senior_skipped"] == len(jobs_with_url) - len(kept)
    assert data["skipped"] == len(batch) - len(jobs_with_url)
    assert created >= 0
    assert duplicates >= 0

    new_urls = {canonical_url(j["url"]) for j in kept} - set(pre_existing)
    assert created + data["cross_source_twins_skipped"] == len(new_urls)
    # ...and the table agrees: every stored URL is unique and canonical.
    stored = [row.url for row in db_session.query(ScrapedJob.url)]
    assert len(stored) == len(set(stored)) == len(set(pre_existing)) + created
    assert all(url == canonical_url(url) for url in stored)
