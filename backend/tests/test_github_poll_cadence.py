"""
Poll cadence for GitHub-list sources: lists that can't feed the catalogue
(vendor-only links, no job table) park themselves and stop taking cron-poll
slots; quiet lists poll daily; a parser revision re-parses unchanged READMEs;
cron-poll's phases are time-boxed inside Vercel's 300 s.

No network: GitHub and job hosts are served by httpx.MockTransport.
"""

import asyncio
import datetime
import time

import pytest

from backend.db.models import GitHubSource, ScrapedJob
from backend.services.aggregator import (
    ACTIVE_POLL_MINUTES,
    DORMANT_POLL_MINUTES,
    PARKED_RECHECK,
    PARSE_REVISION,
    STATUS_PARKED,
    AggregatorService,
    is_retryable_error,
    source_url,
)
from backend.tests.test_github_list_fixes import NOW, README, _commits, _row, _source, github  # noqa: F401

JOBRIGHT_README = (
    "| Company | Job Title | Location | Work Model | Date Posted |\n"
    "| ----- | --------- | --------- | ---- | ------- |\n"
    "| **[JT4](https://www.jt4llc.com/)** | **[Computer Scientist I](https://jobright.ai/jobs/info/6abb?utm_source=1103)** "
    "| Lancaster, CA, United States | On Site | Sep 26 |\n"
    "| **[NCDA](http://ncagr.gov)** | **[Programmer Analyst](https://jobright.ai/jobs/info/6aba?utm_source=1103)** "
    "| Santa Rosa, CA, United States | On Site | Sep 26 |\n"
)
REPO = "jobright-ai/2026-Software-Engineer-New-Grad"
STAMPED = f"abc@r{PARSE_REVISION}"


def _routes(github, repo, readme, sha="s1", when="2026-09-27T12:00:00Z"):
    github["routes"].update({
        f"/repos/{repo}/commits?per_page=1": (200, _commits(sha, when)),
        f"/repos/{repo}/contents/README.md": (200, readme),
    })


class TestParking:
    @pytest.mark.asyncio
    async def test_vendor_only_list_is_parked_and_skipped_until_recheck(self, db_session, github):
        source = _source(db_session, url=f"https://github.com/{REPO}")
        _routes(github, REPO, JOBRIGHT_README)
        svc = AggregatorService(db_session)

        assert await svc.poll_source(source) == 0

        db_session.refresh(source)
        assert source.status == STATUS_PARKED
        assert "none of 2 open rows links to an employer" in source.error_message
        assert db_session.query(ScrapedJob).count() == 0
        polled = source.last_polled_at
        assert svc.sources_due(now=polled + datetime.timedelta(days=6)) == []
        assert svc.sources_due(now=polled + PARKED_RECHECK) == [source]

    @pytest.mark.asyncio
    async def test_unchanged_parked_list_stays_parked(self, db_session, github):
        source = _source(db_session, url=f"https://github.com/{REPO}")
        _routes(github, REPO, JOBRIGHT_README)
        svc = AggregatorService(db_session)
        await svc.poll_source(source)
        calls = len(github["calls"])

        await svc.poll_source(source)  # same SHA, same revision

        db_session.refresh(source)
        assert source.status == STATUS_PARKED
        # Only the commits check ran: no README download.
        assert [c for c in github["calls"][calls:] if "contents/README.md" in c] == []

    @pytest.mark.asyncio
    async def test_parked_list_that_gains_direct_links_is_active_again(self, db_session, github):
        source = _source(db_session, url=f"https://github.com/{REPO}")
        _routes(github, REPO, JOBRIGHT_README)
        svc = AggregatorService(db_session)
        await svc.poll_source(source)

        _routes(github, REPO, README, sha="s2")
        assert await svc.poll_source(source) == 1

        db_session.refresh(source)
        assert (source.status, source.error_message) == ("active", "")

    @pytest.mark.asyncio
    async def test_list_with_no_job_table_is_parked(self, db_session, github):
        source = _source(db_session, url="https://github.com/zapplyjobs/underclassmen-internships")
        _routes(github, "zapplyjobs/underclassmen-internships", "## Internships\n- [Google STEP](https://x.io)\n")

        await AggregatorService(db_session).poll_source(source)

        db_session.refresh(source)
        assert source.status == STATUS_PARKED
        assert "no job table" in source.error_message

    @pytest.mark.asyncio
    async def test_list_with_visible_rows_is_never_parked_by_one_parse(self, db_session, github):
        source = _source(db_session, url=f"https://github.com/{REPO}")
        _row(db_session, source, "https://jobs.lever.co/acme/1")
        _routes(github, REPO, JOBRIGHT_README)

        await AggregatorService(db_session).poll_source(source)

        db_session.refresh(source)
        assert source.status == "active"


