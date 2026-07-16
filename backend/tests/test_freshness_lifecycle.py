"""Freshness lifecycle: re-crawls confirm, vanishing removes, age expires,
ghosts get scored — and none of it deletes a row or hides a bookmark."""

import datetime

import pytest

from backend.db.models import ScrapedJob, User, UserSavedJob
from backend.services.ats_scraper import ATSJob
from backend.services.listing_freshness import (
    AGGREGATOR_FAST_MAX_AGE_DAYS,
    AGGREGATOR_MAX_AGE_DAYS,
    GHOST_DAYS_OPEN,
    LISTING_ACTIVE,
    LISTING_EXPIRED,
    LISTING_REMOVED,
    LISTING_STALE,
    STALE_AFTER_HOURS,
    backfill_board_keys,
    board_key_from_url,
    build_new_row_fields,
    reconcile_board,
    refresh_known_listings,
    score_ghost_risk,
    sweep_aggregator_expiry,
    sweep_stale,
)

NOW = datetime.datetime(2026, 7, 16, 12, 0, 0)
BOARD = "greenhouse:acme"


def _job(url="https://boards.greenhouse.io/acme/jobs/1", title="Software Intern",
         **kwargs) -> ATSJob:
    defaults = dict(company="Acme", location="Ottawa, ON, Canada")
    defaults.update(kwargs)
    return ATSJob(title=title, url=url, **defaults)


def _row(db, url="https://boards.greenhouse.io/acme/jobs/1", **kwargs):
    defaults = dict(
        title="Software Intern", company="Acme", location="Ottawa, ON, Canada",
        source_platform="ats", board_key=BOARD, listing_status=LISTING_ACTIVE,
        first_seen_at=NOW - datetime.timedelta(days=1),
        last_seen_at=NOW - datetime.timedelta(days=1),
        scraped_at=NOW - datetime.timedelta(days=1),
    )
    defaults.update(kwargs)
    row = ScrapedJob(url=url, **defaults)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ─── build_new_row_fields ────────────────────────────────────────────────────

class TestBuildNewRowFields:
    def test_populates_freshness_and_extraction(self, db_session):
        job = _job(
            description="Build in Python on AWS. Visa sponsorship is available. Pay: $90,000 - $110,000 per year.",
            external_id="4285367",
        )
        fields = build_new_row_fields(job, BOARD)
        assert fields["listing_status"] == LISTING_ACTIVE
        assert fields["first_seen_at"] is not None
        assert fields["board_key"] == BOARD
        assert fields["external_id"] == "greenhouse:acme:4285367"
        assert fields["source_trust"] == "high"
        assert fields["salary_min"] == 90000
        assert fields["salary_max"] == 110000
        assert fields["visa_sponsorship"] == "yes"
        assert "python" in fields["skills"]
        assert fields["raw_hash"]

    def test_salary_text_beats_description(self, db_session):
        job = _job(salary_text="45000-55000 CAD", description="No numbers here.")
        fields = build_new_row_fields(job, BOARD)
        assert fields["salary_min"] == 45000
        assert fields["salary_currency"] == "CAD"


# ─── reconcile_board ─────────────────────────────────────────────────────────

class TestReconcileBoard:
    def test_confirms_live_and_removes_vanished(self, db_session):
        live = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/1")
        gone = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2")

        stats = reconcile_board(db_session, BOARD, {live.url}, now=NOW)

        db_session.expire_all()
        assert stats["confirmed"] == 1
        assert stats["removed"] == 1
        assert db_session.get(ScrapedJob, live.id).last_seen_at == NOW
        assert db_session.get(ScrapedJob, live.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, gone.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, gone.id).listing_status_changed_at == NOW

    def test_revives_removed_row_that_reappears(self, db_session):
        row = _row(db_session, listing_status=LISTING_REMOVED)
        stats = reconcile_board(db_session, BOARD, {row.url}, now=NOW)
        db_session.expire_all()
        assert stats["revived"] == 1
        assert db_session.get(ScrapedJob, row.id).listing_status == LISTING_ACTIVE

    def test_does_not_touch_other_boards(self, db_session):
        other = _row(db_session, url="https://jobs.lever.co/other/1", board_key="lever:other")
        reconcile_board(db_session, BOARD, set(), now=NOW)
        db_session.expire_all()
        assert db_session.get(ScrapedJob, other.id).listing_status == LISTING_ACTIVE

    def test_empty_board_with_many_rows_degrades_to_stale_sweep(self, db_session):
        rows = [
            _row(db_session, url=f"https://boards.greenhouse.io/acme/jobs/{i}")
            for i in range(12)
        ]
        stats = reconcile_board(db_session, BOARD, set(), now=NOW)
        db_session.expire_all()
        assert stats["removed"] == 0
        assert all(
            db_session.get(ScrapedJob, r.id).listing_status == LISTING_ACTIVE
            for r in rows
        )

    def test_small_board_going_empty_is_real(self, db_session):
        row = _row(db_session)
        stats = reconcile_board(db_session, BOARD, set(), now=NOW)
        db_session.expire_all()
        assert stats["removed"] == 1
        assert db_session.get(ScrapedJob, row.id).listing_status == LISTING_REMOVED


