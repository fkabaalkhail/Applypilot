"""Board crawling + reconciliation for big boards.

Workday and SmartRecruiters boards used to stop at a fixed page cap, so any
board bigger than 160 (Workday) or 500 (SmartRecruiters) postings came back
partial, was never reconciled, and leaked dead rows into the feed. These tests
pin the fix: whole lists are paged (within a page cap and a per-run deadline),
completeness is proven rather than assumed, partial snapshots still confirm
what they listed, and legacy rows are matched instead of duplicated.
"""

import asyncio
import datetime
import json
import time

import httpx
import pytest

from backend.data import company_registry
from backend.db.models import ScrapedJob
from backend.services import ats_scraper
from backend.services.ats_scraper import ATSJob, ATSScraper, BoardSnapshot
from backend.services.listing_freshness import (
    LISTING_ACTIVE,
    LISTING_REMOVED,
    LISTING_STALE,
)

NOW = datetime.datetime.utcnow()
OLD = NOW - datetime.timedelta(days=5)

ACME_CXS = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External"
BB_BASES = {
    "blackberry": "https://bb.wd3.myworkdayjobs.com/wday/cxs/bb/BlackBerry",
    "qnx": "https://bb.wd3.myworkdayjobs.com/wday/cxs/bb/QNX",
}


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    """The 0.35 s per-host pause would make paging a 200-posting board slow."""
    monkeypatch.setattr(ats_scraper, "_HOST_MIN_INTERVAL", 0.0)


@pytest.fixture
def acme_workday(monkeypatch):
    monkeypatch.setattr(company_registry, "load_workday_bases", lambda: {"acme": ACME_CXS})


def _unfiltered(**kwargs) -> ATSScraper:
    return ATSScraper(filter_entry_level=False, filter_north_america=False, **kwargs)


class WorkdayBoard(httpx.AsyncBaseTransport):
    """A CxS list endpoint over ``n`` postings, paged by the request offset.

    ``total_on_first_page_only`` mimics BMO, which reports "total" on the
    first page and 0 afterwards. ``close_first_after`` removes the newest
    posting once that many pages were served, so the list shifts up by one
    mid-crawl the way a live board does when a posting closes.
    """

    def __init__(self, n, total=None, total_on_first_page_only=False, close_first_after=None):
        self.postings = [
            {
                "title": f"Software Intern {i}",
                "externalPath": f"/job/Toronto-ON-CAN/Software-Intern-{i}_R-{i}",
                "locationsText": "Toronto, ON, CAN",
                "postedOn": "Posted Today",
                "bulletFields": [f"R-{i}"],
            }
            for i in range(n)
        ]
        self.total = n if total is None else total
        self.total_on_first_page_only = total_on_first_page_only
        self.close_first_after = close_first_after
        self.offsets: list[int] = []

    async def handle_async_request(self, request):
        body = json.loads(request.content)
        if self.close_first_after is not None and len(self.offsets) == self.close_first_after:
            del self.postings[0]
        offset, limit = body["offset"], body["limit"]
        self.offsets.append(offset)
        total = self.total
        if self.total_on_first_page_only and offset > 0:
            total = 0
        return httpx.Response(200, json={
            "total": total, "jobPostings": self.postings[offset:offset + limit],
        })


class SmartRecruitersBoard(httpx.AsyncBaseTransport):
    """A SmartRecruiters postings endpoint over ``n`` postings."""

    def __init__(self, n):
        self.content = [
            {
                "id": str(744000000000 + i),
                "name": f"Finance Analyst Intern {i}",
                "location": {"city": "Montreal", "region": "QC", "country": "ca"},
                "ref": f"https://api.smartrecruiters.com/v1/companies/Acme/postings/{744000000000 + i}",
                "releasedDate": "2026-09-01T10:00:00Z",
                "typeOfEmployment": {"label": "Intern"},
            }
            for i in range(n)
        ]
        self.offsets: list[int] = []

    async def handle_async_request(self, request):
        offset = int(request.url.params.get("offset", "0"))
        limit = int(request.url.params.get("limit", "100"))
        self.offsets.append(offset)
        return httpx.Response(200, json={
            "totalFound": len(self.content),
            "content": self.content[offset:offset + limit],
        })


