"""
One posting on two GitHub lists, or twice on one. Pairs lifted from the
2026-09-29 end-to-end run of the speedyapply files against prod's list rows:
~35 duplicate cards among 1,082 new visible rows (site aliases inside one
file, negarprh postings repeated under another path case, title or
employer name).
"""

import pytest

from backend.db.models import ScrapedJob
from backend.services.aggregator import AggregatorService
from backend.services.cross_source_dedup import (
    hide_list_copies_of_board_rows,
    hide_repeated_list_rows,
    list_row_key,
    normalize_title,
    release_repeated_list_rows,
)
from backend.services.markdown_parser import ParsedJob
from backend.tests.test_github_list_fixes import _commits, _source, github  # noqa: F401

HPE = ("https://hpe.wd5.myworkdayjobs.com/en-US/jobsathpe/job/Spring-Texas-United-States-of-America/"
       "Entry-Electrical-Engineering-Embedded-Power-Solutions_1211914-2",
       "https://hpe.wd5.myworkdayjobs.com/en-US/wfmathpe/job/Spring-Texas-United-States-of-America/"
       "Entry-Electrical-Engineering-Embedded-Power-Solutions_1211914-1")
# negarprh (prod 65229) and speedyapply INTERN_INTL (e2e 66617): path case,
# title and employer name all differ.
MANULIFE = (("https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_Jobs/job/Waterloo-Ontario/"
             "Summer-Intern-2027---Software-Engineering--12-Months-_JR26091053",
             "Manulife Financial", "Software Engineering Intern"),
            ("https://manulife.wd3.myworkdayjobs.com/en-US/mfcjh_jobs/job/Waterloo-Ontario/"
             "Summer-Intern-2027---Software-Engineering--12-Months-_JR26091053",
             "Manulife", "Summer Intern 2027 - Software Engineering - 12 Months"))
BREE = "17d8dd15-5f97-4003-8d6c-170dca13ff88"


def _row(db, url, title="Entry Electrical Engineering Embedded Power Solutions",
         company="Hewlett Packard Enterprise", platform="github", status="active", **kw):
    row = ScrapedJob(title=title, company=company, location="Spring, TX", url=url, description="",
                     source_platform=platform, title_norm=normalize_title(title),
                     listing_status=status, **kw)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _dup(db, row):
    db.refresh(row)
    return row.duplicate_of


class TestKey:
    def test_precise_identity_ignores_title_and_employer(self):
        (url_a, company_a, title_a), (url_b, company_b, title_b) = MANULIFE
        assert list_row_key(company_a, normalize_title(title_a), url_a) \
            == list_row_key(company_b, normalize_title(title_b), url_b) \
            == ("workday:manulife:jr26091053",)

    def test_any_other_url_needs_employer_and_title(self):
        url = "https://careers.acme.com/jobs/4417"
        assert list_row_key("Acme", "data analyst intern", url) \
            == list_row_key("Acme Inc.", "data analyst intern", url.replace("/jobs/", "/Jobs/"))
        assert list_row_key("Acme", "data analyst intern", url) \
            != list_row_key("Acme", "data engineer intern", url)
        assert list_row_key("", "data analyst intern", url) is None