class TestCadence:
    @pytest.mark.asyncio
    async def test_quiet_list_polls_daily_busy_list_hourly(self, db_session, github):
        svc = AggregatorService(db_session)
        quiet = _source(db_session, url="https://github.com/vanshb03/New-Grad-2027")
        _routes(github, "vanshb03/New-Grad-2027", README, when="2026-08-21T15:30:41Z")
        busy = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        _routes(github, "speedyapply/2027-SWE-College-Jobs", README, when="2026-09-27T12:00:00Z")

        await svc.poll_source(quiet)
        await svc.poll_source(busy)

        db_session.refresh(quiet)
        db_session.refresh(busy)
        assert quiet.poll_interval_minutes == DORMANT_POLL_MINUTES
        assert busy.poll_interval_minutes == ACTIVE_POLL_MINUTES
        later = max(quiet.last_polled_at, busy.last_polled_at) + datetime.timedelta(hours=3)
        assert svc.sources_due(now=later) == [busy]
        assert set(svc.sources_due(now=later + datetime.timedelta(days=1))) == {quiet, busy}

    def test_parked_lists_only_take_the_slots_left_over(self, db_session):
        # The first pass after a deploy parks ~36 lists within a few runs, so
        # a week later they all come due together, and a day overdue. They
        # must not take the slots of the lists that feed the catalogue.
        now = datetime.datetime(2026, 9, 29, 12)
        for i in range(36):
            _source(db_session, url=f"https://github.com/jobright-ai/list-{i}", status=STATUS_PARKED,
                    last_polled_at=now - PARKED_RECHECK - datetime.timedelta(days=1),
                    last_commit_sha=STAMPED)
        busy = [
            _source(db_session, url=f"https://github.com/lists/busy-{i}",
                    last_polled_at=now - datetime.timedelta(hours=3), last_commit_sha=STAMPED)
            for i in range(3)
        ]

        due = AggregatorService(db_session).sources_due(limit=5, now=now)

        assert due[:3] == busy
        assert [s.status for s in due[3:]] == [STATUS_PARKED, STATUS_PARKED]

    def test_permanent_error_is_never_due_even_unpolled(self, db_session):
        # Prod ids 31/34/48: typo'd jobright URLs that 404ed before a poll
        # ever completed (last_polled_at NULL). Never polled again.
        _source(db_session, url="https://github.com/jobright-ai/2026-Accounting-Internship",
                status="error", error_message="HTTP 404: Client error '404 Not Found'")
        retry = _source(db_session, url="https://github.com/a/gateway", status="error",
                        error_message="HTTP 504: Gateway Timeout")

        assert AggregatorService(db_session).sources_due(now=NOW) == [retry]


class TestParseRevision:
    @pytest.mark.asyncio
    async def test_old_revision_reparses_an_unchanged_readme(self, db_session, github):
        # Stored by the parser before revisions existed (a bare SHA): the same
        # commit is parsed again under the current rules.
        source = _source(db_session, url="https://github.com/vanshb03/New-Grad-2027", last_commit_sha="s1",
                         last_polled_at=NOW - datetime.timedelta(minutes=5))
        _routes(github, "vanshb03/New-Grad-2027", README, sha="s1")
        svc = AggregatorService(db_session)
        assert svc.sources_due(now=NOW) == [source]

        assert await svc.poll_source(source) == 1

        db_session.refresh(source)
        assert source.last_commit_sha == f"s1@r{PARSE_REVISION}"
        assert svc.sources_due(now=NOW) == []


INTL_README = (
    "| Company | Position | Location | Posting | Age |\n"
    "|---|---|---|---|---|\n"
    '| <a href="https://robinhood.com"><strong>Robinhood</strong></a> | Software Developer Intern - iOS | '
    'Toronto, Canada | <a href="https://boards.greenhouse.io/robinhood/jobs/8199729?t=gh_src=&gh_jid=8199729">'
    '<img alt="Apply"/></a> | 2d |\n'
    '| <a href="https://acme.io"><strong>Acme</strong></a> | Software Engineer Intern | Remote - Poland | '
    '<a href="https://jobs.lever.co/acme/1"><img alt="Apply"/></a> | 2d |\n'
    '| <a href="https://acme.io"><strong>Acme</strong></a> | Backend Intern | Tbilisi, Georgia | '
    '<a href="https://jobs.lever.co/acme/2"><img alt="Apply"/></a> | 2d |\n'
)