# ─── refresh_known_listings ──────────────────────────────────────────────────

class TestRefreshKnownListings:
    def test_splits_new_from_known_and_bumps_seen(self, db_session):
        known = _row(db_session)
        jobs = [
            _job(url=known.url),
            _job(url="https://boards.greenhouse.io/acme/jobs/9", title="Data Intern"),
        ]
        new_jobs, stats = refresh_known_listings(db_session, BOARD, jobs, now=NOW)
        db_session.expire_all()
        assert [j.url for j in new_jobs] == ["https://boards.greenhouse.io/acme/jobs/9"]
        assert stats["refreshed"] == 1
        assert db_session.get(ScrapedJob, known.id).last_seen_at == NOW

    def test_title_change_logged(self, db_session):
        known = _row(db_session, title="Software Intern")
        jobs = [_job(url=known.url, title="Software Engineering Intern")]
        _new, stats = refresh_known_listings(db_session, BOARD, jobs, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, known.id)
        assert stats["edited"] == 1
        assert row.title == "Software Engineering Intern"
        assert row.edit_count == 1
        assert row.change_log[-1]["changed"] == ["title"]

    def test_salary_removed_flagged(self, db_session):
        known = _row(db_session, salary_min=90000, salary_max=110000)
        jobs = [_job(url=known.url,
                     description="A fresh description with no pay information at all.")]
        _new, stats = refresh_known_listings(db_session, BOARD, jobs, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, known.id)
        assert stats["salary_removed"] == 1
        assert "salary_removed" in row.change_log[-1]["changed"]

    def test_empty_description_recrawl_is_not_an_edit(self, db_session):
        """SmartRecruiters/Workday list payloads carry no description — a
        refresh without one must not log a description change."""
        known = _row(db_session, description="Full stored description here.",
                     raw_hash="somehash")
        jobs = [_job(url=known.url, description="")]
        _new, stats = refresh_known_listings(db_session, BOARD, jobs, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, known.id)
        assert stats["edited"] == 0
        assert row.description == "Full stored description here."

    def test_adopts_legacy_row_into_board(self, db_session):
        known = _row(db_session, board_key="")
        _new, _stats = refresh_known_listings(
            db_session, BOARD, [_job(url=known.url)], now=NOW,
        )
        db_session.expire_all()
        assert db_session.get(ScrapedJob, known.id).board_key == BOARD


# ─── Sweeps ──────────────────────────────────────────────────────────────────

