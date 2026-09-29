"""
GitHub-list rows vs board-crawled rows for the same posting under different
URL spellings. Pairs lifted from prod (2026-09-29): 17 visible list rows had
a visible board twin.
"""

import pytest

from backend.db.models import ScrapedJob
from backend.services.aggregator import AggregatorService
from backend.services.cross_source_dedup import (
    canonical_url,
    hide_list_copies_of_board_rows,
    normalize_title,
    posting_identity,
    release_list_copies_of_lapsed_board_rows,
)
from backend.services.markdown_parser import ParsedJob
from backend.tests.test_github_list_fixes import _source

PROD_PAIRS = [
    ("https://marvell.wd1.myworkdayjobs.com/en-US/marvellcareers/job/Santa-Clara-CA/Firmware-Engineer-Intern--MS---Summer-2027_2502471",
     "https://marvell.wd1.myworkdayjobs.com/MarvellCareers/job/Santa-Clara-CA/Firmware-Engineer-Intern--MS---Summer-2027_2502471"),
    ("https://cibc.wd3.myworkdayjobs.com/campus/job/Toronto-ON/Risk-Analytics-Co-op-Winter-2027_2618885",
     "https://cibc.wd3.myworkdayjobs.com/search/job/Toronto-ON/Risk-Analytics-Co-op-Winter-2027_2618885-1"),
    ("https://boards.greenhouse.io/robinhood/jobs/8142963?t=gh_src%3D&gh_jid=8142963",
     "https://boards.greenhouse.io/robinhood/jobs/8142963?t=gh_src=&gh_jid=8142963"),
    ("https://boards.greenhouse.io/robinhood/jobs/8199729",
     "https://boards.greenhouse.io/robinhood/jobs/8199729?t=gh_src=&gh_jid=8199729"),
    ("https://ciena.wd5.myworkdayjobs.com/en-US/careers/job/Atlanta/WaveLogic-Software-Intern-Spring-2027_R031692",
     "https://ciena.wd5.myworkdayjobs.com/careers/job/Atlanta/WaveLogic-Software-Intern-Spring-2027_R031692"),
]


class TestCanonicalUrl:
    def test_kept_params_keep_their_spelling(self):
        url = "https://boards.greenhouse.io/robinhood/jobs/8142963?t=gh_src=&gh_jid=8142963"
        assert canonical_url(url) == url
        assert canonical_url(url + "&utm_source=x") == url

    def test_list_attribution_is_dropped(self):
        assert canonical_url("https://boards.greenhouse.io/cloudflare/jobs/8199958?utm_source=Simplify&ref=Simplify") \
            == "https://boards.greenhouse.io/cloudflare/jobs/8199958"
        assert canonical_url("https://jobs.l3harris.com/job/x/1414531300/?ats=successfactors&utm_source=vansh&ref=vansh") \
            == "https://jobs.l3harris.com/job/x/1414531300/?ats=successfactors"


class TestPostingIdentity:
    @pytest.mark.parametrize("listed, crawled", PROD_PAIRS)
    def test_prod_pairs_name_one_posting(self, listed, crawled):
        assert posting_identity(listed) == posting_identity(crawled)

    def test_distinct_requisitions_stay_distinct(self):
        spring = "https://ciena.wd5.myworkdayjobs.com/careers/job/Atlanta/WaveLogic-Software-Intern-Spring-2027_R031692"
        summer = "https://ciena.wd5.myworkdayjobs.com/careers/job/Atlanta/WaveLogic-Software-Intern--Summer-2027-_R031695"
        assert posting_identity(spring) != posting_identity(summer)

    def test_employer_hosted_greenhouse_page_is_the_board_posting(self):
        assert posting_identity("https://www.zipline.com/open-roles/8004729003?gh_jid=8004729003") \
            == posting_identity("https://job-boards.greenhouse.io/flyzipline/jobs/8004729003")

    def test_workday_apply_step_and_site_host_are_the_posting(self):
        board = "https://cibc.wd3.myworkdayjobs.com/campus/job/Toronto-ON/Risk-Analytics-Co-op_2618885"
        assert posting_identity(board + "/apply") == posting_identity(board)
        assert posting_identity(board + "/apply/applyManually") == posting_identity(board)
        # myworkdaysite.com names the tenant in the path, not the host.
        site = ("https://wd3.myworkdaysite.com/en-US/recruiting/cibc/campus/job/Toronto-ON/"
                "Risk-Analytics-Co-op_2618885")
        assert posting_identity(site) == posting_identity(board) == "workday:cibc:2618885"

    def test_same_requisition_at_another_tenant_is_another_posting(self):
        assert posting_identity("https://bmo.wd3.myworkdayjobs.com/External/job/X_R123") \
            != posting_identity("https://td.wd3.myworkdayjobs.com/External/job/X_R123")

    def test_lever_and_ashby_postings_by_uuid(self):
        uuid = "17d8dd15-5f97-4003-8d6c-170dca13ff88"
        assert posting_identity(f"http://jobs.ashbyhq.com/bree/{uuid}/application?embed=true") \
            == posting_identity(f"https://jobs.ashbyhq.com/bree/{uuid}") == f"ashby:{uuid}"
        assert posting_identity(f"https://jobs.eu.lever.co/acme/{uuid}/apply") \
            == posting_identity(f"https://jobs.lever.co/acme/{uuid}") == f"lever:{uuid}"