class TestHideRepeats:
    def test_site_aliases_in_one_file_keep_the_oldest(self, db_session):
        first = _row(db_session, HPE[0])
        alias = _row(db_session, HPE[1])

        assert hide_repeated_list_rows(db_session) == 1
        assert hide_repeated_list_rows(db_session) == 0  # idempotent
        assert (_dup(db_session, first), _dup(db_session, alias)) == (None, first.id)

    def test_repeat_on_another_list_under_another_name_and_title(self, db_session):
        (url_a, company_a, title_a), (url_b, company_b, title_b) = MANULIFE
        negarprh = _row(db_session, url_a, title=title_a, company=company_a)
        speedy = _row(db_session, url_b, title=title_b, company=company_b)
        ashby = [_row(db_session, f"https://jobs.ashbyhq.com/bree/{BREE}", title="Software Engineer Co-op, Product",
                      company="Bree"),
                 _row(db_session, f"https://jobs.ashbyhq.com/Bree/{BREE}/application",
                      title="Software Engineer - Product - Co-op", company="Bree")]

        assert hide_repeated_list_rows(db_session) == 2
        assert _dup(db_session, negarprh) is None
        assert _dup(db_session, speedy) == negarprh.id
        assert _dup(db_session, ashby[1]) == ashby[0].id

    def test_distinct_postings_stay(self, db_session):
        rows = [
            _row(db_session, "https://hp.wd5.myworkdayjobs.com/en-US/externalcareersite/job/Fort-Collins/"
                 "Software-Quality-Engineer_3168480", title="Software Quality Engineer", company="HP"),
            _row(db_session, "https://hp.wd5.myworkdayjobs.com/en-US/externalcareersite/job/Fort-Collins/"
                 "Software-Quality-Engineer_3168481", title="Software Quality Engineer", company="HP"),
            # A careers page that is not a posting id: only one posting with
            # the same employer AND title.
            _row(db_session, "https://careers.acme.com/students", title="Data Analyst Intern", company="Acme"),
            _row(db_session, "https://careers.acme.com/Students", title="Data Engineer Intern", company="Acme"),
        ]

        assert hide_repeated_list_rows(db_session) == 0
        assert [_dup(db_session, row) for row in rows] == [None] * 4

    def test_hidden_or_closed_rows_are_never_kept(self, db_session):
        closed = _row(db_session, HPE[0], status="removed")
        alias = _row(db_session, HPE[1])

        assert hide_repeated_list_rows(db_session) == 0
        assert (_dup(db_session, closed), _dup(db_session, alias)) == (None, None)

    @pytest.mark.parametrize("board_status, by_board, by_repeat", [("active", 2, 0), ("removed", 1, 1)])
    def test_retitled_repeat_goes_under_the_board_row(self, db_session, board_status, by_board, by_repeat):
        # The board pass hides a retitled copy of a precise identity behind a
        # visible board row itself. A removed one takes only the copy whose
        # title matches the board's: the retitled repeat on another list
        # follows it there, not the feed.
        (url_a, company_a, title_a), (url_b, company_b, title_b) = MANULIFE
        board = _row(db_session, url_a.replace("/en-US/", "/"), title=title_a, company=company_a,
                     platform="ats", status=board_status)
        same_title = _row(db_session, url_a, title=title_a, company=company_a)
        retitled = _row(db_session, url_b, title=title_b, company=company_b)

        assert hide_list_copies_of_board_rows(db_session) == by_board
        assert hide_repeated_list_rows(db_session) == by_repeat
        assert _dup(db_session, same_title) == board.id
        assert _dup(db_session, retitled) == board.id


class TestReleaseRepeats:
    @pytest.mark.parametrize("status", ["removed", "expired", "off_target"])
    def test_repeat_comes_back_when_its_keeper_leaves_the_feed(self, db_session, status):
        keeper = _row(db_session, HPE[0])
        repeat = _row(db_session, HPE[1])
        hide_repeated_list_rows(db_session)
        keeper.listing_status = status
        db_session.commit()

        assert release_repeated_list_rows(db_session) == 1
        assert hide_repeated_list_rows(db_session) == 0
        assert _dup(db_session, repeat) is None

    def test_live_keeper_keeps_its_repeat(self, db_session):
        keeper = _row(db_session, HPE[0])
        repeat = _row(db_session, HPE[1])
        hide_repeated_list_rows(db_session)

        assert release_repeated_list_rows(db_session) == 0
        assert _dup(db_session, repeat) == keeper.id

    def test_repeat_follows_a_keeper_hidden_later(self, db_session):
        # The board crawl picks the posting up after the lists did: the
        # keeper goes under the board row, and its repeat follows it there
        # instead of pointing at a hidden row.
        keeper = _row(db_session, HPE[0])
        repeat = _row(db_session, HPE[1])
        hide_repeated_list_rows(db_session)
        board = _row(db_session, HPE[0].replace("/en-US/", "/"), platform="ats")
        assert hide_list_copies_of_board_rows(db_session) == 1

        assert release_repeated_list_rows(db_session) == 0
        assert (_dup(db_session, keeper), _dup(db_session, repeat)) == (board.id, board.id)