class TestSweeps:
    def test_stale_sweep_marks_unconfirmed_ats_rows(self, db_session):
        old = _row(db_session, last_seen_at=NOW - datetime.timedelta(hours=STALE_AFTER_HOURS + 1))
        fresh = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2",
                     last_seen_at=NOW - datetime.timedelta(hours=1))
        count = sweep_stale(db_session, now=NOW)
        db_session.expire_all()
        assert count == 1
        assert db_session.get(ScrapedJob, old.id).listing_status == LISTING_STALE
        assert db_session.get(ScrapedJob, fresh.id).listing_status == LISTING_ACTIVE

    def test_stale_sweep_ignores_aggregator_rows(self, db_session):
        li = _row(db_session, url="https://linkedin.com/jobs/view/1",
                  source_platform="linkedin", board_key="",
                  last_seen_at=NOW - datetime.timedelta(days=10))
        count = sweep_stale(db_session, now=NOW)
        db_session.expire_all()
        assert count == 0
        assert db_session.get(ScrapedJob, li.id).listing_status == LISTING_ACTIVE

    def test_aggregator_expiry_by_age(self, db_session):
        old = _row(db_session, url="https://linkedin.com/jobs/view/1",
                   source_platform="linkedin", board_key="",
                   posted_date=NOW - datetime.timedelta(days=AGGREGATOR_MAX_AGE_DAYS + 1))
        recent = _row(db_session, url="https://linkedin.com/jobs/view/2",
                      source_platform="linkedin", board_key="",
                      posted_date=NOW - datetime.timedelta(days=3))
        direct = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/3",
                      posted_date=NOW - datetime.timedelta(days=200))
        count = sweep_aggregator_expiry(db_session, now=NOW)
        db_session.expire_all()
        assert count == 1
        assert db_session.get(ScrapedJob, old.id).listing_status == LISTING_EXPIRED
        assert db_session.get(ScrapedJob, recent.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, direct.id).listing_status == LISTING_ACTIVE

    def test_linkedin_expires_sooner_than_github(self, db_session):
        """LinkedIn/Indeed churn fast, so they age out at the shorter fast
        window; curated GitHub lists keep the longer window."""
        age = datetime.timedelta(days=AGGREGATOR_FAST_MAX_AGE_DAYS + 2)  # 23d
        assert AGGREGATOR_FAST_MAX_AGE_DAYS + 2 < AGGREGATOR_MAX_AGE_DAYS
        li = _row(db_session, url="https://www.linkedin.com/jobs/view/50",
                  source_platform="linkedin", board_key="", posted_date=NOW - age)
        gh = _row(db_session, url="https://careers.example.com/list-role/50",
                  source_platform="github", board_key="", posted_date=NOW - age)
        count = sweep_aggregator_expiry(db_session, now=NOW)
        db_session.expire_all()
        assert db_session.get(ScrapedJob, li.id).listing_status == LISTING_EXPIRED
        assert db_session.get(ScrapedJob, gh.id).listing_status == LISTING_ACTIVE
        assert count == 1


# ─── Ghost scoring ───────────────────────────────────────────────────────────

class TestGhostScoring:
    def test_long_open_evergreen_scores_high(self, db_session):
        row = _row(db_session,
                   first_seen_at=NOW - datetime.timedelta(days=100),
                   description="We are always accepting applications for this role.")
        score_ghost_risk(db_session, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, row.id)
        assert row.ghost_risk_score >= 65  # 40 (age>90) + 25 (evergreen)
        assert row.ghost_risk_factors["evergreen"] is True
        assert row.ghost_risk_factors["days_open"] == 100

    def test_fresh_normal_posting_scores_zero(self, db_session):
        row = _row(db_session, first_seen_at=NOW - datetime.timedelta(days=2),
                   description="One opening on the payments team, starting September.")
        score_ghost_risk(db_session, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, row.id)
        assert row.ghost_risk_score == 0
        assert row.ghost_risk_factors["evergreen"] is False

    def test_repost_signal(self, db_session):
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/old",
             title_norm="software intern", listing_status=LISTING_REMOVED)
        fresh = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/new",
                     title_norm="software intern",
                     first_seen_at=NOW - datetime.timedelta(days=1))
        score_ghost_risk(db_session, now=NOW)
        db_session.expire_all()
        fresh = db_session.get(ScrapedJob, fresh.id)
        assert fresh.ghost_risk_factors.get("reposts") == 1
        assert fresh.ghost_risk_score >= 20

    def test_rescore_pass_updates_aging_rows(self, db_session):
        row = _row(db_session,
                   first_seen_at=NOW - datetime.timedelta(days=GHOST_DAYS_OPEN + 20),
                   ghost_risk_score=0,
                   ghost_risk_factors={"evergreen": False,
                                       "scored_at": (NOW - datetime.timedelta(days=30)).isoformat()})
        stats = score_ghost_risk(db_session, now=NOW)
        db_session.expire_all()
        row = db_session.get(ScrapedJob, row.id)
        assert stats["rescored"] == 1
        assert row.ghost_risk_score >= 25  # age factor now applies

    def test_hidden_duplicates_not_scored(self, db_session):
        winner = _row(db_session)
        twin = _row(db_session, url="https://linkedin.com/jobs/view/9",
                    source_platform="linkedin", duplicate_of=winner.id,
                    first_seen_at=NOW - datetime.timedelta(days=100))
        score_ghost_risk(db_session, now=NOW)
        db_session.expire_all()
        assert db_session.get(ScrapedJob, twin.id).ghost_risk_score == 0


