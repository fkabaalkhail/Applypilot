"""Legacy SmartRecruiters URLs (services/legacy_urls.py).

Rows stored before the crawl's URL fix point at careers.smartrecruiters.com,
which redirects to the employer's careers home; the posting lives at
jobs.smartrecruiters.com. cron-backfill migrates them from the URL alone,
and the API hands out the posting URL for any row still waiting.
"""

import datetime
import socket

import httpx
import pytest

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob
from backend.routers import jobs as jobs_router
from backend.services import legacy_urls, logo_cache
from backend.services.ats_scraper import SMARTRECRUITERS_POSTING_BASE, smartrecruiters_legacy_url
from backend.services.cross_source_dedup import (
    release_from_closed_winners,
    release_list_copies_of_lapsed_board_rows,
)
from backend.services.legacy_urls import (
    apply_url,
    migrate_legacy_smartrecruiters,
    smartrecruiters_posting_url,
)
from backend.services.listing_freshness import AGGREGATOR_MAX_AGE_DAYS, sweep_aggregator_expiry

SECRET = "test-cron-secret"
LEGACY = "https://careers.smartrecruiters.com/BoschGroup/744000143933909"
POSTING = "https://jobs.smartrecruiters.com/BoschGroup/744000143933909"
DESCRIPTION = "Build embedded software for automotive systems. " * 3


def _row(db_session, url=LEGACY, **fields):
    fields.setdefault("title", "Software Engineering Intern")
    fields.setdefault("company", "Bosch")
    fields.setdefault("description", DESCRIPTION)
    fields.setdefault("source_platform", "ats")
    fields.setdefault("board_key", "smartrecruiters:BoschGroup")
    row = ScrapedJob(url=url, **fields)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def _reload(db_session, row_id):
    db_session.expire_all()
    return db_session.get(ScrapedJob, row_id)


# --- the mapping ------------------------------------------------------------

def test_posting_url_is_the_inverse_of_the_crawls_legacy_mapping():
    """cron-ats finds a legacy row through smartrecruiters_legacy_url of the
    URL its crawl builds; this mapping must land on that same URL, or the two
    migrations would leave a row at two different addresses."""
    crawl_url = f"{SMARTRECRUITERS_POSTING_BASE}BoschGroup/744000143933909"
    legacy = smartrecruiters_legacy_url(crawl_url)

    assert legacy == LEGACY
    assert smartrecruiters_posting_url(legacy) == crawl_url
    assert smartrecruiters_posting_url(
        "https://careers.smartrecruiters.com/LinkedIn3/a3b09881-7c3e-444c-9e65-ac0e2c6a8970"
    ) == "https://jobs.smartrecruiters.com/LinkedIn3/a3b09881-7c3e-444c-9e65-ac0e2c6a8970"


@pytest.mark.parametrize("url", [
    POSTING,
    "https://careers.smartrecruiters.com/BoschGroup",  # the company page, not a posting
    "https://careers.smartrecruiters.com/BoschGroup/",
    "http://careers.smartrecruiters.com/BoschGroup/744000143933909",
    "https://careers.smartrecruiters.com.evil.test/BoschGroup/744000143933909",
    "https://boards.greenhouse.io/acme/jobs/123456",
    "",
])
def test_only_a_legacy_posting_url_is_mapped(url):
    assert smartrecruiters_posting_url(url) == ""
    assert apply_url(url) == url


def test_apply_url_sends_a_legacy_row_to_its_posting():
    assert apply_url(LEGACY) == POSTING


# --- the migration ----------------------------------------------------------

def test_free_posting_url_is_taken(db_session):
    row = _row(db_session)

    stats = migrate_legacy_smartrecruiters(db_session)
    db_session.rollback()  # committed, not just flushed

    assert stats == {"checked": 1, "migrated": 1, "hidden_as_twin": 0, "blocked": 0}
    assert _reload(db_session, row.id).url == POSTING
    assert migrate_legacy_smartrecruiters(db_session)["checked"] == 0  # settled