# ─── Workday paging ──────────────────────────────────────────────────────────

class TestWorkdayPaging:
    @pytest.mark.asyncio
    async def test_pages_the_whole_board_and_completes(self, acme_workday):
        board = WorkdayBoard(205)  # 11 pages, past the old 8-page cap
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert snapshot.complete
        assert snapshot.total_listed == 205
        assert len(snapshot.all_urls) == 205
        assert board.offsets == list(range(0, 220, 20))
        assert "https://acme.wd3.myworkdayjobs.com/External/job/Toronto-ON-CAN/Software-Intern-204_R-204" \
            in snapshot.all_urls

    @pytest.mark.asyncio
    async def test_total_reported_on_first_page_only_still_completes(self, acme_workday):
        board = WorkdayBoard(45, total_on_first_page_only=True)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert snapshot.complete
        assert snapshot.total_listed == 45
        assert board.offsets == [0, 20, 40]

    @pytest.mark.asyncio
    async def test_board_at_the_listing_ceiling_stays_partial(self, acme_workday):
        board = WorkdayBoard(2000)  # Hitachi: CxS pins "total" at 2000
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert not snapshot.complete
        # Only the newest-first head is worth fetching: it can never complete.
        assert len(board.offsets) == ats_scraper._WORKDAY_HEAD_PAGES
        assert len(snapshot.all_urls) == ats_scraper._WORKDAY_HEAD_PAGES * 20

    @pytest.mark.asyncio
    async def test_spent_deadline_keeps_head_pages_and_reports_partial(self, acme_workday):
        board = WorkdayBoard(400)
        scraper = _unfiltered(deadline=time.monotonic() - 1)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await scraper.scrape_board(client, "workday", "acme", "Acme")

        assert not snapshot.complete
        # New postings land at the head, so the head is still crawled.
        assert len(board.offsets) == ats_scraper._WORKDAY_HEAD_PAGES
        assert len(snapshot.jobs) == ats_scraper._WORKDAY_HEAD_PAGES * 20

    @pytest.mark.asyncio
    async def test_page_cap_leaves_the_board_partial(self, acme_workday, monkeypatch):
        monkeypatch.setattr(ats_scraper, "_WORKDAY_MAX_PAGES", 3)
        monkeypatch.setattr(ats_scraper, "_WORKDAY_HEAD_PAGES", 3)
        board = WorkdayBoard(100)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert not snapshot.complete
        assert len(snapshot.all_urls) == 60

    @pytest.mark.asyncio
    async def test_list_shifting_mid_crawl_reads_as_partial(self, acme_workday):
        # A posting closes after page one: the list moves up by one, the first
        # posting of page two slides onto the already-read page and is never
        # seen. Declaring that complete would remove a live row.
        board = WorkdayBoard(60, total_on_first_page_only=True, close_first_after=1)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert not snapshot.complete
        assert len(snapshot.all_urls) == 59

    @pytest.mark.asyncio
    async def test_missing_total_never_proves_completeness(self, acme_workday):
        board = WorkdayBoard(15, total=0)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "workday", "acme", "Acme")

        assert not snapshot.complete
        assert len(snapshot.all_urls) == 15


# ─── SmartRecruiters paging + URL shape ──────────────────────────────────────

