"""Board crawls retire rows whose own listing fails the crawler's filters.

A row the crawler stored under older, looser filters (bare "london" as a
Canadian city, pre-freshness rows that never passed the entry-level check)
stayed visible forever: reconciliation confirmed and revived every LISTED
url. These tests pin the fix: a listed row whose listing is off target goes
``off_target`` (hidden), stays there while the listing still fails, and comes
back when the posting's title or location changes so it passes. Rows no crawl
reaches (board_key '' / 'unknown') are judged on their stored fields by the
cron-freshness orphan sweep.
"""

import asyncio
import datetime
import socket

import pytest

from backend.data import company_registry
from backend.db.models import ScrapedJob
from backend.services import platform_liveness
from backend.services.ats_scraper import ATSJob, ATSScraper, BoardSnapshot
from backend.services.cross_source_dedup import stands_in_for_twins
from backend.services.listing_freshness import (
    CLOSED_LISTING_STATUSES,
    HIDDEN_LISTING_STATUSES,
    LISTING_ACTIVE,
    LISTING_EXPIRED,
    LISTING_OFF_TARGET,
    LISTING_REMOVED,
    LISTING_STALE,
    listed_status_change,
    reconcile_board,
    record_liveness,
    retire_off_target_enabled,
    retire_unreconcilable_off_target,
)
from backend.services.platform_liveness import LivenessResult

NOW = datetime.datetime.utcnow()
OLD = NOW - datetime.timedelta(days=5)
BOARD = "greenhouse:acme"
SECRET = "test-cron-secret"


def _row(db, url, board_key=BOARD, **kwargs):
    defaults = dict(
        title="Software Intern", company="Acme", location="London",
        source_platform="ats", board_key=board_key, listing_status=LISTING_ACTIVE,
        first_seen_at=OLD, last_seen_at=OLD, scraped_at=OLD,
    )
    defaults.update(kwargs)
    row = ScrapedJob(url=url, **defaults)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _status(db, row):
    db.expire_all()
    return db.get(ScrapedJob, row.id).listing_status


def _job(title, location, department="", **kwargs):
    return ATSJob(title=title, company="Acme", location=location, url="u",
                  department=department, **kwargs)


def _cron_headers(monkeypatch):
    import backend.auth.dependencies as auth_deps

    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


# ─── The verdict ─────────────────────────────────────────────────────────────