class TestPerFileSources:
    def test_seed_list_reads_speedyapply_files(self):
        by_url = {source_url(r["url"], r.get("file_path", "README.md")): r for r in AggregatorService.REPOS}
        swe = "https://github.com/speedyapply/2027-SWE-College-Jobs/blob/HEAD/"
        ai = "https://github.com/speedyapply/2027-AI-College-Jobs"
        assert by_url[swe + "NEW_GRAD_USA.md"]["level"] == "new_grad"
        assert by_url[ai]["level"] == "internship"
        assert by_url[ai + "/blob/HEAD/NEW_GRAD_USA.md"]["level"] == "new_grad"
        # The international files hold mostly non-North-American roles.
        for url in (swe + "INTERN_INTL.md", swe + "NEW_GRAD_INTL.md",
                    ai + "/blob/HEAD/INTERN_INTL.md", ai + "/blob/HEAD/NEW_GRAD_INTL.md"):
            assert by_url[url]["countries"] == ["CA"]
        assert len(by_url) == len(AggregatorService.REPOS)  # one source per file

    @pytest.mark.asyncio
    async def test_seed_creates_one_source_per_file(self, db_session):
        svc = AggregatorService(db_session)
        svc.REPOS = [
            {"url": "https://github.com/speedyapply/2027-SWE-College-Jobs", "category": "", "level": "internship"},
            {"url": "https://github.com/speedyapply/2027-SWE-College-Jobs", "file_path": "INTERN_INTL.md",
             "countries": ["CA"], "category": "", "level": "internship"},
        ]
        assert (await svc.seed_sources())["created"] == 2
        assert (await svc.seed_sources())["created"] == 0
        by_file = {s.file_path: s for s in db_session.query(GitHubSource)}
        assert by_file["README.md"].repo_url == "https://github.com/speedyapply/2027-SWE-College-Jobs"
        assert by_file["INTERN_INTL.md"].repo_url == \
            "https://github.com/speedyapply/2027-SWE-College-Jobs/blob/HEAD/INTERN_INTL.md"
        assert by_file["INTERN_INTL.md"].repo_name == "2027-SWE-College-Jobs"

    @pytest.mark.asyncio
    async def test_international_file_is_read_for_canada_only(self, db_session, github):
        svc = AggregatorService(db_session)
        svc.REPOS = [{"url": "https://github.com/speedyapply/2027-SWE-College-Jobs", "file_path": "INTERN_INTL.md",
                      "countries": ["CA"], "category": "", "level": "internship"}]
        await svc.seed_sources()
        source = db_session.query(GitHubSource).one()
        repo = "speedyapply/2027-SWE-College-Jobs"
        github["routes"].update({
            # Only commits that touch this file count as a change.
            f"/repos/{repo}/commits?per_page=1&path=INTERN_INTL.md": (200, _commits("s1", "2026-09-27T12:00:00Z")),
            f"/repos/{repo}/contents/INTERN_INTL.md": (200, INTL_README),
        })

        assert await svc.poll_source(source) == 1

        [row] = db_session.query(ScrapedJob).all()
        assert (row.company, row.country) == ("Robinhood", "CA")
        # Kept byte for byte: the board crawl stores this exact spelling.
        assert row.url == "https://boards.greenhouse.io/robinhood/jobs/8199729?t=gh_src=&gh_jid=8199729"

    def test_country_allowlist_survives_a_repo_rename(self, db_session):
        # speedyapply renames every season; the source adopts the new name on
        # its next poll, before anyone adds it to REPOS.
        source = GitHubSource(repo_url="https://github.com/speedyapply/2028-SWE-College-Jobs/blob/HEAD/INTERN_INTL.md",
                              repo_owner="speedyapply", repo_name="2028-SWE-College-Jobs",
                              file_path="INTERN_INTL.md", status="active")
        svc = AggregatorService(db_session)

        assert svc._allowed_countries(source) == frozenset({"CA"})
        # The README of the same repo stays unrestricted.
        readme = GitHubSource(repo_url="https://github.com/speedyapply/2028-SWE-College-Jobs",
                              repo_owner="speedyapply", repo_name="2028-SWE-College-Jobs",
                              file_path="README.md", status="active")
        assert svc._allowed_countries(readme) == frozenset()