# ─── board_key derivation / backfill ─────────────────────────────────────────

class TestBoardKeyBackfill:
    def test_derivations(self):
        assert board_key_from_url("https://boards.greenhouse.io/stripe/jobs/1") == "greenhouse:stripe"
        assert board_key_from_url("https://job-boards.greenhouse.io/stripe/jobs/1") == "greenhouse:stripe"
        assert board_key_from_url("https://jobs.lever.co/spotify/abc") == "lever:spotify"
        assert board_key_from_url("https://jobs.ashbyhq.com/ramp/xyz") == "ashby:ramp"
        assert board_key_from_url("https://jobs.smartrecruiters.com/Visa/123-analyst") == "smartrecruiters:Visa"
        assert board_key_from_url("https://bmo.wd3.myworkdayjobs.com/external/job/x_R-1") == "workday:bmo"
        assert board_key_from_url("https://linkedin.com/jobs/view/1") == ""

    def test_backfill_adopts_and_marks_unknown(self, db_session):
        gh = _row(db_session, board_key="")
        weird = _row(db_session, url="https://careers.example.com/1", board_key="")
        adopted = backfill_board_keys(db_session)
        db_session.expire_all()
        assert adopted == 1
        assert db_session.get(ScrapedJob, gh.id).board_key == BOARD
        assert db_session.get(ScrapedJob, weird.id).board_key == "unknown"


# ─── cron-ats end to end ─────────────────────────────────────────────────────

class TestCronAtsFreshness:
    def _cron_headers(self, monkeypatch):
        import backend.auth.dependencies as auth_deps
        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        return {"x-cron-secret": "test-cron-secret"}

    def _mock_board(self, monkeypatch, jobs, all_urls=None, complete=True):
        from backend.data import company_registry
        from backend.services.ats_scraper import ATSScraper, BoardSnapshot

        monkeypatch.setattr(
            company_registry, "load_companies",
            lambda **kw: [("greenhouse", "acme", "Acme")],
        )

        async def fake_scrape_board(self, client, platform, slug, company_name):
            return BoardSnapshot(
                platform=platform, slug=slug, company=company_name,
                jobs=jobs, all_urls=all_urls if all_urls is not None
                else {j.url for j in jobs},
                complete=complete,
            )

        monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)

    def test_run_reconfirms_known_and_removes_vanished(self, client, db_session, monkeypatch):
        known = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/1")
        vanished = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2")
        self._mock_board(monkeypatch, [_job(url=known.url)])

        res = client.post("/github-sources/cron-ats", headers=self._cron_headers(monkeypatch))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["new_jobs"] == 0
        assert body["refreshed"] == 1
        assert body["removed"] == 1

        db_session.expire_all()
        assert db_session.get(ScrapedJob, known.id).last_seen_at > NOW - datetime.timedelta(minutes=5)
        assert db_session.get(ScrapedJob, vanished.id).listing_status == LISTING_REMOVED

    def test_new_job_inserted_with_freshness_fields(self, client, db_session, monkeypatch):
        job = _job(
            url="https://boards.greenhouse.io/acme/jobs/7",
            title="Platform Intern",
            description="Kubernetes and Go. Visa sponsorship is available. $40/hr.",
            external_id="777",
        )
        self._mock_board(monkeypatch, [job])

        res = client.post("/github-sources/cron-ats", headers=self._cron_headers(monkeypatch))
        assert res.json()["new_jobs"] == 1

        row = db_session.query(ScrapedJob).filter(ScrapedJob.url == job.url).one()
        assert row.board_key == BOARD
        assert row.external_id == "greenhouse:acme:777"
        assert row.listing_status == LISTING_ACTIVE
        assert row.first_seen_at is not None
        assert row.source_trust == "high"
        assert row.visa_sponsorship == "yes"
        assert "kubernetes" in (row.skills or [])
        assert row.salary_min == 40 and row.salary_period == "hour"

    def test_incomplete_snapshot_never_removes(self, client, db_session, monkeypatch):
        stored = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/1")
        self._mock_board(monkeypatch, [], all_urls=set(), complete=False)

        res = client.post("/github-sources/cron-ats", headers=self._cron_headers(monkeypatch))
        assert res.json()["removed"] == 0
        db_session.expire_all()
        assert db_session.get(ScrapedJob, stored.id).listing_status == LISTING_ACTIVE

    def test_circuit_breaker_skips_repeat_failer(self, client, db_session, monkeypatch):
        from backend.db.models import SourceHealth
        from backend.services.source_health import FAILURE_THRESHOLD

        db_session.add(SourceHealth(
            board_key=BOARD, platform="greenhouse", slug="acme",
            consecutive_failures=FAILURE_THRESHOLD,
            last_failure_at=datetime.datetime.utcnow() - datetime.timedelta(hours=1),
        ))
        db_session.commit()

        called = []

        def _mock(monkeypatch=monkeypatch):
            from backend.data import company_registry
            from backend.services.ats_scraper import ATSScraper, BoardSnapshot
            monkeypatch.setattr(
                company_registry, "load_companies",
                lambda **kw: [("greenhouse", "acme", "Acme")],
            )

            async def fake_scrape_board(self, client, platform, slug, company_name):
                called.append(slug)
                return BoardSnapshot(platform=platform, slug=slug, company=company_name)

            monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)

        _mock()
        res = client.post("/github-sources/cron-ats", headers=self._cron_headers(monkeypatch))
        assert res.json()["boards_skipped_cooldown"] == 1
        assert called == []

    def test_board_failure_recorded(self, client, db_session, monkeypatch):
        from backend.db.models import SourceHealth
        from backend.data import company_registry
        from backend.services.ats_scraper import ATSScraper

        monkeypatch.setattr(
            company_registry, "load_companies",
            lambda **kw: [("greenhouse", "acme", "Acme")],
        )

        async def exploding_scrape_board(self, client, platform, slug, company_name):
            raise RuntimeError("board renamed")

        monkeypatch.setattr(ATSScraper, "scrape_board", exploding_scrape_board)
        res = client.post("/github-sources/cron-ats", headers=self._cron_headers(monkeypatch))
        assert res.json()["boards_failed"] == 1

        health = db_session.query(SourceHealth).filter_by(board_key=BOARD).one()
        assert health.consecutive_failures == 1
        assert "board renamed" in health.last_error