def test_held_posting_url_hides_the_legacy_row_behind_its_holder(db_session):
    """url is UNIQUE: the legacy row becomes the holder's hidden twin, so
    saved jobs and applications that point at it still resolve."""
    holder = _row(db_session, url=POSTING)
    legacy = _row(db_session)

    stats = migrate_legacy_smartrecruiters(db_session)
    db_session.rollback()  # committed, not just flushed

    assert (stats["migrated"], stats["hidden_as_twin"]) == (0, 1)
    row = _reload(db_session, legacy.id)
    assert (row.url, row.duplicate_of) == (LEGACY, holder.id)
    assert _reload(db_session, holder.id).duplicate_of is None


def test_a_removed_board_holder_still_speaks_for_the_legacy_row(db_session):
    """Same posting id on the same platform: its closure is the legacy
    row's too."""
    holder = _row(db_session, url=POSTING, listing_status="removed")
    legacy = _row(db_session)

    assert migrate_legacy_smartrecruiters(db_session)["hidden_as_twin"] == 1
    assert _reload(db_session, legacy.id).duplicate_of == holder.id


def test_never_hides_behind_a_holder_that_cannot_stand_in(db_session):
    """An expired list copy can't answer for a live board row, and nothing
    would ever release the board row: it keeps its URL (apply_url still
    sends applicants to the posting)."""
    _row(db_session, url=POSTING, source_platform="github", board_key="",
         listing_status="expired")
    legacy = _row(db_session)

    stats = migrate_legacy_smartrecruiters(db_session)

    assert (stats["hidden_as_twin"], stats["blocked"]) == (0, 1)
    row = _reload(db_session, legacy.id)
    assert (row.url, row.duplicate_of) == (LEGACY, None)


def test_never_hides_behind_a_holder_that_is_itself_hidden(db_session):
    """A list copy hidden behind this very board row: pointing back at it
    would make a cycle and drop the posting from the feed."""
    legacy = _row(db_session)
    _row(db_session, url=POSTING, source_platform="github", board_key="",
         duplicate_of=legacy.id)

    stats = migrate_legacy_smartrecruiters(db_session)

    assert (stats["hidden_as_twin"], stats["blocked"]) == (0, 1)
    assert _reload(db_session, legacy.id).duplicate_of is None


@pytest.mark.parametrize("source_platform", ["github", "linkedin", "indeed"])
def test_never_hides_behind_a_live_list_or_aggregator_copy(db_session, source_platform):
    """Only a board row answers for a board row: nothing releases one hidden
    behind a copy (release_from_closed_winners frees only LinkedIn/Indeed
    rows, release_list_copies_of_lapsed_board_rows only list copies)."""
    copy = _row(db_session, url=POSTING, source_platform=source_platform, board_key="",
                listing_status="active")
    legacy = _row(db_session, listing_status="active")

    stats = migrate_legacy_smartrecruiters(db_session)

    assert (stats["hidden_as_twin"], stats["blocked"]) == (0, 1)
    assert _reload(db_session, legacy.id).duplicate_of is None
    assert _reload(db_session, copy.id).duplicate_of is None


def test_a_board_row_outlives_the_list_copy_holding_its_posting_url(db_session):
    """Review 5's probe: hidden behind a live list copy, the board row stayed
    hidden for good once the copy aged out."""
    now = datetime.datetime(2026, 9, 29, 12, 0, 0)
    old = now - datetime.timedelta(days=AGGREGATOR_MAX_AGE_DAYS + 1)
    copy = _row(db_session, url=POSTING, source_platform="github", board_key="",
                listing_status="active", posted_date=old, first_seen_at=old, scraped_at=old)
    legacy = _row(db_session, listing_status="active", first_seen_at=now, scraped_at=now)

    migrate_legacy_smartrecruiters(db_session)
    assert sweep_aggregator_expiry(db_session, now=now) == 1  # the list copy ages out
    release_from_closed_winners(db_session)
    release_list_copies_of_lapsed_board_rows(db_session)

    row = _reload(db_session, legacy.id)
    assert (row.url, row.duplicate_of, row.listing_status) == (LEGACY, None, "active")
    assert _reload(db_session, copy.id).listing_status == "expired"