class TestRejection:
    @pytest.mark.parametrize("title,location,department,expected", [
        ("Software Intern", "Toronto, ON", "", None),
        ("Software Intern", "London, ON", "", None),
        ("Software Intern", "London, Ontario", "", None),
        # Full state names are North American now (the old filter dropped them).
        ("Software Intern", "Highland Park, Michigan, US", "", None),
        ("Software Intern", "Albuquerque, New Mexico", "", None),
        ("Software Intern", "London", "", "location"),
        ("Software Intern", "London, England, United Kingdom", "", "location"),
        ("Software Intern", "GB-London", "", "location"),
        ("Software Intern", "Remote - Milano, Italy", "", "location"),
        ("Software Intern", "Bangalore, IN", "", "location"),
        # No NA evidence and none against: never retires.
        ("Software Intern", "2 Locations", "", "unplaced"),
        ("Software Intern", "Hybrid", "", "unplaced"),
        ("Software Intern", "", "", "unplaced"),
        ("Software Intern", "Home Based - Americas; Home based - EMEA", "", "unplaced"),
        # A foreign name beside a count of further locations is not a
        # retire verdict: the unnamed ones may be North American.
        ("Software Intern", "Pistoia Tuscany Italy (2 Locations)", "", "unplaced"),
        ("Software Intern", "PRAGUE DC (2 Locations)", "", "unplaced"),
        # Level first: a senior London role is a level rejection.
        ("Senior Software Engineer", "London", "", "level"),
        ("Saw Operator", "Holland, Michigan, United States", "", "level"),
        # The department still counts, as it does at ingest.
        ("Software Engineer", "San Mateo, CA", "University Recruiting", None),
    ])
    def test_reason(self, title, location, department, expected):
        assert ATSScraper().rejection(_job(title, location, department)) == expected

    def test_one_country_board_skips_the_location_check(self):
        assert ATSScraper().rejection(_job("Software Intern", "London"), home_country="CA") is None

    def test_passes_filters_is_the_same_verdict(self):
        scraper = ATSScraper()
        assert scraper._passes_filters(_job("Software Intern", "2 Locations")) is False
        assert scraper._passes_filters(_job("Software Intern", "Austin, TX")) is True
        assert scraper._passes_filters(_job("Staff Engineer", "Austin, TX")) is False

    def test_a_workday_count_passes_on_its_path_hint(self):
        scraper = ATSScraper()
        toronto = _job("Software Intern", "3 Locations", location_hint="Toronto-ON")
        bangalore = _job("Software Intern", "3 Locations", location_hint="Bangalore")
        assert scraper.rejection(toronto) is None
        assert scraper.rejection(bangalore) == "unplaced"  # a hint never retires

    def test_scrape_board_reports_rejections(self, monkeypatch):
        listings = [
            ATSJob(title="Software Intern", company="Acme", location="Austin, TX", url="https://a/1"),
            ATSJob(title="Software Intern", company="Acme", location="London", url="https://a/2"),
            ATSJob(title="Staff Engineer", company="Acme", location="Austin, TX", url="https://a/3"),
            ATSJob(title="Software Intern", company="Acme", location="3 Locations", url="https://a/4"),
        ]

        async def fake_fetch(self, client, slug, company_name):
            return listings

        monkeypatch.setattr(ATSScraper, "_fetch_greenhouse", fake_fetch)
        monkeypatch.setattr(company_registry, "load_board_countries", lambda: {})
        snap = asyncio.run(ATSScraper().scrape_board(None, "greenhouse", "acme", "Acme"))

        assert [job.url for job in snap.jobs] == ["https://a/1"]
        assert snap.all_urls == {"https://a/1", "https://a/2", "https://a/3", "https://a/4"}
        assert snap.rejected == {"https://a/2": "location", "https://a/3": "level",
                                 "https://a/4": "unplaced"}

    def test_a_url_listed_twice_keeps_its_passing_verdict(self, monkeypatch):
        listings = [
            ATSJob(title="Software Intern", company="Acme", location="London", url="https://a/1"),
            ATSJob(title="Software Intern", company="Acme", location="Toronto, ON", url="https://a/1"),
        ]

        async def fake_fetch(self, client, slug, company_name):
            return listings

        monkeypatch.setattr(ATSScraper, "_fetch_greenhouse", fake_fetch)
        monkeypatch.setattr(company_registry, "load_board_countries", lambda: {})
        snap = asyncio.run(ATSScraper().scrape_board(None, "greenhouse", "acme", "Acme"))
        assert snap.rejected == {}


def test_the_crawler_and_the_lifecycle_agree_on_what_retires():
    from backend.services import listing_freshness
    from backend.services.ats_scraper import RETIRABLE_REJECTIONS

    assert listing_freshness._RETIRABLE == RETIRABLE_REJECTIONS


@pytest.mark.parametrize("status, source, rejection, expected", [
    (LISTING_ACTIVE, "ats", "location", LISTING_OFF_TARGET),
    (LISTING_REMOVED, "ats", "level", LISTING_OFF_TARGET),
    (LISTING_OFF_TARGET, "ats", "level", None),        # no second transition
    (LISTING_OFF_TARGET, "ats", None, LISTING_ACTIVE),  # passes again
    (LISTING_OFF_TARGET, "ats", "unplaced", None),      # unknown never revives
    (LISTING_REMOVED, "ats", "unplaced", LISTING_ACTIVE),  # listed = open, as before
    (LISTING_ACTIVE, "ats", None, None),
    (LISTING_REMOVED, "github", "location", LISTING_ACTIVE),  # other sources: old rule
])
def test_listed_status_change(status, source, rejection, expected):
    assert listed_status_change(status, source, rejection) == expected


# ─── Reconciliation ──────────────────────────────────────────────────────────