# ─── URL liveness verification (dead list links) ─────────────────────────────

class _StatusTransport:
    """httpx transport answering a fixed status per URL fragment."""

    def __init__(self, statuses: dict):
        self.statuses = statuses

    async def handle(self, request):
        import httpx
        for fragment, status in self.statuses.items():
            if fragment in str(request.url):
                return httpx.Response(status, text="page")
        return httpx.Response(200, text="page")


def _status_client(statuses: dict):
    import httpx

    class T(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return await _StatusTransport(statuses).handle(request)

    return httpx.AsyncClient(transport=T())


def _body_client(mapping: dict):
    """httpx client answering (status, body) per URL fragment; default 200 'ok'.
    Lets a test drive the soft-404 body check, not just the status code."""
    import httpx

    class T(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            for fragment, (status, body) in mapping.items():
                if fragment in str(request.url):
                    return httpx.Response(status, text=body)
            return httpx.Response(200, text="ok")

    return httpx.AsyncClient(transport=T())


class TestUrlLiveness:
    @pytest.mark.asyncio
    async def test_probe_verdicts(self):
        from backend.services.listing_freshness import probe_url_liveness
        async with _status_client({"/dead": 404, "/gone": 410, "/wall": 403,
                                   "/live": 200}) as client:
            assert await probe_url_liveness(client, "https://x.test/dead") == "dead"
            assert await probe_url_liveness(client, "https://x.test/gone") == "dead"
            # Bot walls are not evidence of death — a real browser gets through.
            assert await probe_url_liveness(client, "https://x.test/wall") == "unknown"
            assert await probe_url_liveness(client, "https://x.test/live") == "alive"

    @pytest.mark.asyncio
    async def test_soft_404_body_only_trusted_hosts(self):
        """A 200 that says 'no longer accepting applications' is dead on a
        server-rendered host (LinkedIn); the same phrase on an arbitrary career
        SPA is ignored (that message renders client-side there, so a real 200
        body carrying it would be a false match)."""
        from backend.services.listing_freshness import probe_url_liveness
        closed = "<h1>Sorry, this job is no longer accepting applications.</h1>"
        live = "<h1>Software Intern — Apply now</h1>"
        async with _body_client({
            "linkedin.com/jobs/view/1": (200, closed),
            "linkedin.com/jobs/view/2": (200, live),
            "spa-careers.example/1": (200, closed),
        }) as client:
            assert await probe_url_liveness(client, "https://www.linkedin.com/jobs/view/1") == "dead"
            assert await probe_url_liveness(client, "https://www.linkedin.com/jobs/view/2") == "alive"
            assert await probe_url_liveness(client, "https://spa-careers.example/1") == "alive"

    @pytest.mark.asyncio
    async def test_verify_recent_removes_dead_github_rows(self, db_session):
        from backend.services.listing_freshness import verify_recent_aggregator_listings

        dead = _row(db_session, url="https://careers.example.com/jobs/dead",
                    source_platform="github", board_key="", last_seen_at=None)
        alive = _row(db_session, url="https://careers.example.com/jobs/alive",
                     source_platform="github", board_key="", last_seen_at=None)
        walled = _row(db_session, url="https://careers.example.com/jobs/wall",
                      source_platform="github", board_key="", last_seen_at=None)
        ats = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/dead2",
                   last_seen_at=None)  # ats rows are the board's job, not this sweep's

        async with _status_client({"/jobs/dead": 404, "/jobs/wall": 403}) as client:
            stats = await verify_recent_aggregator_listings(db_session, client, now=NOW)

        db_session.expire_all()
        assert stats["removed"] == 1
        assert db_session.get(ScrapedJob, dead.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, alive.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, alive.id).last_seen_at == NOW
        assert db_session.get(ScrapedJob, walled.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, ats.id).listing_status == LISTING_ACTIVE

    @pytest.mark.asyncio
    async def test_verify_recent_skips_recently_probed(self, db_session):
        from backend.services.listing_freshness import verify_recent_aggregator_listings

        _row(db_session, url="https://careers.example.com/jobs/dead",
             source_platform="github", board_key="",
             last_seen_at=NOW - datetime.timedelta(hours=1))

        async with _status_client({"/jobs/dead": 404}) as client:
            stats = await verify_recent_aggregator_listings(db_session, client, now=NOW)
        assert stats["checked"] == 0

    @pytest.mark.asyncio
    async def test_verify_recent_covers_soft_dead_linkedin(self, db_session):
        """Active LinkedIn rows (never covered by the old github-only sweep) get
        probed; a soft-404 guest page removes them, a live one is stamped."""
        from backend.services.listing_freshness import verify_recent_aggregator_listings

        dead_li = _row(db_session, url="https://www.linkedin.com/jobs/view/10",
                       source_platform="linkedin", board_key="", last_seen_at=None)
        live_li = _row(db_session, url="https://www.linkedin.com/jobs/view/20",
                       source_platform="linkedin", board_key="", last_seen_at=None)
        async with _body_client({
            "/jobs/view/10": (200, "No longer accepting applications"),
            "/jobs/view/20": (200, "Apply now — role is open"),
        }) as client:
            stats = await verify_recent_aggregator_listings(db_session, client, now=NOW)

        db_session.expire_all()
        assert db_session.get(ScrapedJob, dead_li.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, live_li.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, live_li.id).last_seen_at == NOW
        assert stats["removed"] == 1


class TestVerifyStaleListings:
    @pytest.mark.asyncio
    async def test_dead_removes_anywhere_alive_revives_only_honest_hosts(self, db_session):
        from backend.services.listing_freshness import verify_stale_listings

        dead_site = _row(db_session, url="https://careers.example.com/jobs/1",
                         listing_status=LISTING_STALE, last_seen_at=None)
        live_gh = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2",
                       listing_status=LISTING_STALE, last_seen_at=None)
        spa_site = _row(db_session, url="https://careers.spa-co.com/jobs/3",
                        listing_status=LISTING_STALE, last_seen_at=None)
        walled_li = _row(db_session, url="https://linkedin.com/jobs/view/4",
                         source_platform="linkedin", board_key="",
                         listing_status=LISTING_STALE, last_seen_at=None)

        async with _status_client({"careers.example.com": 404}) as client:
            stats = await verify_stale_listings(db_session, client, now=NOW)

        db_session.expire_all()
        # Honest 404 on a plain company site → removed.
        assert db_session.get(ScrapedJob, dead_site.id).listing_status == LISTING_REMOVED
        # 200 on greenhouse (honest host) → revived.
        assert db_session.get(ScrapedJob, live_gh.id).listing_status == LISTING_ACTIVE
        # 200 on an arbitrary site proves nothing — stays stale, probe stamped.
        spa = db_session.get(ScrapedJob, spa_site.id)
        assert spa.listing_status == LISTING_STALE
        assert spa.last_seen_at == NOW
        # LinkedIn IS now probed (guest page), but a live one (no dead banner)
        # is never revived on a bare 200 — it stays stale with last_seen stamped.
        li = db_session.get(ScrapedJob, walled_li.id)
        assert li.listing_status == LISTING_STALE
        assert li.last_seen_at == NOW
        assert stats["removed"] == 1 and stats["revived"] == 1

    @pytest.mark.asyncio
    async def test_soft_dead_linkedin_stale_row_removed(self, db_session):
        """A stale LinkedIn row whose guest page shows the closed banner is
        removed (the 57%-dead cohort the old probe skipped entirely)."""
        from backend.services.listing_freshness import verify_stale_listings

        dead_li = _row(db_session, url="https://www.linkedin.com/jobs/view/900",
                       source_platform="linkedin", board_key="",
                       listing_status=LISTING_STALE, last_seen_at=None)
        async with _body_client({
            "/jobs/view/900": (200, "This job is no longer accepting applications."),
        }) as client:
            stats = await verify_stale_listings(db_session, client, now=NOW)

        db_session.expire_all()
        assert db_session.get(ScrapedJob, dead_li.id).listing_status == LISTING_REMOVED
        assert stats["removed"] == 1