def test_bounded_and_skips_rows_already_hidden(db_session):
    # Hidden first (lowest id): selected, it would take one of the two slots.
    other = _row(db_session, url="https://example.com/other")
    hidden_url = "https://careers.smartrecruiters.com/BoschGroup/744000100000001"
    hidden = _row(db_session, url=hidden_url, duplicate_of=other.id).id
    legacy = [f"{LEGACY[:-3]}{n:03d}" for n in range(3)]
    visible = [_row(db_session, url=url).id for url in legacy]

    stats = migrate_legacy_smartrecruiters(db_session, limit=2)

    assert (stats["checked"], stats["migrated"]) == (2, 2)
    urls = [_reload(db_session, row_id).url for row_id in visible]
    assert urls == [smartrecruiters_posting_url(legacy[0]),
                    smartrecruiters_posting_url(legacy[1]),
                    legacy[2]]  # the next run's
    assert _reload(db_session, hidden).url == hidden_url


# --- cron-backfill phase ----------------------------------------------------

@pytest.fixture
def cron(monkeypatch):
    """cron-backfill with no network: no descriptions, no logo harvest."""
    async def no_description(client, url):
        return ""

    async def no_harvest(db, client, *, deadline):
        return {}

    monkeypatch.setattr(jobs_router, "extract_description_from_url", no_description)
    monkeypatch.setattr(logo_cache, "harvest_missing_logos", no_harvest)
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def test_backfill_migrates_legacy_rows(client, db_session, cron):
    row = _row(db_session)

    res = client.post("/jobs/cron-backfill", headers=cron)

    assert res.status_code == 200, res.text
    assert res.json()["legacy_smartrecruiters"]["migrated"] == 1
    assert _reload(db_session, row.id).url == POSTING


def test_backfill_legacy_migration_never_runs_past_the_harvest_mark(
    client, db_session, cron, monkeypatch,
):
    row = _row(db_session)
    monkeypatch.setattr(jobs_router, "BACKFILL_BUDGET_S", 10.0)
    monkeypatch.setattr(jobs_router, "POST_HARVEST_RESERVE_S", 10.0)

    body = client.post("/jobs/cron-backfill", headers=cron).json()

    assert body["legacy_smartrecruiters"] == {"skipped": True}
    assert _reload(db_session, row.id).url == LEGACY


def test_backfill_survives_a_failed_migration(client, db_session, cron, monkeypatch):
    def boom(db, limit):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(legacy_urls, "migrate_legacy_smartrecruiters", boom)

    res = client.post("/jobs/cron-backfill", headers=cron)

    assert res.status_code == 200, res.text
    assert res.json()["legacy_smartrecruiters"] == {"error": True}


# --- the apply path ---------------------------------------------------------

def test_job_answers_with_the_posting_url_and_leaves_the_row_alone(client, db_session):
    row = _row(db_session)

    assert client.get(f"/jobs/{row.id}").json()["url"] == POSTING
    assert [job["url"] for job in client.get("/jobs").json()] == [POSTING]
    assert _reload(db_session, row.id).url == LEGACY


@pytest.fixture
def public_dns(monkeypatch):
    def fake_getaddrinfo(host, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)


def _serve(monkeypatch, handler):
    seen: list[str] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return handler(request)

    monkeypatch.setattr(
        jobs_router, "_details_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(recording), follow_redirects=True),
    )
    return seen


def test_fetch_details_answers_a_described_legacy_row_with_its_posting(
    client, db_session, monkeypatch, public_dns,
):
    _serve(monkeypatch, lambda request: pytest.fail("no fetch expected"))
    row = _row(db_session)

    body = client.post(f"/jobs/{row.id}/fetch-details").json()

    assert body["apply_url"] == POSTING


def test_fetch_details_reads_the_posting_page_not_the_careers_home(
    client, db_session, monkeypatch, public_dns,
):
    async def fake_extract(client, url, html, final_url):
        return html

    monkeypatch.setattr(jobs_router, "extract_description_from_html", fake_extract)
    page = "<html><body>" + DESCRIPTION + "</body></html>"
    seen = _serve(monkeypatch, lambda request: (
        httpx.Response(200, text=page) if request.url.host == "jobs.smartrecruiters.com"
        else httpx.Response(302, headers={"location": "https://jobs.bosch.com/en"})
    ))
    row = _row(db_session, description="")

    body = client.post(f"/jobs/{row.id}/fetch-details").json()

    assert seen == [POSTING]
    assert (body["apply_url"], body["dead"]) == (POSTING, False)
    stored = _reload(db_session, row.id)
    assert stored.url == LEGACY  # the migration's job, not a click's
    assert DESCRIPTION.strip() in stored.description