class TestReconcileRetire:
    def test_listed_off_target_row_is_retired_and_stays_retired(self, db_session):
        london = _row(db_session, "https://a/london")
        toronto = _row(db_session, "https://a/toronto", location="Toronto, ON")
        live = {london.url, toronto.url}

        stats = reconcile_board(db_session, BOARD, live, now=NOW,
                                rejected={london.url: "location"})
        assert stats["off_target"] == 1 and stats["removed"] == 0
        assert _status(db_session, london) == LISTING_OFF_TARGET
        assert _status(db_session, toronto) == LISTING_ACTIVE

        # The next crawl still rejects it: no revival, no second transition.
        stats = reconcile_board(db_session, BOARD, live, now=NOW,
                                rejected={london.url: "location"})
        assert stats["off_target"] == 0 and stats["revived"] == 0
        assert _status(db_session, london) == LISTING_OFF_TARGET
        db_session.expire_all()
        assert db_session.get(ScrapedJob, london.id).last_seen_at == NOW  # still listed

    def test_comes_back_when_the_listing_passes_again(self, db_session):
        row = _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET)

        stats = reconcile_board(db_session, BOARD, {row.url}, now=NOW, rejected={})

        assert stats["revived"] == 1
        assert _status(db_session, row) == LISTING_ACTIVE

    def test_unplaced_listing_never_retires_nor_revives_off_target(self, db_session):
        active = _row(db_session, "https://a/1")
        off = _row(db_session, "https://a/2", listing_status=LISTING_OFF_TARGET)
        closed = _row(db_session, "https://a/3", listing_status=LISTING_REMOVED)
        unplaced = {url: "unplaced" for url in (active.url, off.url, closed.url)}

        reconcile_board(db_session, BOARD, set(unplaced), now=NOW, rejected=unplaced)

        assert _status(db_session, active) == LISTING_ACTIVE
        assert _status(db_session, off) == LISTING_OFF_TARGET
        assert _status(db_session, closed) == LISTING_ACTIVE  # listed = open, as before

    @pytest.mark.parametrize("status", [LISTING_STALE, LISTING_REMOVED, LISTING_EXPIRED])
    def test_closed_row_listed_off_target_goes_off_target_not_active(self, db_session, status):
        row = _row(db_session, "https://a/1", listing_status=status)

        reconcile_board(db_session, BOARD, {row.url}, now=NOW, rejected={row.url: "level"})

        assert _status(db_session, row) == LISTING_OFF_TARGET

    def test_only_crawler_rows_are_retired(self, db_session):
        github = _row(db_session, "https://a/1", source_platform="github",
                      listing_status=LISTING_REMOVED)
        linkedin = _row(db_session, "https://a/2", source_platform="linkedin")

        reconcile_board(db_session, BOARD, {github.url, linkedin.url}, now=NOW,
                        rejected={github.url: "location", linkedin.url: "level"})

        assert _status(db_session, github) == LISTING_ACTIVE  # the old rule
        assert _status(db_session, linkedin) == LISTING_ACTIVE

    def test_vanished_off_target_row_is_left_alone(self, db_session):
        off = _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET)
        other = _row(db_session, "https://a/2", location="Austin, TX")

        stats = reconcile_board(db_session, BOARD, {other.url}, now=NOW, rejected={})

        assert stats["removed"] == 0
        assert _status(db_session, off) == LISTING_OFF_TARGET

    def test_workday_apply_url_matches_its_rejection(self, db_session):
        base = "https://acme.wd3.myworkdayjobs.com/External/job/London/Intern_R-1"
        row = _row(db_session, base + "/apply", board_key="workday:acme")

        reconcile_board(db_session, "workday:acme", {base}, now=NOW, rejected={base: "location"})

        assert _status(db_session, row) == LISTING_OFF_TARGET

    def test_without_verdicts_listed_means_active(self, db_session):
        """What the kill switch falls back to: the old rule, which also brings
        rows retired earlier back on the next crawl."""
        off = _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET)

        reconcile_board(db_session, BOARD, {off.url}, now=NOW, rejected=None)

        assert _status(db_session, off) == LISTING_ACTIVE

    def test_partial_snapshot_retires_what_it_listed(self, db_session):
        from backend.routers.github_sources import _confirm_listed

        london = _row(db_session, "https://a/london")
        closed = _row(db_session, "https://a/closed", listing_status=LISTING_REMOVED)
        unlisted = _row(db_session, "https://a/unlisted")

        stats = _confirm_listed(db_session, BOARD, {london.url, closed.url}, now=NOW,
                                rejected={london.url: "location"})

        assert stats == {"confirmed": 2, "revived": 1, "off_target": 1}
        assert _status(db_session, london) == LISTING_OFF_TARGET
        assert _status(db_session, closed) == LISTING_ACTIVE
        assert _status(db_session, unlisted) == LISTING_ACTIVE


# ─── cron-ats end to end ─────────────────────────────────────────────────────