def _job(db, url, source_platform, title="Firmware Engineer Intern", company="Marvell", **kw):
    row = ScrapedJob(title=title, company=company, location="Santa Clara, CA", url=url,
                     description="", source_platform=source_platform,
                     title_norm=normalize_title(title), listing_status="active", **kw)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


class TestHeal:
    def test_list_copy_is_hidden_behind_board_row(self, db_session):
        board = _job(db_session, PROD_PAIRS[0][1], "ats")
        listed = _job(db_session, PROD_PAIRS[0][0], "github")
        other = _job(db_session, "https://jobs.lever.co/acme/x", "github", title="Other Intern")

        assert hide_list_copies_of_board_rows(db_session) == 1
        assert hide_list_copies_of_board_rows(db_session) == 0  # idempotent

        db_session.refresh(listed)
        db_session.refresh(other)
        assert listed.duplicate_of == board.id
        assert other.duplicate_of is None

    @pytest.mark.parametrize("status, released", [("expired", 1), ("removed", 0), ("active", 0)])
    def test_copy_comes_back_when_its_board_row_ages_out(self, db_session, status, released):
        # 'expired' only means nothing re-confirmed the board row lately; the
        # list still offers the posting. 'removed' is the board's own death
        # verdict, so its copy stays hidden.
        board = _job(db_session, PROD_PAIRS[0][1], "ats")
        listed = _job(db_session, PROD_PAIRS[0][0], "github")
        assert hide_list_copies_of_board_rows(db_session) == 1
        board.listing_status = status
        db_session.commit()

        assert release_list_copies_of_lapsed_board_rows(db_session) == released
        assert hide_list_copies_of_board_rows(db_session) == 0  # not hidden again

        db_session.refresh(listed)
        assert listed.duplicate_of == (None if released else board.id)

    def test_released_copy_goes_under_a_live_board_twin(self, db_session):
        lapsed = _job(db_session, PROD_PAIRS[0][1], "ats")
        listed = _job(db_session, PROD_PAIRS[0][0], "github")
        hide_list_copies_of_board_rows(db_session)
        lapsed.listing_status = "expired"
        db_session.commit()
        live = _job(db_session, PROD_PAIRS[0][1] + "/apply", "ats")

        assert release_list_copies_of_lapsed_board_rows(db_session) == 1
        assert hide_list_copies_of_board_rows(db_session) == 1

        db_session.refresh(listed)
        assert listed.duplicate_of == live.id

    def test_different_title_is_never_merged(self, db_session):
        _job(db_session, PROD_PAIRS[0][1], "ats", title="Firmware Engineer Intern")
        listed = _job(db_session, PROD_PAIRS[0][0], "github", title="Firmware Engineer Intern, Storage")
        assert hide_list_copies_of_board_rows(db_session) == 0
        db_session.refresh(listed)
        assert listed.duplicate_of is None


class TestIngestGuard:
    def test_list_row_for_a_board_posting_is_not_inserted(self, db_session):
        board = _job(db_session, PROD_PAIRS[1][1], "ats", title="Risk Analytics Co-op Winter 2027", company="CIBC")
        source = _source(db_session, url="https://github.com/negarprh/Canadian-Tech-Internships-2027")
        job = ParsedJob(title="Risk Analytics Co-op Winter 2027", company="CIBC",
                        location="Toronto, ON", url=PROD_PAIRS[1][0])

        assert AggregatorService(db_session)._classify_and_store(job, source) is False
        assert db_session.query(ScrapedJob).count() == 1
        assert db_session.query(ScrapedJob).one().id == board.id

    @pytest.mark.parametrize("status, stored", [("removed", False), ("expired", True)])
    def test_only_a_board_row_that_stands_in_blocks_the_list_row(self, db_session, status, stored):
        # A removed board row is the posting's death verdict; an expired one
        # only aged out, so the list copy (still listed) is the one to show.
        board = _job(db_session, PROD_PAIRS[1][1], "ats", title="Risk Analytics Co-op Winter 2027",
                     company="CIBC")
        board.listing_status = status
        db_session.commit()
        source = _source(db_session, url="https://github.com/negarprh/Canadian-Tech-Internships-2027")
        job = ParsedJob(title="Risk Analytics Co-op Winter 2027", company="CIBC",
                        location="Toronto, ON", url=PROD_PAIRS[1][0])

        assert AggregatorService(db_session)._classify_and_store(job, source) is stored

    def test_expired_board_row_does_not_hide_a_visible_list_copy(self, db_session):
        board = _job(db_session, PROD_PAIRS[0][1], "ats")
        listed = _job(db_session, PROD_PAIRS[0][0], "github")
        board.listing_status = "expired"
        db_session.commit()

        assert hide_list_copies_of_board_rows(db_session) == 0
        db_session.refresh(listed)
        assert listed.duplicate_of is None

    def test_no_sponsorship_mark_is_stored(self, db_session):
        source = _source(db_session)
        job = ParsedJob(title="New Grad: Software Engineer", company="NorthMark Strategies",
                        location="New York, NY", url="https://jobs.lever.co/northmark/1",
                        no_sponsorship=True)

        assert AggregatorService(db_session)._classify_and_store(job, source) is True
        assert db_session.query(ScrapedJob).one().visa_sponsorship == "no"