class TestAggregatorIngestProbe:
    def test_dead_url_stored_as_removed(self, db_session):
        """A list row whose apply URL already 404s must never surface."""
        from backend.services.aggregator import AggregatorService
        from backend.services.markdown_parser import ParsedJob
        from backend.db.models import GitHubSource

        source = GitHubSource(repo_url="https://github.com/x/newgrad", repo_owner="x",
                              repo_name="New-Grad-Positions", role_category="software")
        db_session.add(source)
        db_session.commit()

        svc = AggregatorService(db_session)
        job = ParsedJob(title="Software Engineer, New Grad", company="DeadCo",
                        location="Toronto, ON, Canada",
                        url="https://careers.deadco.com/jobs/1")
        stored = svc._classify_and_store(job, source,
                                         dead_urls={"https://careers.deadco.com/jobs/1"})
        assert stored is False

        row = db_session.query(ScrapedJob).filter(
            ScrapedJob.url == "https://careers.deadco.com/jobs/1").one()
        assert row.listing_status == LISTING_REMOVED
        assert row.first_seen_at is not None
        assert row.source_trust == "medium"

    def test_live_url_stored_active_with_freshness_stamps(self, db_session):
        from backend.services.aggregator import AggregatorService
        from backend.services.markdown_parser import ParsedJob
        from backend.db.models import GitHubSource

        source = GitHubSource(repo_url="https://github.com/x/newgrad2", repo_owner="x",
                              repo_name="New-Grad-Positions", role_category="software")
        db_session.add(source)
        db_session.commit()

        svc = AggregatorService(db_session)
        job = ParsedJob(title="Software Engineer, New Grad", company="LiveCo",
                        location="Toronto, ON, Canada",
                        url="https://careers.liveco.com/jobs/1")
        assert svc._classify_and_store(job, source) is True

        row = db_session.query(ScrapedJob).filter(
            ScrapedJob.url == "https://careers.liveco.com/jobs/1").one()
        assert row.listing_status == LISTING_ACTIVE
        assert row.last_seen_at is not None
        assert row.source_trust == "medium"