class TestCronAts:
    def _run(self, client, monkeypatch, snapshot_kwargs):
        monkeypatch.setattr(company_registry, "load_companies",
                            lambda **kw: [("greenhouse", "acme", "Acme")])

        async def fake_scrape_board(self, client, platform, slug, company_name):
            return BoardSnapshot(platform=platform, slug=slug, company=company_name,
                                 **snapshot_kwargs)

        monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)
        res = client.post("/github-sources/cron-ats", headers=_cron_headers(monkeypatch))
        assert res.status_code == 200, res.text
        return res.json()

    def test_retires_off_target_rows_and_keeps_them_retired(self, client, db_session, monkeypatch):
        london = _row(db_session, "https://boards.greenhouse.io/acme/jobs/1")
        snap = dict(all_urls={london.url}, rejected={london.url: "location"},
                    complete=True, total_listed=1)

        body = self._run(client, monkeypatch, snap)
        assert body["off_target"] == 1
        assert body["removed"] == 0
        assert _status(db_session, london) == LISTING_OFF_TARGET

        body = self._run(client, monkeypatch, snap)
        assert body["off_target"] == 0 and body["revived"] == 0
        assert _status(db_session, london) == LISTING_OFF_TARGET

    def test_partial_snapshot_retires_too(self, client, db_session, monkeypatch):
        london = _row(db_session, "https://boards.greenhouse.io/acme/jobs/1",
                      listing_status=LISTING_STALE)

        body = self._run(client, monkeypatch, dict(
            all_urls={london.url}, rejected={london.url: "location"},
            complete=False, total_listed=5000))

        assert body["off_target"] == 1 and body["revived"] == 0
        assert _status(db_session, london) == LISTING_OFF_TARGET

    @pytest.mark.parametrize("value", ["0", "false", "OFF"])
    def test_kill_switch_turns_the_retire_off(self, client, db_session, monkeypatch, value):
        monkeypatch.setenv("CRON_ATS_RETIRE_OFF_TARGET", value)
        assert not retire_off_target_enabled()
        london = _row(db_session, "https://boards.greenhouse.io/acme/jobs/1")
        earlier = _row(db_session, "https://boards.greenhouse.io/acme/jobs/2",
                       listing_status=LISTING_OFF_TARGET)

        body = self._run(client, monkeypatch, dict(
            all_urls={london.url, earlier.url},
            rejected={london.url: "location", earlier.url: "level"},
            complete=True, total_listed=2))

        assert body["off_target"] == 0
        assert _status(db_session, london) == LISTING_ACTIVE
        assert _status(db_session, earlier) == LISTING_ACTIVE  # back, as before the change

    def test_retire_is_on_by_default(self, monkeypatch):
        monkeypatch.delenv("CRON_ATS_RETIRE_OFF_TARGET", raising=False)
        assert retire_off_target_enabled()
        monkeypatch.setenv("CRON_ATS_RETIRE_OFF_TARGET", "1")
        assert retire_off_target_enabled()


# ─── Rows no crawl reaches ───────────────────────────────────────────────────

class TestOrphanRetire:
    def test_retires_only_what_fails_the_filters(self, db_session):
        cleaner = _row(db_session, "https://jobs.nokia.com/1", board_key="unknown",
                       title="Cleaner", location="Toronto, ON")
        london = _row(db_session, "https://jobs.nokia.com/2", board_key="",
                      title="Software Intern", location="London, UK")
        coop = _row(db_session, "https://huaweicanada.recruitee.com/o/3", board_key="unknown",
                    title="Co-op Engineer - AI Software Engineering", location="Markham, ON")
        unplaced = _row(db_session, "https://jobs.nokia.com/4", board_key="unknown",
                        title="Software Intern", location="Multiple Locations")

        stats = retire_unreconcilable_off_target(db_session, now=NOW)

        assert stats["off_target"] == 2
        assert (stats["level"], stats["location"]) == (1, 1)
        assert _status(db_session, cleaner) == LISTING_OFF_TARGET
        assert _status(db_session, london) == LISTING_OFF_TARGET
        assert _status(db_session, coop) == LISTING_ACTIVE
        assert _status(db_session, unplaced) == LISTING_ACTIVE

    def test_leaves_crawled_boards_and_other_sources_alone(self, db_session):
        crawled = _row(db_session, "https://boards.greenhouse.io/acme/jobs/1",
                       title="Cleaner")
        linkedin = _row(db_session, "https://www.linkedin.com/jobs/view/1", board_key="unknown",
                        source_platform="linkedin", title="Cleaner")
        rogue_li = _row(db_session, "https://ca.linkedin.com/jobs/view/2", board_key="unknown",
                        title="Cleaner")  # a LinkedIn card stored as 'ats'
        github = _row(db_session, "https://example.com/careers/1", board_key="",
                      source_platform="github", title="Cleaner")
        twin = _row(db_session, "https://jobs.nokia.com/9", board_key="unknown",
                    title="Cleaner", duplicate_of=crawled.id)

        stats = retire_unreconcilable_off_target(db_session, now=NOW)

        assert stats["off_target"] == 0
        for row in (crawled, linkedin, rogue_li, github, twin):
            assert _status(db_session, row) == LISTING_ACTIVE

    def test_kill_switch(self, db_session, monkeypatch):
        monkeypatch.setenv("CRON_ATS_RETIRE_OFF_TARGET", "0")
        cleaner = _row(db_session, "https://jobs.nokia.com/1", board_key="unknown",
                       title="Cleaner")

        stats = retire_unreconcilable_off_target(db_session, now=NOW)

        assert stats["off_target"] == 0 and stats["disabled"]
        assert _status(db_session, cleaner) == LISTING_ACTIVE

    def test_cron_freshness_runs_it_before_the_checks(self, client, db_session, monkeypatch):
        from backend.services import listing_freshness

        cleaner = _row(db_session, "https://jobs.nokia.com/1", board_key="unknown",
                       title="Cleaner", location="Toronto, ON")
        probed: list = []

        async def fake_verify(db, client_, limit=0, now=None, *, deadline=None, cache=None, **kw):
            probed.append(_status(db, cleaner))
            return {"checked": 0}

        for name in ("verify_stale_listings", "verify_unconfirmed_active_listings",
                     "verify_recent_aggregator_listings"):
            monkeypatch.setattr(listing_freshness, name, fake_verify)

        body = client.post("/jobs/cron-freshness", headers=_cron_headers(monkeypatch)).json()

        assert body["orphans_off_target"]["off_target"] == 1
        assert probed and all(status == LISTING_OFF_TARGET for status in probed)