class TestSmartRecruiters:
    @pytest.mark.asyncio
    async def test_builds_the_public_posting_url(self):
        board = SmartRecruitersBoard(2)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "smartrecruiters", "Acme", "Acme")

        # careers.smartrecruiters.com redirects to the careers home for live
        # and closed postings alike; jobs.smartrecruiters.com is the posting.
        assert snapshot.all_urls == {
            "https://jobs.smartrecruiters.com/Acme/744000000000",
            "https://jobs.smartrecruiters.com/Acme/744000000001",
        }
        assert snapshot.jobs[0].external_id == "744000000000"

    @pytest.mark.asyncio
    async def test_pages_past_the_old_cap_and_completes(self):
        board = SmartRecruitersBoard(705)  # ServiceNow-sized: 8 pages of 100
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "smartrecruiters", "Acme", "Acme")

        assert snapshot.complete
        assert len(snapshot.all_urls) == 705
        assert board.offsets == list(range(0, 800, 100))

    @pytest.mark.asyncio
    async def test_big_board_stays_partial_at_the_page_cap(self, monkeypatch):
        monkeypatch.setattr(ats_scraper, "_SMARTRECRUITERS_MAX_PAGES", 3)
        board = SmartRecruitersBoard(450)  # Bosch-sized, scaled down
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await _unfiltered().scrape_board(client, "smartrecruiters", "Acme", "Acme")

        assert not snapshot.complete
        assert snapshot.total_listed == 450
        assert len(snapshot.all_urls) == 300

    @pytest.mark.asyncio
    async def test_spent_deadline_stops_after_head_pages(self):
        board = SmartRecruitersBoard(900)
        scraper = _unfiltered(deadline=time.monotonic() - 1)
        async with httpx.AsyncClient(transport=board) as client:
            snapshot = await scraper.scrape_board(client, "smartrecruiters", "Acme", "Acme")

        assert not snapshot.complete
        assert len(board.offsets) == ats_scraper._SMARTRECRUITERS_HEAD_PAGES

    def test_legacy_url_mapping(self):
        assert ats_scraper.smartrecruiters_legacy_url(
            "https://jobs.smartrecruiters.com/BoschGroup/744000148848849"
        ) == "https://careers.smartrecruiters.com/BoschGroup/744000148848849"
        assert ats_scraper.smartrecruiters_legacy_url("https://jobs.lever.co/acme/1") == ""


# ─── Concurrent crawl pool ───────────────────────────────────────────────────

class _RecordingScraper:
    """Stands in for ATSScraper: records which hosts are in flight."""

    def __init__(self, fail_slug=None):
        self.in_flight: dict[str, int] = {}
        self.max_per_host = 0
        self.max_total = 0
        self.started: list[str] = []
        self.fail_slug = fail_slug

    async def scrape_board(self, client, platform, slug, company_name):
        host = ats_scraper.board_host(platform, slug)
        self.started.append(platform)
        self.in_flight[host] = self.in_flight.get(host, 0) + 1
        self.max_per_host = max(self.max_per_host, self.in_flight[host])
        self.max_total = max(self.max_total, sum(self.in_flight.values()))
        try:
            await asyncio.sleep(0.01)
            if slug == self.fail_slug:
                raise RuntimeError("board renamed")
            return BoardSnapshot(platform=platform, slug=slug, company=company_name)
        finally:
            self.in_flight[host] -= 1


class TestCrawlPool:
    BOARDS = [
        ("greenhouse", "one", "One"), ("greenhouse", "two", "Two"),
        ("lever", "three", "Three"),
        ("workday", "blackberry", "BlackBerry"), ("workday", "qnx", "QNX"),
        ("workday", "acme", "Acme"),
    ]

    @pytest.fixture(autouse=True)
    def _bases(self, monkeypatch):
        monkeypatch.setattr(company_registry, "load_workday_bases",
                            lambda: {**BB_BASES, "acme": ACME_CXS})

    async def _drain(self, scraper, concurrency=6):
        from backend.routers.github_sources import _crawl_boards
        return [item async for item in _crawl_boards(scraper, None, self.BOARDS, concurrency)]

    @pytest.mark.asyncio
    async def test_one_board_per_host_in_flight(self):
        scraper = _RecordingScraper()
        results = await self._drain(scraper)

        assert sorted(board for board, _s, _e in results) == sorted(self.BOARDS)
        assert scraper.max_per_host == 1  # BlackBerry + QNX share bb.wd3
        assert 1 < scraper.max_total <= 6

    @pytest.mark.asyncio
    async def test_concurrency_limit_holds(self):
        scraper = _RecordingScraper()
        await self._drain(scraper, concurrency=2)
        assert scraper.max_total <= 2

    @pytest.mark.asyncio
    async def test_workday_launches_first(self):
        scraper = _RecordingScraper()
        await self._drain(scraper, concurrency=1)
        assert scraper.started[0] == "workday"

    @pytest.mark.asyncio
    async def test_failed_board_is_yielded_as_an_error(self):
        scraper = _RecordingScraper(fail_slug="two")
        results = await self._drain(scraper)

        errors = {board[1]: error for board, _snapshot, error in results if error}
        assert list(errors) == ["two"]
        assert "board renamed" in repr(errors["two"])
        assert sum(1 for _b, snapshot, _e in results if snapshot is not None) == 5