# ─── migration ───────────────────────────────────────────────────────────────

def test_ingestion_freshness_migration_idempotent():
    from sqlalchemy import inspect as sa_inspect
    from backend.db.database import engine
    from backend.migrations.add_ingestion_freshness import run_migration

    run_migration()
    run_migration()  # second run must be a no-op
    cols = {c["name"] for c in sa_inspect(engine).get_columns("scraped_jobs")}
    assert {"listing_status", "first_seen_at", "last_seen_at", "board_key",
            "external_id", "raw_hash", "edit_count", "change_log",
            "ghost_risk_score", "ghost_risk_factors", "source_trust",
            "salary_min", "salary_max", "salary_currency", "salary_period",
            "employment_type", "visa_sponsorship", "skills"} <= cols


# ─── cron-freshness + metrics endpoints ──────────────────────────────────────

class TestFreshnessEndpoints:
    def _cron_headers(self, monkeypatch):
        import backend.auth.dependencies as auth_deps
        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        return {"x-cron-secret": "test-cron-secret"}

    def test_cron_freshness_sweeps_and_scores(self, client, db_session, monkeypatch):
        aged = _row(db_session, url="https://linkedin.com/jobs/view/9",
                    source_platform="linkedin", board_key="",
                    posted_date=datetime.datetime.utcnow() - datetime.timedelta(days=60),
                    scraped_at=datetime.datetime.utcnow() - datetime.timedelta(days=60))
        res = client.post("/jobs/cron-freshness", headers=self._cron_headers(monkeypatch))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["expired"] == 1
        assert body["ghost_scoring"]["scored_new"] >= 0
        db_session.expire_all()
        assert db_session.get(ScrapedJob, aged.id).listing_status == LISTING_EXPIRED

    def test_ingest_metrics_shape(self, client, db_session, monkeypatch):
        from backend.db.models import SourceHealth
        _row(db_session)
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2",
             listing_status=LISTING_REMOVED,
             listing_status_changed_at=datetime.datetime.utcnow())
        db_session.add(SourceHealth(board_key="lever:broken", platform="lever",
                                    slug="broken", consecutive_failures=3,
                                    last_error="HTTP 404"))
        db_session.commit()

        res = client.get("/jobs/ingest-metrics", headers=self._cron_headers(monkeypatch))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["by_listing_status"]["active"] == 1
        assert body["by_listing_status"]["removed"] == 1
        assert body["removed_24h"] == 1
        assert body["active_total"] == 1
        assert body["failing_boards"][0]["board_key"] == "lever:broken"
        assert "median_active_age_days" in body
        assert "dedup_rate" in body