# ─── The rest of the lifecycle ───────────────────────────────────────────────

def test_off_target_is_hidden_from_the_feed(client, db_session):
    _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET)
    visible = _row(db_session, "https://a/2", location="Austin, TX")

    ids = [job["id"] for job in client.get("/jobs").json()]

    assert ids == [visible.id]
    assert LISTING_OFF_TARGET in HIDDEN_LISTING_STATUSES
    assert LISTING_OFF_TARGET not in CLOSED_LISTING_STATUSES


def test_platform_alive_never_revives_off_target(db_session):
    row = _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET)

    status = record_liveness(db_session, row.id, LISTING_OFF_TARGET,
                             LivenessResult("alive", "greenhouse_api_200", True), now=NOW)
    db_session.commit()

    assert status == LISTING_OFF_TARGET
    db_session.expire_all()
    assert db_session.get(ScrapedJob, row.id).last_seen_at == NOW


def test_check_live_probes_off_target_instead_of_calling_it_dead(client, db_session, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "",
                                          ("93.184.216.34", 0))])

    async def fake_check_listing(client, url, *, cache=None, board_key=""):
        return LivenessResult("alive", "greenhouse_api_200", True)

    monkeypatch.setattr(platform_liveness, "check_listing", fake_check_listing)
    row = _row(db_session, "https://boards.greenhouse.io/acme/jobs/1",
               listing_status=LISTING_OFF_TARGET)

    body = client.post(f"/jobs/{row.id}/check-live").json()

    assert body == {"id": row.id, "listing_status": LISTING_OFF_TARGET, "verdict": "alive"}


def test_off_target_direct_row_keeps_standing_in_for_its_twins():
    assert stands_in_for_twins(LISTING_OFF_TARGET, "ats", "https://boards.greenhouse.io/a/jobs/1")
    assert not stands_in_for_twins(LISTING_OFF_TARGET, "ats", "https://www.linkedin.com/jobs/view/1")
    assert not stands_in_for_twins(LISTING_EXPIRED, "ats", "https://boards.greenhouse.io/a/jobs/1")


def test_ingest_metrics_counts_rows_retired_today(client, db_session, monkeypatch):
    _row(db_session, "https://a/1", listing_status=LISTING_OFF_TARGET,
         listing_status_changed_at=datetime.datetime.utcnow())
    _row(db_session, "https://a/2", listing_status=LISTING_OFF_TARGET,
         listing_status_changed_at=datetime.datetime.utcnow() - datetime.timedelta(days=3))
    monkeypatch.setattr(company_registry, "load_companies", lambda **kw: [])

    body = client.get("/jobs/ingest-metrics", headers=_cron_headers(monkeypatch)).json()

    assert body["off_target_24h"] == 1
    assert body["by_listing_status"][LISTING_OFF_TARGET] == 2