class TestRotationOrder:
    def test_after_a_revision_bump_lists_with_rows_go_first(self, db_session):
        now = datetime.datetime(2026, 9, 29, 12)
        polled = now - datetime.timedelta(hours=1)
        # Bare SHAs: parsed before PARSE_REVISION existed, as every prod source was.
        empty = _source(db_session, url="https://github.com/jobright-ai/a",
                        last_polled_at=polled - datetime.timedelta(days=1), last_commit_sha="abc")
        busy = _source(db_session, url="https://github.com/speedyapply/b", last_polled_at=polled,
                       last_commit_sha="def")
        _row(db_session, busy, "https://jobs.lever.co/acme/1")

        assert AggregatorService(db_session).sources_due(limit=1, now=now) == [busy]
        assert AggregatorService(db_session).sources_due(limit=2, now=now) == [busy, empty]


class TestEnrichDeadline:
    @pytest.mark.asyncio
    async def test_no_description_fetch_starts_past_the_deadline(self, db_session, github):
        source = _source(db_session)
        _row(db_session, source, "https://jobs.lever.co/acme/1")

        late = AggregatorService(db_session, deadline=time.monotonic() - 1)
        assert await late._enrich_missing_descriptions(None, limit=40) == 0
        assert github["calls"] == []

        on_time = AggregatorService(db_session, deadline=time.monotonic() + 60)
        await on_time._enrich_missing_descriptions(None, limit=40)
        assert github["calls"]  # the same row is fetched before the deadline


# ─── cron-poll wall clock ────────────────────────────────────────────────────

@pytest.fixture
def cron(client, db_session, monkeypatch):
    """cron-poll with the aggregator's network steps stubbed. Returns a
    namespace whose ``poll`` / ``alerts`` the test may replace."""
    import backend.auth.dependencies as auth_deps
    from backend.services import match_notifier

    monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
    state = {"polled": [], "poll_seconds": 0.0, "alert_seconds": 0.0}

    async def no_seed(self):
        return {"created": 0, "existing": 0}

    async def fake_poll(self, source):
        state["polled"].append(source.repo_url)
        await asyncio.sleep(state["poll_seconds"])
        return 0

    async def no_enrich(self, source_id=None, limit=10):
        return 0

    async def alerts(db):
        await asyncio.sleep(state["alert_seconds"])
        return {"status": "completed"}

    monkeypatch.setattr(AggregatorService, "seed_sources", no_seed)
    monkeypatch.setattr(AggregatorService, "poll_source", fake_poll)
    monkeypatch.setattr(AggregatorService, "_enrich_missing_descriptions", no_enrich)
    monkeypatch.setattr(match_notifier, "sweep_match_alerts", alerts)

    def post():
        started = time.monotonic()
        resp = client.post("/github-sources/cron-poll", headers={"x-cron-secret": "test-cron-secret"})
        assert resp.status_code == 200, resp.text
        return resp.json(), time.monotonic() - started

    state["post"] = post
    return state