# ─── API visibility ──────────────────────────────────────────────────────────

class TestListVisibility:
    def test_removed_and_expired_hidden_from_catalogue(self, client, db_session):
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/1")
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2",
             listing_status=LISTING_REMOVED)
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/3",
             listing_status=LISTING_EXPIRED)
        _row(db_session, url="https://boards.greenhouse.io/acme/jobs/4",
             listing_status=LISTING_STALE)

        res = client.get("/jobs")
        assert res.status_code == 200
        urls = {j["url"] for j in res.json()}
        assert "https://boards.greenhouse.io/acme/jobs/1" in urls
        assert "https://boards.greenhouse.io/acme/jobs/2" not in urls
        assert "https://boards.greenhouse.io/acme/jobs/3" not in urls
        # stale is a crawl-lag state, not evidence of death — stays visible
        assert "https://boards.greenhouse.io/acme/jobs/4" in urls

    def test_saved_view_keeps_removed_jobs(self, client, db_session):
        removed = _row(db_session, url="https://boards.greenhouse.io/acme/jobs/2",
                       listing_status=LISTING_REMOVED)
        db_session.add(User(id=1, email="t@t.co", hashed_password="x"))
        db_session.add(UserSavedJob(user_id=1, job_id=removed.id))
        db_session.commit()

        res = client.get("/jobs?saved=1")
        assert res.status_code == 200
        assert {j["id"] for j in res.json()} == {removed.id}

    def test_listing_fields_serialized(self, client, db_session):
        _row(db_session, ghost_risk_score=45, salary_min=90000, salary_max=110000,
             salary_currency="CAD", salary_period="year", visa_sponsorship="yes",
             employment_type="internship", skills=["python"], source_trust="high")
        res = client.get("/jobs")
        job = res.json()[0]
        assert job["listing_status"] == "active"
        assert job["ghost_risk_score"] == 45
        assert job["salary_min"] == 90000
        assert job["visa_sponsorship"] == "yes"
        assert job["skills"] == ["python"]
        assert job["source_trust"] == "high"
        assert job["last_seen_at"] is not None