class TestIngestGuard:
    def test_second_site_alias_in_one_file_is_not_stored(self, db_session):
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        svc = AggregatorService(db_session)
        jobs = [ParsedJob(title="Entry Electrical Engineering Embedded Power Solutions",
                          company="Hewlett Packard Enterprise", location="Spring, TX", url=url)
                for url in HPE]

        assert [svc._classify_and_store(job, source) for job in jobs] == [True, False]
        assert [row.url for row in db_session.query(ScrapedJob)] == [HPE[0]]

    def test_repeat_of_another_lists_row_is_not_stored(self, db_session):
        (url_a, company_a, title_a), (url_b, company_b, title_b) = MANULIFE
        _row(db_session, url_a, title=title_a, company=company_a)
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        job = ParsedJob(title=title_b, company=company_b, location="Waterloo, ON", url=url_b)

        assert AggregatorService(db_session)._classify_and_store(job, source) is False
        assert db_session.query(ScrapedJob).count() == 1

    def test_url_in_another_letter_case_is_not_stored(self, db_session):
        _row(db_session, "https://careers.acme.com/jobs/4417", title="Data Analyst Intern", company="Acme")
        source = _source(db_session)
        job = ParsedJob(title="Data Analyst Intern", company="Acme", location="Toronto, ON",
                        url="https://careers.acme.com/Jobs/4417")

        assert AggregatorService(db_session)._classify_and_store(job, source) is False

    @pytest.mark.asyncio
    async def test_each_parse_reads_the_feed_afresh(self, db_session, github):
        # cron-poll runs every source through one AggregatorService: a row
        # that left the feed since the last parse blocks nothing.
        svc = AggregatorService(db_session)
        keeper = _row(db_session, HPE[0])
        assert svc._listed_postings()
        keeper.listing_status = "removed"
        db_session.commit()
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        github["routes"].update({
            "/repos/speedyapply/2027-SWE-College-Jobs/commits?per_page=1":
                (200, _commits("s1", "2026-09-27T12:00:00Z")),
            "/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md": (200, (
                "| Company | Role | Location | Application/Link | Date Posted |\n"
                "| --- | --- | --- | --- | --- |\n"
                "| **Hewlett Packard Enterprise** | Entry Electrical Engineering Embedded Power Solutions | "
                f'Spring, TX | <a href="{HPE[1]}"><img src="x.png" alt="Apply"></a> | Sep 20 |\n')),
        })

        assert await svc.poll_source(source) == 1

    @pytest.mark.asyncio
    async def test_list_swapping_site_aliases_keeps_the_posting(self, db_session, github):
        # The list now links the posting through its other alias: the row it
        # no longer lists retires in this parse, so it blocks nothing.
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        old = _row(db_session, HPE[0], github_source_id=source.id)
        github["routes"].update({
            "/repos/speedyapply/2027-SWE-College-Jobs/commits?per_page=1":
                (200, _commits("s1", "2026-09-27T12:00:00Z")),
            "/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md": (200, (
                "| Company | Role | Location | Application/Link | Date Posted |\n"
                "| --- | --- | --- | --- | --- |\n"
                "| **Hewlett Packard Enterprise** | Entry Electrical Engineering Embedded Power Solutions | "
                f'Spring, TX | <a href="{HPE[1]}"><img src="x.png" alt="Apply"></a> | Sep 20 |\n')),
        })

        assert await AggregatorService(db_session).poll_source(source) == 1

        db_session.refresh(old)
        assert old.listing_status == "removed"
        assert db_session.query(ScrapedJob).filter(ScrapedJob.url == HPE[1]).one().listing_status == "active"

    @pytest.mark.parametrize("status", ["removed", "expired"])
    def test_a_row_out_of_the_feed_does_not_block(self, db_session, status):
        _row(db_session, HPE[0], status=status)
        source = _source(db_session)
        job = ParsedJob(title="Entry Electrical Engineering Embedded Power Solutions",
                        company="Hewlett Packard Enterprise", location="Spring, TX", url=HPE[1])

        assert AggregatorService(db_session)._classify_and_store(job, source) is True