class TestCronPollBudget:
    def test_spent_budget_leaves_the_rest_for_the_next_run(self, cron, db_session, monkeypatch):
        from backend.routers import github_sources as router

        monkeypatch.setattr(router, "CRON_POLL_BUDGET_SECONDS", 0.0)
        for i in range(3):
            _source(db_session, url=f"https://github.com/lists/l{i}")

        body, _ = cron["post"]()

        assert len(cron["polled"]) == 1  # always at least one
        assert (body["sources_polled"], body["sources_due"]) == (1, 3)
        assert set(body["timings"]) == {"seed", "poll", "enrich", "dedup", "total"}

    def test_per_run_source_limit(self, cron, db_session, monkeypatch):
        from backend.routers import github_sources as router

        monkeypatch.setattr(router, "CRON_POLL_MAX_SOURCES", 2)
        for i in range(3):
            _source(db_session, url=f"https://github.com/lists/l{i}")

        body, _ = cron["post"]()

        assert (body["sources_polled"], body["sources_due"]) == (2, 3)

    def test_hung_source_is_cut_off_at_the_hard_stop(self, cron, db_session, monkeypatch):
        from backend.routers import github_sources as router

        monkeypatch.setattr(router, "CRON_POLL_HARD_STOP_SECONDS", 0.3)
        cron["poll_seconds"] = 30
        hung = _source(db_session, url="https://github.com/lists/hung")
        _source(db_session, url="https://github.com/lists/next")

        body, seconds = cron["post"]()

        assert seconds < 10
        [cut] = body["polled"]
        assert (cut["source"], cut["new_jobs"], cut["timed_out"]) == ("hung", 0, True)
        assert cut["seconds"] < 10
        assert body["match_alerts"] == {"status": "completed"}  # the sweep still ran
        db_session.expire_all()
        hung = db_session.get(GitHubSource, hung.id)
        # Rotation advances (it is not first in line forever) and the source
        # stays in rotation: a timeout is a retryable failure.
        assert hung.last_polled_at is not None
        assert hung.status == "active" and is_retryable_error(hung.error_message)

    def test_match_sweep_is_cut_off_at_the_wall_clock(self, cron, monkeypatch):
        from backend.routers import github_sources as router

        monkeypatch.setattr(router, "CRON_POLL_WALL_SECONDS", 0.3)
        cron["alert_seconds"] = 30

        body, seconds = cron["post"]()

        assert seconds < 10
        assert body["match_alerts"]["status"] == "timed_out"

    def test_match_sweep_skipped_once_the_wall_clock_is_spent(self, cron, monkeypatch):
        from backend.routers import github_sources as router

        monkeypatch.setattr(router, "CRON_POLL_WALL_SECONDS", 0.0)

        body, _ = cron["post"]()

        assert body["match_alerts"]["status"] == "skipped"

    def test_list_copies_are_hidden_by_cron_poll(self, cron, db_session):
        from backend.services.cross_source_dedup import normalize_title

        rows = {}
        for platform, url in (
            ("ats", "https://ciena.wd5.myworkdayjobs.com/careers/job/Ottawa/ASIC-Engineer-Intern_R031750"),
            ("github", "https://ciena.wd5.myworkdayjobs.com/Careers/job/Ottawa/ASIC-Engineer-Intern_R031750"),
        ):
            row = ScrapedJob(title="ASIC Engineer Intern", company="Ciena", location="Ottawa, ON", url=url,
                             description="", source_platform=platform, listing_status="active",
                             title_norm=normalize_title("ASIC Engineer Intern"))
            db_session.add(row)
            db_session.commit()
            rows[platform] = row.id

        body, _ = cron["post"]()

        assert (body["list_copies_hidden"], body["list_copies_released"]) == (1, 0)
        db_session.expire_all()
        assert db_session.get(ScrapedJob, rows["github"]).duplicate_of == rows["ats"]

        # The board row ages out: the next run gives the list copy back.
        db_session.get(ScrapedJob, rows["ats"]).listing_status = "expired"
        db_session.commit()

        body, _ = cron["post"]()

        assert (body["list_copies_hidden"], body["list_copies_released"]) == (0, 1)
        db_session.expire_all()
        assert db_session.get(ScrapedJob, rows["github"]).duplicate_of is None

    def test_default_budgets_leave_headroom_under_vercels_limit(self):
        from backend.routers import github_sources as router

        assert router.CRON_POLL_BUDGET_SECONDS < router.CRON_POLL_HARD_STOP_SECONDS
        assert router.CRON_POLL_ENRICH_UNTIL_SECONDS < router.CRON_POLL_HARD_STOP_SECONDS
        # A description fetch started just before the enrichment deadline
        # (15 s timeout) still ends before the sweep's own cut-off.
        assert router.CRON_POLL_HARD_STOP_SECONDS + 30 <= router.CRON_POLL_WALL_SECONDS
        # A synchronous email send in flight when the sweep is cut (the Resend
        # SDK's 30 s timeout) still ends 30 s before the workflow's curl gives up.
        assert router.CRON_POLL_WALL_SECONDS + 30 <= 300 - 30


# ─── admin endpoints ─────────────────────────────────────────────────────────

@pytest.fixture
def admin(client):
    from backend.auth.dependencies import get_admin_user_id
    from backend.main import app

    async def admin_id():
        return 1

    app.dependency_overrides[get_admin_user_id] = admin_id
    yield client
    app.dependency_overrides.pop(get_admin_user_id, None)


class TestAdminEndpoints:
    def test_poll_now_goes_through_the_ingest_filters(self, admin, db_session, github):
        # It used to run the old GitHubScraper: no vendor-link, country,
        # max-age or dead-link filter, every row stored active.
        source = _source(db_session, url=f"https://github.com/{REPO}")
        _routes(github, REPO, JOBRIGHT_README)

        resp = admin.post(f"/github-sources/{source.id}/poll")

        assert resp.status_code == 200, resp.text
        assert resp.json()["new_jobs"] == 0
        assert resp.json()["status"] == STATUS_PARKED
        assert db_session.query(ScrapedJob).count() == 0

    def test_cleanup_jobright_is_gone(self, admin, db_session):
        # It deleted the jobright sources, and the next cron-poll re-seeded
        # them; they park themselves now.
        source = _source(db_session, url=f"https://github.com/{REPO}")

        resp = admin.post("/github-sources/cleanup-jobright")

        assert resp.status_code in (404, 405)
        assert db_session.get(GitHubSource, source.id) is not None