def test_board_host_per_platform(monkeypatch):
    monkeypatch.setattr(company_registry, "load_workday_bases", lambda: dict(BB_BASES))
    assert ats_scraper.board_host("greenhouse", "stripe") == "boards-api.greenhouse.io"
    assert ats_scraper.board_host("workday", "qnx") == "bb.wd3.myworkdayjobs.com"
    assert ats_scraper.board_host("workday", "qnx") == ats_scraper.board_host("workday", "blackberry")


def test_pacing_survives_a_new_event_loop(monkeypatch):
    """Per-host locks bind to the loop that first waits on them; each cron
    request (and each test) may run on a fresh loop."""
    monkeypatch.setattr(ats_scraper, "_HOST_MIN_INTERVAL", 0.01)

    async def burst():
        await asyncio.gather(*(ats_scraper._pace("example.test") for _ in range(3)))

    # Private loops, never installed as the current loop: asyncio.run() would
    # leave no current loop behind for later tests that call get_event_loop().
    for _ in range(2):
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(burst())
        finally:
            loop.close()


# ─── cron-ats reconciliation ─────────────────────────────────────────────────

def _row(db, url, board_key, **kwargs):
    defaults = dict(
        title="Software Intern", company="Acme", location="Toronto, ON, Canada",
        source_platform="ats", board_key=board_key, listing_status=LISTING_ACTIVE,
        first_seen_at=OLD, last_seen_at=OLD, scraped_at=OLD,
    )
    defaults.update(kwargs)
    row = ScrapedJob(url=url, **defaults)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _job(url, title="Software Intern") -> ATSJob:
    return ATSJob(title=title, company="Acme", location="Toronto, ON, Canada", url=url)


class TestCronReconciliation:
    def _run(self, client, monkeypatch, companies, snapshots):
        """POST cron-ats with ``snapshots`` {slug: BoardSnapshot kwargs}."""
        import backend.auth.dependencies as auth_deps

        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        monkeypatch.setattr(company_registry, "load_companies", lambda **kw: companies)

        async def fake_scrape_board(self, client, platform, slug, company_name):
            return BoardSnapshot(platform=platform, slug=slug, company=company_name,
                                 **snapshots[slug])

        monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)
        res = client.post("/github-sources/cron-ats",
                          headers={"x-cron-secret": "test-cron-secret"})
        assert res.status_code == 200, res.text
        return res.json()

    def test_partial_snapshot_confirms_listed_rows_and_removes_nothing(
            self, client, db_session, monkeypatch):
        board = "workday:acme"
        listed = _row(db_session, "https://acme.wd3.myworkdayjobs.com/External/job/a_R-1", board,
                      listing_status=LISTING_STALE)
        unlisted = _row(db_session, "https://acme.wd3.myworkdayjobs.com/External/job/b_R-2", board)

        body = self._run(client, monkeypatch, [("workday", "acme", "Acme")], {
            "acme": dict(jobs=[], all_urls={listed.url}, complete=False, total_listed=5000),
        })

        assert body["boards_partial"] == 1
        assert body["partial_confirmed"] == 1
        assert body["revived"] == 1
        assert body["removed"] == 0

        db_session.expire_all()
        listed_after = db_session.get(ScrapedJob, listed.id)
        unlisted_after = db_session.get(ScrapedJob, unlisted.id)
        assert listed_after.listing_status == LISTING_ACTIVE
        assert listed_after.last_seen_at > OLD
        assert unlisted_after.listing_status == LISTING_ACTIVE
        assert unlisted_after.last_seen_at == OLD  # not confirmed, not removed

    def test_complete_snapshot_still_removes_what_vanished(self, client, db_session, monkeypatch):
        board = "workday:acme"
        live = _row(db_session, "https://acme.wd3.myworkdayjobs.com/External/job/a_R-1", board)
        gone = _row(db_session, "https://acme.wd3.myworkdayjobs.com/External/job/b_R-2", board)

        body = self._run(client, monkeypatch, [("workday", "acme", "Acme")], {
            "acme": dict(jobs=[], all_urls={live.url}, complete=True, total_listed=1),
        })

        assert body["removed"] == 1
        db_session.expire_all()
        assert db_session.get(ScrapedJob, gone.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, live.id).listing_status == LISTING_ACTIVE

    def test_shared_tenant_sites_never_remove_each_other(self, client, db_session, monkeypatch):
        """BlackBerry and QNX share Workday tenant "bb": legacy rows of both
        carry board_key "workday:bb". A complete BlackBerry crawl must only
        reconcile BlackBerry's rows."""
        monkeypatch.setattr(company_registry, "load_workday_bases", lambda: dict(BB_BASES))
        bb_live = _row(db_session, "https://bb.wd3.myworkdayjobs.com/BlackBerry/job/Waterloo/Dev_20260097",
                       "workday:bb")
        bb_gone = _row(db_session, "https://bb.wd3.myworkdayjobs.com/BlackBerry/job/Waterloo/Ops_20260216",
                       "workday:bb")
        qnx = _row(db_session, "https://bb.wd3.myworkdayjobs.com/QNX/job/Ottawa/Writer_20260220",
                   "workday:bb")

        self._run(client, monkeypatch, [("workday", "blackberry", "BlackBerry")], {
            "blackberry": dict(jobs=[], all_urls={bb_live.url}, complete=True, total_listed=1),
        })

        db_session.expire_all()
        assert db_session.get(ScrapedJob, bb_live.id).board_key == "workday:blackberry"
        assert db_session.get(ScrapedJob, bb_live.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, bb_gone.id).listing_status == LISTING_REMOVED
        qnx_after = db_session.get(ScrapedJob, qnx.id)
        assert qnx_after.board_key == "workday:bb"
        assert qnx_after.listing_status == LISTING_ACTIVE

    def test_legacy_smartrecruiters_row_moves_to_the_posting_url(
            self, client, db_session, monkeypatch):
        legacy = _row(db_session, "https://careers.smartrecruiters.com/Acme/744000000001",
                      "smartrecruiters:Acme")
        new_url = "https://jobs.smartrecruiters.com/Acme/744000000001"

        body = self._run(client, monkeypatch, [("smartrecruiters", "Acme", "Acme")], {
            "Acme": dict(jobs=[_job(new_url)], all_urls={new_url}, complete=True, total_listed=1),
        })

        assert body["urls_migrated"] == 1
        assert body["new_jobs"] == 0  # matched, not inserted as a twin
        assert body["removed"] == 0
        db_session.expire_all()
        row = db_session.get(ScrapedJob, legacy.id)
        assert row.url == new_url
        assert row.listing_status == LISTING_ACTIVE
        assert db_session.query(ScrapedJob).count() == 1

    def test_legacy_row_left_alone_when_the_posting_url_is_taken(
            self, client, db_session, monkeypatch):
        legacy = _row(db_session, "https://careers.smartrecruiters.com/Acme/744000000001",
                      "smartrecruiters:Acme")
        new_url = "https://jobs.smartrecruiters.com/Acme/744000000001"
        twin = _row(db_session, new_url, "", source_platform="github")

        body = self._run(client, monkeypatch, [("smartrecruiters", "Acme", "Acme")], {
            "Acme": dict(jobs=[], all_urls={new_url}, complete=False, total_listed=4800),
        })

        assert body["urls_migrated"] == 0
        db_session.expire_all()
        assert db_session.get(ScrapedJob, legacy.id).url.startswith("https://careers.")
        assert db_session.get(ScrapedJob, twin.id).url == new_url


def test_confirm_listed_touches_only_its_board(db_session):
    from backend.routers.github_sources import _confirm_listed

    removed = _row(db_session, "https://jobs.lever.co/acme/1", "lever:acme",
                   listing_status=LISTING_REMOVED)
    other = _row(db_session, "https://jobs.lever.co/other/1", "lever:other",
                 listing_status=LISTING_STALE)

    stats = _confirm_listed(db_session, "lever:acme", {removed.url, other.url}, now=NOW)

    assert stats == {"confirmed": 1, "revived": 1}
    db_session.expire_all()
    assert db_session.get(ScrapedJob, removed.id).listing_status == LISTING_ACTIVE
    assert db_session.get(ScrapedJob, removed.id).last_seen_at == NOW
    assert db_session.get(ScrapedJob, other.id).listing_status == LISTING_STALE
