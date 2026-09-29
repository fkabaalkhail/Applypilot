"""
GitHub-list source correctness: dates, names, links, closed rows, renames and
transient errors. Every README snippet below is lifted from a real list
(vanshb03, speedyapply, negarprh, SimplifyJobs, jobright).

No network: GitHub and job hosts are served by httpx.MockTransport.
"""

import datetime
import json

import httpx
import pytest

from backend.db.models import GitHubSource, ScrapedJob
from backend.services import aggregator as aggregator_module
from backend.services import markdown_parser
from backend.services.aggregator import (
    AggregatorService,
    ERROR_RETRY_COOLDOWN,
    is_retryable_error,
)
from backend.services.listing_freshness import (
    LISTING_ACTIVE,
    LISTING_EXPIRED,
    LISTING_REMOVED,
    reconcile_board,
    sweep_aggregator_expiry,
)
from backend.services.markdown_parser import (
    MarkdownParser,
    ParsedJob,
    clean_company_name,
    parse_listing_date,
)

NOW = datetime.datetime(2026, 9, 27, 15, 0)
NEW_YEAR = datetime.datetime(2027, 1, 3, 9, 0)

parser = MarkdownParser()


@pytest.fixture
def frozen_now(monkeypatch):
    monkeypatch.setattr(markdown_parser, "_utcnow", lambda: NOW)
    return NOW


def _source(db, url="https://github.com/vanshb03/New-Grad-2027", status="active",
            error_message="", last_polled_at=None, **kwargs):
    owner, name = url.rstrip("/").split("/")[-2:]
    source = GitHubSource(repo_url=url, repo_owner=owner, repo_name=name,
                          file_path="README.md", role_category="Software Engineering",
                          experience_level="new_grad", status=status,
                          error_message=error_message, last_polled_at=last_polled_at,
                          **kwargs)
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


def _row(db, source, url, company="Acme", title="Software Engineer",
         listing_status=LISTING_ACTIVE):
    row = ScrapedJob(title=title, company=company, location="Toronto, ON", url=url,
                     description="", source_platform="github",
                     github_source_id=source.id, listing_status=listing_status)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ─── dates ───────────────────────────────────────────────────────────────────

class TestListingDates:
    def test_yearless_date_across_new_year_uses_previous_year(self):
        # Parsed on Jan 3 2027: 'Dec 30' is four days ago, not next December.
        assert parse_listing_date("Dec 30", now=NEW_YEAR) == datetime.datetime(2026, 12, 30)
        assert parse_listing_date("12/30", now=NEW_YEAR) == datetime.datetime(2026, 12, 30)
        assert parse_listing_date("December 30", now=NEW_YEAR) == datetime.datetime(2026, 12, 30)
        assert parse_listing_date("Jan 02", now=NEW_YEAR) == datetime.datetime(2027, 1, 2)

    def test_future_yearless_date_is_last_year(self):
        # vansh's 'Nov 30' rows are 2025 postings; they used to land in Nov 2026.
        assert parse_listing_date("Nov 30", now=NOW) == datetime.datetime(2025, 11, 30)
        assert parse_listing_date("Sep 26", now=NOW) == datetime.datetime(2026, 9, 26)

    def test_one_day_tolerance_for_timezone_skew(self):
        # UTC+14 runs at most a day ahead of the commit; two days misdated
        # a year-old row as brand new.
        assert parse_listing_date("Sep 28", now=NOW) == datetime.datetime(2026, 9, 28)
        assert parse_listing_date("Sep 29", now=NOW) == datetime.datetime(2025, 9, 29)
        assert parse_listing_date("Sep 30", now=NOW) == datetime.datetime(2025, 9, 30)

    def test_feb_29_lands_on_a_leap_year(self):
        assert parse_listing_date("Feb 29", now=NOW) == datetime.datetime(2024, 2, 29)

    def test_full_dates_untouched(self):
        assert parse_listing_date("Sep 25, 2026", now=NOW) == datetime.datetime(2026, 9, 25)
        assert parse_listing_date("2026-12-12", now=NOW) == datetime.datetime(2026, 12, 12)

    def test_relative_ages(self):
        day = NOW.replace(hour=0)
        assert parse_listing_date("0d", now=NOW) == day
        assert parse_listing_date("2d", now=NOW) == day - datetime.timedelta(days=2)
        assert parse_listing_date("3w", now=NOW) == day - datetime.timedelta(weeks=3)
        assert parse_listing_date("1mo", now=NOW) == day - datetime.timedelta(days=30)
        assert parse_listing_date("soon", now=NOW) is None

    def test_parser_uses_frozen_clock(self, frozen_now):
        table = (
            "| Company | Role | Location | Application/Link | Date Posted |\n"
            "| --- | --- | --- | :---: | :---: |\n"
            "| **Databricks** | AI Tooling Program Engineer | Remote in USA | "
            '<a href="https://www.databricks.com/company/careers/x-8295414002?utm_source=vansh">'
            '<img src="https://i.imgur.com/u1KNU8z.png" width="118" alt="Apply"></a> | Nov 18 |\n'
        )
        [job] = parser.parse_markdown_table(table)
        assert job.posted_date == datetime.datetime(2025, 11, 18)


# ─── names ───────────────────────────────────────────────────────────────────

VANSH_TABLE = (
    "| Company | Role | Location | Application/Link | Date Posted |\n"
    "| ------- | ---- | -------- | ---------------- | ----------- |\n"
    "| **Chicago Trading Company** | New Grad 2027: Associate Engineer | Chicago, IL</br>New York, NY | "
    '<a href="https://job-boards.greenhouse.io/ctccampusboard/jobs/4709991005?utm_source=vansh">'
    '<img src="https://i.imgur.com/u1KNU8z.png" width="118" alt="Apply"></a> | Aug 01 |\n'
    "| **Fidelity Investments** | Software Engineer | Westlake, TX</br>Durham, NC | 🔒 | Jul 31 |\n"
    "| **The Boeing Company** | Associate Software Engineer 🛂 | Daytona Beach, FL | 🔒 | Aug 07 |\n"
)


class TestNames:
    def test_bold_company_is_stripped(self, frozen_now):
        [job] = parser.parse_markdown_table(VANSH_TABLE)
        assert job.company == "Chicago Trading Company"
        assert job.title == "New Grad 2027: Associate Engineer"

    @pytest.mark.parametrize("raw, clean", [
        ("**Tesla**", "Tesla"),
        ("__Tesla__", "Tesla"),
        ("`Tesla`", "Tesla"),
        ("*Tesla*", "Tesla"),
        ("  **Tesla**  ", "Tesla"),
        ("<strong>Tesla</strong>", "Tesla"),
        ("🔥 Adobe", "Adobe"),
        ("Procter &amp; Gamble", "Procter & Gamble"),
        ("E*TRADE", "E*TRADE"),
        ("**E*TRADE**", "E*TRADE"),
        ("~~Groundswell~~", "Groundswell"),
    ])
    def test_clean_company_name(self, raw, clean):
        assert clean_company_name(raw) == clean

    def test_bold_title_link_text_is_stripped(self, frozen_now):
        table = (
            "| Company | Job Title | Location | Work Model | Date Posted |\n"
            "| ----- | --------- | --------- | ---- | ------- |\n"
            "| **[Snap Inc.](https://www.snap.com)** | **[Software Engineer, iOS](https://jobright.ai/jobs/info/abc)** "
            "| New York, NY | On Site | Sep 27 |\n"
        )
        [job] = parser.parse_markdown_table(table)
        assert (job.company, job.title) == ("Snap Inc.", "Software Engineer, iOS")
        assert job.company_url == "https://www.snap.com"

    def test_continuation_after_closed_parent_keeps_parent_company(self, frozen_now):
        # negarprh: the Ciena parent row is closed, its ↳ child is open.
        table = (
            "| Company | Role | Location | Apply | Date Posted |\n"
            "|--------|------|----------|:-----:|--------------|\n"
            "| Kinaxis | Developer Intern | Ottawa, ON | [![Apply](https://img.shields.io/badge/-Apply-blue)]"
            "(https://careers-kinaxis.icims.com/jobs/35372/job) | Sep 25, 2026 |\n"
            "| Ciena | Hardware Intern | Ottawa, ON | Closed🔒 | Sep 25, 2026 |\n"
            "| ↳  | Processor Complex Co-op | Ottawa, ON | [![Apply](https://img.shields.io/badge/-Apply-blue)]"
            "(https://ciena.wd5.myworkdayjobs.com/Careers/job/Ottawa/Co-op_R031744) | Sep 25, 2026 |\n"
        )
        jobs = parser.parse_markdown_table(table)
        assert [j.company for j in jobs] == ["Kinaxis", "Ciena"]
        assert jobs[1].title == "Processor Complex Co-op"


# ─── links ───────────────────────────────────────────────────────────────────

class TestLinks:
    def test_badge_link_takes_outer_url(self, frozen_now):
        table = (
            "| Company | Role | Location | Apply | Date Posted |\n"
            "|--------|------|----------|:-----:|--------------|\n"
            "| Kinaxis | Developer Intern | Ottawa, ON | "
            "[![Apply](https://img.shields.io/badge/-Apply-blue?style=for-the-badge)]"
            "(https://careers-kinaxis.icims.com/jobs/35372/job?mobile=true&needsRedirect=false) | Sep 25, 2026 |\n"
        )
        [job] = parser.parse_markdown_table(table)
        assert job.url == "https://careers-kinaxis.icims.com/jobs/35372/job?mobile=true&needsRedirect=false"
        assert "shields.io" not in job.url

    def test_url_with_parentheses_is_not_cut(self, frozen_now):
        url = ("https://careers.acuityinc.com/job/Brossard-Stagiaire-mat%C3%A9riel-(hardware)-Qu%C3%A9b"
               "/1433678100/?ats=successfactors")
        table = (
            "| Company | Role | Location | Apply | Date Posted |\n"
            "|---|---|---|---|---|\n"
            f"| Acuity | Hardware Development Intern | Brossard, QC | [![Apply](https://img.shields.io/badge/-Apply-blue)]({url}) | Sep 24, 2026 |\n"
        )
        [job] = parser.parse_markdown_table(table)
        assert job.url == url

    def test_html_anchor_href_and_company_site(self, frozen_now):
        # speedyapply: HTML company link + 'Posting' header + relative 'Age'.
        table = (
            "| Company | Position | Location | Salary | Posting | Age |\n"
            "|---|---|---|---|---|---|\n"
            '| <a href="https://www.amazon.com"><strong>Amazon</strong></a> | SDE Intern - Summer 2027 | Seattle, WA | $53/hr | '
            '<a href="https://www.amazon.jobs/jobs/10559746/apply"><img src="https://i.imgur.com/JpkfjIq.png" alt="Apply" width="70"/></a> | 2d |\n'
        )
        [job] = parser.parse_markdown_table(table)
        assert job.company == "Amazon"
        assert job.company_url == "https://www.amazon.com"
        assert job.url == "https://www.amazon.jobs/jobs/10559746/apply"
        assert job.posted_date == datetime.datetime(2026, 9, 25)

    def test_several_tables_with_different_columns(self, frozen_now):
        content = (
            "### FAANG+\n\n"
            "| Company | Position | Location | Salary | Posting | Age |\n"
            "|---|---|---|---|---|---|\n"
            '| <a href="https://ramp.com"><strong>Ramp</strong></a> | SWE Intern | New York City, NY | $60/hr | '
            '<a href="https://jobs.ashbyhq.com/ramp/a13ae586"><img src="x.png" alt="Apply"/></a> | 3d |\n'
            "\n### Other\n\n"
            "| Company | Position | Location | Posting | Age |\n"
            "|---|---|---|---|---|\n"
            '| <a href="https://www.notion.com/"><strong>Notion</strong></a> | Mobile Intern | San Francisco, CA +1 | '
            '<a href="https://jobs.ashbyhq.com/notion/2b587e66"><img src="x.png" alt="Apply"/></a> | 5d |\n'
        )
        jobs = parser.parse(content)
        assert [(j.company, j.url) for j in jobs] == [
            ("Ramp", "https://jobs.ashbyhq.com/ramp/a13ae586"),
            ("Notion", "https://jobs.ashbyhq.com/notion/2b587e66"),
        ]

    def test_malformed_url_rejected(self, frozen_now):
        table = (
            "| Company | Role | Location | Application/Link | Date Posted |\n"
            "| --- | --- | --- | --- | --- |\n"
            '| **Thorlabs** | Software Engineer I | Newton, NJ | <a href="https:/.workable.com/thorlabs/j/E79FA34ED4?utm_source=vansh">'
            '<img src="x.png" alt="Apply"></a> | Jul 30 |\n'
            "| **Eluvio** | New Grad | Berkeley, CA | [Apply](https:///.workable.com/eluvio/j/A349A0D2AF) | Jul 30 |\n"
        )
        assert parser.parse_markdown_table(table) == []

    def test_escaped_pipe_stays_inside_its_cell(self, frozen_now):
        # negarprh, 2026-09-29: splitting on the escaped pipe shifted every
        # later cell and all four open Intelcom rows were dropped.
        table = (
            "| Company | Role | Location | Apply | Date Posted |\n"
            "|--------|------|----------|:-----:|--------------|\n"
            "| Intelcom \\| Dragonfly | Data Analyst Intern | Montreal, QC | "
            "[![Apply](https://img.shields.io/badge/-Apply-blue?style=for-the-badge)]"
            "(https://intelcomgroup.wd3.myworkdayjobs.com/Intelcom/job/Canada-Quebec-Montreal/"
            "HR-Data-Analysis-Intern_JR111758-1) | Sep 15, 2026 |\n"
            "| Intelcom \\| Dragonfly | Operations Analyst Intern | Montreal, QC | Closed🔒 | Aug 31, 2026 |\n"
        )
        [open_row, closed_row] = parser.parse_markdown_table(table, include_closed=True)
        assert (open_row.company, open_row.title, open_row.location) == \
            ("Intelcom | Dragonfly", "Data Analyst Intern", "Montreal, QC")
        assert open_row.url.endswith("HR-Data-Analysis-Intern_JR111758-1")
        assert open_row.posted_date == datetime.datetime(2026, 9, 15)
        assert (closed_row.title, closed_row.closed) == ("Operations Analyst Intern", True)

    def test_simplify_html_table(self, frozen_now):
        content = """
<table style="width: 100%;">
<thead>
<tr>
<th style="width: 25%;">Company</th>
<th style="width: 30%;">Role</th>
<th style="width: 20%;">Location</th>
<th style="width: 15%;">Application</th>
<th style="width: 10%;">Age</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong><a href="https://simplify.jobs/c/Varsity-Brands?utm_source=GHList">Varsity Brands</a></strong></td>
<td>Software Engineer 1 - .Net</td>
<td>Memphis, TN</td>
<td><div align="center"><a href="https://careers.varsitybrands.com/global/en/job/JR114518?utm_source=Simplify&ref=Simplify"><img src="https://i.imgur.com/fbjwDvo.png" width="52" alt="Apply"></a> <a href="https://simplify.jobs/p/416e85c5?utm_source=GHList"><img src="https://i.imgur.com/aVnQdox.png" width="28" alt="Simplify"></a></div></td>
<td>1d</td>
</tr>
<tr>
<td>↳</td>
<td>Software Engineer 2</td>
<td>Remote in USA</br>Hanover, MD</td>
<td><div align="center"><a href="https://simplify.jobs/p/aaaa?utm_source=GHList"><img src="s.png" alt="Simplify"></a> <a href="https://careers.varsitybrands.com/global/en/job/JR2"><img src="a.png" alt="Apply"></a></div></td>
<td>1mo</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Toyota?utm_source=GHList">🔥 Toyota</a></strong></td>
<td>Software Engineer - Early Career</td>
<td>Plano, TX</td>
<td>🔒</td>
<td>10d</td>
</tr>
</tbody>
</table>
"""
        jobs = parser.parse(content, include_closed=True)
        assert [(j.company, j.title, j.closed) for j in jobs] == [
            ("Varsity Brands", "Software Engineer 1 - .Net", False),
            ("Varsity Brands", "Software Engineer 2", False),
            ("Toyota", "Software Engineer - Early Career", True),
        ]
        # The employer's link wins over Simplify's, and a simplify.jobs company
        # page is never taken for the company's own site.
        assert jobs[0].url.startswith("https://careers.varsitybrands.com/global/en/job/JR114518")
        assert jobs[1].url == "https://careers.varsitybrands.com/global/en/job/JR2"
        assert jobs[0].company_url is None
        assert jobs[1].location == "Remote in USA Hanover, MD"
        assert jobs[1].posted_date == datetime.datetime(2026, 8, 28)


# ─── closed rows (parser) ────────────────────────────────────────────────────

class TestClosedRows:
    def test_closed_rows_left_out_by_default(self, frozen_now):
        jobs = parser.parse(VANSH_TABLE)
        assert [j.company for j in jobs] == ["Chicago Trading Company"]

    def test_closed_rows_flagged_on_request(self, frozen_now):
        jobs = parser.parse(VANSH_TABLE, include_closed=True)
        closed = [j for j in jobs if j.closed]
        assert [(j.company, j.title, j.url) for j in closed] == [
            ("Fidelity Investments", "Software Engineer", ""),
            ("The Boeing Company", "Associate Software Engineer", ""),
        ]
        # The legend mark leaves the title and becomes a flag.
        assert [j.no_sponsorship for j in closed] == [False, True]

    def test_strikethrough_row_is_closed(self, frozen_now):
        table = (
            "| Company | Role | Location | Application/Link | Date Posted |\n"
            "| --- | --- | --- | --- | --- |\n"
            "| ~~Acme~~ | ~~Software Intern~~ | Austin, TX | [Apply](https://jobs.lever.co/acme/1) | Sep 01 |\n"
        )
        assert parser.parse(table) == []
        [job] = parser.parse(table, include_closed=True)
        assert (job.company, job.title, job.closed) == ("Acme", "Software Intern", True)
        assert job.url == "https://jobs.lever.co/acme/1"


# ─── ingest: clamp + malformed ───────────────────────────────────────────────

class TestIngest:
    def test_future_posted_date_clamped_at_insert(self, db_session):
        source = _source(db_session)
        job = ParsedJob(title="Software Engineer", company="Capgemini",
                        location="Toronto, ON, Canada",
                        url="https://careers.capgemini.com/job/1",
                        posted_date=datetime.datetime(2099, 12, 12))
        before = datetime.datetime.utcnow()
        assert AggregatorService(db_session)._classify_and_store(job, source) is True
        row = db_session.query(ScrapedJob).filter_by(url="https://careers.capgemini.com/job/1").one()
        assert before <= row.posted_date <= datetime.datetime.utcnow()

    def test_malformed_url_never_stored(self, db_session):
        source = _source(db_session)
        job = ParsedJob(title="Software Engineer I", company="Thorlabs",
                        location="Newton, NJ", url="https:/.workable.com/thorlabs/j/E79FA34ED4")
        assert AggregatorService(db_session)._classify_and_store(job, source) is False
        assert db_session.query(ScrapedJob).count() == 0

    @pytest.mark.parametrize("url", [
        "https://jobright.ai/jobs/info/6ab9814d81e327c4bf205bf7",
        "https://zapply.jobs/l/d/workday-homedepot-careerdepot-Req194426?s=gh-new-grad",
        "https://simplify.jobs/p/416e85c5?utm_source=GHList",
    ])
    def test_list_vendor_redirects_never_stored(self, db_session, url):
        source = _source(db_session)
        job = ParsedJob(title="Associate Data Scientist", company="Home Depot",
                        location="Atlanta, GA", url=url)
        assert AggregatorService(db_session)._classify_and_store(job, source) is False
        assert db_session.query(ScrapedJob).count() == 0

    def test_internship_title_on_mixed_list(self, db_session):
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        job = ParsedJob(title="Software Engineering Intern - Summer 2027", company="Ramp",
                        location="New York, NY", url="https://jobs.ashbyhq.com/ramp/1")
        AggregatorService(db_session)._classify_and_store(job, source)
        assert db_session.query(ScrapedJob).one().experience_level == "internship"

    @pytest.mark.parametrize("title, stored", [
        # speedyapply's new-grad files, 2026-09-29: the plainly senior rows.
        ("Software Engineer I -II -III: Simulations", False),
        ("Machine Learning Engineer - II-III - Space Edge Deployment", False),
        ("Software Engineer - ML Infrastructure - Content Retrieval Platform - Level 4", False),
        ("Senior Software Engineer", False),
        # Only the hard markers: a term length, a soft word or a 'Staff'
        # research internship is still a student job on a curated list.
        ("Software Developer Co-op (8 months)", True),
        ("Product Manager Intern", True),
        ("Staff Research Scientist - Intern - PhD Foundational AI", True),
        ("Software Engineer - New Grad (2027)", True),
    ])
    def test_plainly_senior_title_is_not_stored(self, db_session, title, stored):
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        job = ParsedJob(title=title, company="Lodestar", location="Austin, TX",
                        url="https://jobs.lever.co/lodestar/1")
        assert AggregatorService(db_session)._classify_and_store(job, source) is stored
        assert db_session.query(ScrapedJob).count() == int(stored)


# ─── retiring delisted rows ──────────────────────────────────────────────────

class TestRetireDelisted:
    def test_closed_upstream_row_is_removed(self, db_session):
        source = _source(db_session)
        live = _row(db_session, source, "https://job-boards.greenhouse.io/ctccampusboard/jobs/4709991005",
                    company="**Chicago Trading Company**", title="New Grad 2027: Associate Engineer")
        closed = _row(db_session, source, "https://fidelity.wd1.myworkdayjobs.com/x/job/R1",
                      company="**Fidelity Investments**", title="Software Engineer")
        other_source = _source(db_session, url="https://github.com/negarprh/Canadian-Tech-Internships-2027")
        untouched = _row(db_session, other_source, "https://fidelity.wd1.myworkdayjobs.com/x/job/R2",
                         company="Fidelity Investments", title="Software Engineer")

        listed = parser.parse(VANSH_TABLE, include_closed=True)
        svc = AggregatorService(db_session)
        stats = svc._retire_delisted_rows(
            source, svc._listed_urls([j for j in listed if not j.closed]),
            [j for j in listed if j.closed])
        db_session.commit()

        assert stats == {"closed": 1, "vanished": 0}
        assert db_session.get(ScrapedJob, closed.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, closed.id).listing_status_changed_at is not None
        assert db_session.get(ScrapedJob, live.id).listing_status == LISTING_ACTIVE
        assert db_session.get(ScrapedJob, untouched.id).listing_status == LISTING_ACTIVE

    def test_still_listed_url_survives_a_same_named_closed_row(self, db_session):
        # IXL lists the same title twice: one req closed, one still open.
        source = _source(db_session)
        open_row = _row(db_session, source, "https://www.ixl.com/company/careers?gh_jid=8364780002&ref=vansh",
                        company="**IXL Learning**", title="New Grad: Software Engineer")
        table = (
            "| Company | Role | Location | Application/Link | Date Posted |\n"
            "| --- | --- | --- | --- | --- |\n"
            "| **IXL Learning** | New Grad: Software Engineer | Raleigh, NC | "
            '<a href="https://www.ixl.com/company/careers?gh_jid=8364780002&utm_source=vansh&ref=vansh">'
            '<img src="x.png" alt="Apply"></a> | Jan 09 |\n'
            "| **IXL Learning** | New Grad: Software Engineer | San Mateo, CA | 🔒 | May 30 |\n"
        )
        listed = parser.parse(table, include_closed=True)
        svc = AggregatorService(db_session)
        svc._retire_delisted_rows(source, svc._listed_urls([j for j in listed if not j.closed]),
                                  [j for j in listed if j.closed])
        db_session.commit()
        assert db_session.get(ScrapedJob, open_row.id).listing_status == LISTING_ACTIVE

    def test_vanished_rows_removed_but_hidden_rows_untouched(self, db_session):
        source = _source(db_session)
        keep = [_row(db_session, source, f"https://jobs.lever.co/acme/{i}", title=f"Role {i}")
                for i in range(4)]
        gone = _row(db_session, source, "https://jobs.lever.co/acme/old", title="Old role")
        expired = _row(db_session, source, "https://jobs.lever.co/acme/older", title="Older",
                       listing_status=LISTING_EXPIRED)
        svc = AggregatorService(db_session)
        listed_urls = {row.url for row in keep}
        assert svc._retire_delisted_rows(source, listed_urls, []) == {"closed": 0, "vanished": 1}
        db_session.commit()
        assert db_session.get(ScrapedJob, gone.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, expired.id).listing_status == LISTING_EXPIRED
        assert all(db_session.get(ScrapedJob, r.id).listing_status == LISTING_ACTIVE for r in keep)

    def test_mass_vanish_is_treated_as_a_broken_parse(self, db_session):
        source = _source(db_session)
        rows = [_row(db_session, source, f"https://jobs.lever.co/acme/{i}", title=f"Role {i}")
                for i in range(30)]
        svc = AggregatorService(db_session)
        # A README format change: only 2 of 30 stored URLs parsed back.
        stats = svc._retire_delisted_rows(source, {rows[0].url, rows[1].url}, [])
        db_session.commit()
        assert stats == {"closed": 0, "vanished": 0}
        assert all(db_session.get(ScrapedJob, r.id).listing_status == LISTING_ACTIVE for r in rows)


# ─── polling: renames, transient vs permanent errors ─────────────────────────

README = (
    "| Company | Role | Location | Application/Link | Date Posted |\n"
    "| --- | --- | --- | --- | --- |\n"
    "| **Tesla** | Software Engineer | Palo Alto, CA | "
    '<a href="https://www.tesla.com/careers/search/job/256719?utm_source=vansh"><img src="x.png" alt="Apply"></a> | Sep 20 |\n'
    "| **NorthMark Strategies** | New Grad: Software Engineer 🛂 | New York, NY | 🔒 | Aug 20 |\n"
)


def _github_transport(routes: dict, calls: list | None = None) -> httpx.MockTransport:
    """GitHub API routes by path (+query); any other host is a live job page."""
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        if request.url.host != "api.github.com":
            return httpx.Response(200, text="<html><body>Job</body></html>")
        key = request.url.raw_path.decode()
        route = routes.get(key)
        if route is None:
            return httpx.Response(404, json={"message": "Not Found"})
        if isinstance(route, Exception):
            raise route
        status, body = route
        if status in (301, 302, 307):
            return httpx.Response(status, headers={"Location": body})
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, content=json.dumps(body).encode(),
                              headers={"content-type": "application/json"})
    return httpx.MockTransport(handler)


@pytest.fixture
def github(monkeypatch):
    """Route every httpx.AsyncClient the aggregator builds through a mock
    transport, keeping its own kwargs (follow_redirects included)."""
    state = {"routes": {}, "calls": [], "clients": []}
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = _github_transport(state["routes"], state["calls"])
        client = real_client(*args, **kwargs)
        state["clients"].append(client)
        return client

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    monkeypatch.setattr(markdown_parser, "_utcnow", lambda: NOW)
    monkeypatch.setattr(aggregator_module, "_utcnow", lambda: NOW)
    return state


class TestPolling:
    @pytest.mark.asyncio
    async def test_poll_stores_open_rows_and_retires_closed(self, db_session, github):
        source = _source(db_session)
        stale = _row(db_session, source, "https://northmark.wd108.myworkdayjobs.com/NMS/job/R12714?utm_source=vansh",
                     company="**NorthMark Strategies**", title="New Grad: Software Engineer 🛂")
        github["routes"].update({
            "/repos/vanshb03/New-Grad-2027/commits?per_page=1": (200, [{"sha": "abc"}]),
            "/repos/vanshb03/New-Grad-2027/contents/README.md": (200, README),
        })

        assert await AggregatorService(db_session).poll_source(source) == 1

        db_session.refresh(source)
        assert (source.status, source.last_commit_sha, source.error_message) == ("active", "abc@r1", "")
        tesla = db_session.query(ScrapedJob).filter(ScrapedJob.company == "Tesla").one()
        assert tesla.url == "https://www.tesla.com/careers/search/job/256719"
        assert tesla.posted_date == datetime.datetime(2026, 9, 20)
        assert db_session.get(ScrapedJob, stale.id).listing_status == LISTING_REMOVED
        # Every client the poll opened follows redirects (renamed repos answer
        # 301; job pages redirect before they reveal a 404).
        assert github["clients"] and all(c.follow_redirects for c in github["clients"])

    @pytest.mark.asyncio
    async def test_renamed_repo_adopts_new_name(self, db_session, github):
        source = _source(db_session, url="https://github.com/speedyapply/2026-SWE-College-Jobs")
        github["routes"].update({
            "/repos/speedyapply/2026-SWE-College-Jobs/commits?per_page=1":
                (301, "https://api.github.com/repositories/42/commits?per_page=1"),
            "/repositories/42/commits?per_page=1": (200, [{"sha": "new"}]),
            "/repos/speedyapply/2026-SWE-College-Jobs": (301, "https://api.github.com/repositories/42"),
            "/repositories/42": (200, {"full_name": "speedyapply/2027-SWE-College-Jobs"}),
            "/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md": (200, README),
        })

        await AggregatorService(db_session).poll_source(source)

        db_session.refresh(source)
        assert source.repo_owner == "speedyapply"
        assert source.repo_name == "2027-SWE-College-Jobs"
        assert source.repo_url == "https://github.com/speedyapply/2027-SWE-College-Jobs"
        assert (source.status, source.last_commit_sha) == ("active", "new@r1")
        assert any(c.endswith("/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md")
                   for c in github["calls"])

    @pytest.mark.asyncio
    async def test_rename_onto_tracked_repo_parks_the_duplicate(self, db_session, github):
        tracked = _source(db_session, url="https://github.com/vanshb03/Summer2027-Internships")
        old = _source(db_session, url="https://github.com/Ouckah/Summer2025-Internships")
        github["routes"].update({
            "/repos/Ouckah/Summer2025-Internships/commits?per_page=1":
                (301, "https://api.github.com/repositories/7/commits?per_page=1"),
            "/repositories/7/commits?per_page=1": (200, [{"sha": "s"}]),
            "/repos/Ouckah/Summer2025-Internships": (301, "https://api.github.com/repositories/7"),
            "/repositories/7": (200, {"full_name": "vanshb03/Summer2027-Internships"}),
        })

        assert await AggregatorService(db_session).poll_source(old) == 0

        db_session.refresh(old)
        assert old.status == "error"
        assert old.repo_url == "https://github.com/Ouckah/Summer2025-Internships"
        assert old.error_message.startswith("Renamed to vanshb03/Summer2027-Internships")
        assert str(tracked.id) in old.error_message
        assert not is_retryable_error(old.error_message)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", [500, 502, 504, 403, 429])
    async def test_transient_http_error_keeps_source_active(self, db_session, github, status):
        source = _source(db_session)
        github["routes"]["/repos/vanshb03/New-Grad-2027/commits?per_page=1"] = (status, {"message": "x"})

        assert await AggregatorService(db_session).poll_source(source) == 0

        db_session.refresh(source)
        assert source.status == "active"
        assert source.error_message.startswith(f"HTTP {status}")
        assert source.last_polled_at is not None  # rotation still advances

    @pytest.mark.asyncio
    async def test_timeout_keeps_source_active(self, db_session, github):
        source = _source(db_session)
        github["routes"]["/repos/vanshb03/New-Grad-2027/commits?per_page=1"] = httpx.ReadTimeout("slow")

        await AggregatorService(db_session).poll_source(source)

        db_session.refresh(source)
        assert source.status == "active"
        assert source.error_message.startswith("Timeout")

    @pytest.mark.asyncio
    async def test_missing_repo_is_a_permanent_error(self, db_session, github):
        source = _source(db_session, url="https://github.com/jobright-ai/2026-Accounting-Internship")
        # no route: the mock answers 404
        await AggregatorService(db_session).poll_source(source)

        db_session.refresh(source)
        assert source.status == "error"
        assert source.error_message.startswith("HTTP 404")
        assert not is_retryable_error(source.error_message)


class TestRetryRotation:
    @pytest.mark.parametrize("message, retryable", [
        ("HTTP 504: Server error '504 Gateway Timeout'", True),
        ("HTTP 301: Redirect response '301 Moved Permanently'", True),
        ("HTTP 429: Too Many Requests", True),
        ("Timeout: ReadTimeout", True),
        ("Network: ConnectError", True),
        ("Error: Expecting value: line 1 column 1 (char 0)", True),
        ("HTTP 404: Client error '404 Not Found'", False),
        ("HTTP 410: Gone", False),
        ("Renamed to a/b, already tracked by source 3", False),
        ("", False),
    ])
    def test_is_retryable_error(self, message, retryable):
        assert is_retryable_error(message) is retryable

    def test_sources_due_retries_transient_errors_after_cooldown(self, db_session):
        now = datetime.datetime(2026, 9, 27, 12, 0)
        long_ago = now - ERROR_RETRY_COOLDOWN - datetime.timedelta(hours=1)
        recent = now - datetime.timedelta(hours=1)
        active = _source(db_session, url="https://github.com/a/active", last_polled_at=recent,
                         last_commit_sha="abc@r1")
        gateway = _source(db_session, url="https://github.com/a/gateway", status="error",
                          error_message="HTTP 504: Gateway Timeout", last_polled_at=long_ago)
        renamed = _source(db_session, url="https://github.com/a/renamed", status="error",
                          error_message="HTTP 301: Moved Permanently", last_polled_at=None)
        _source(db_session, url="https://github.com/a/cooling", status="error",
                error_message="HTTP 504: Gateway Timeout", last_polled_at=recent)
        _source(db_session, url="https://github.com/a/gone", status="error",
                error_message="HTTP 404: Not Found", last_polled_at=long_ago)
        _source(db_session, url="https://github.com/a/paused", status="paused")

        due = AggregatorService(db_session).sources_due(limit=5, now=now)

        assert [s.id for s in due] == [renamed.id, gateway.id, active.id]

    def test_sources_due_respects_limit(self, db_session):
        for i in range(8):
            _source(db_session, url=f"https://github.com/a/r{i}")
        assert len(AggregatorService(db_session).sources_due(limit=5)) == 5


class TestCronPoll:
    def test_cron_poll_polls_retryable_error_sources(self, client, db_session, monkeypatch):
        import backend.auth.dependencies as auth_deps
        from backend.services import match_notifier

        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        errored = _source(db_session, url="https://github.com/jobright-ai/2026-Support-New-Grad",
                          status="error", error_message="HTTP 504: Gateway Timeout",
                          last_polled_at=datetime.datetime(2026, 8, 22, 20, 44))
        _source(db_session, url="https://github.com/jobright-ai/2026-HR-New-Grad", status="error",
                error_message="HTTP 404: Not Found",
                last_polled_at=datetime.datetime(2026, 8, 22, 20, 44))
        polled: list[str] = []

        async def no_seed(self):
            return {"created": 0, "existing": 0}

        async def fake_poll(self, source):
            polled.append(source.repo_url)
            return 0

        async def no_enrich(self, source_id=None, limit=10):
            return 0

        async def no_alerts(db):
            return {}

        monkeypatch.setattr(AggregatorService, "seed_sources", no_seed)
        monkeypatch.setattr(AggregatorService, "poll_source", fake_poll)
        monkeypatch.setattr(AggregatorService, "_enrich_missing_descriptions", no_enrich)
        monkeypatch.setattr(match_notifier, "sweep_match_alerts", no_alerts)

        resp = client.post("/github-sources/cron-poll", headers={"x-cron-secret": "test-cron-secret"})

        assert resp.status_code == 200, resp.text
        assert polled == [errored.repo_url]

    def test_match_sweep_runs_when_no_source_is_due(self, client, db_session, monkeypatch):
        # The sweep used to sit behind `if not sources: return`: parking or
        # retiring every list would have silently stopped all alert emails.
        import backend.auth.dependencies as auth_deps
        from backend.services import match_notifier

        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        _source(db_session, url="https://github.com/jobright-ai/2026-HR-New-Grad", status="error",
                error_message="HTTP 404: Not Found")
        swept: list[bool] = []

        async def no_seed(self):
            return {"created": 0, "existing": 0}

        async def no_poll(self, source):
            raise AssertionError(f"{source.repo_url} is not due")

        async def no_enrich(self, source_id=None, limit=10):
            return 0

        async def alerts(db):
            swept.append(True)
            return {"status": "completed", "users_scanned": 2}

        monkeypatch.setattr(AggregatorService, "seed_sources", no_seed)
        monkeypatch.setattr(AggregatorService, "poll_source", no_poll)
        monkeypatch.setattr(AggregatorService, "_enrich_missing_descriptions", no_enrich)
        monkeypatch.setattr(match_notifier, "sweep_match_alerts", alerts)

        resp = client.post("/github-sources/cron-poll", headers={"x-cron-secret": "test-cron-secret"})

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert swept == [True]
        assert (body["status"], body["sources_polled"]) == ("no_sources", 0)
        assert body["match_alerts"] == {"status": "completed", "users_scanned": 2}


# ─── review fixes: stale rows, insert order ──────────────────────────────────

# speedyapply's layout: newest first, relative ages.
SPEEDY_README = (
    "| Company | Position | Location | Posting | Age |\n"
    "|---|---|---|---|---|\n"
    '| <a href="https://amazon.com"><strong>Amazon</strong></a> | SDE Intern | Seattle, WA | '
    '<a href="https://www.amazon.jobs/en/jobs/111"><img src="x.png" alt="Apply" width="70"/></a> | 2d |\n'
    '| <a href="https://ramp.com"><strong>Ramp</strong></a> | SWE Intern | New York, NY | '
    '<a href="https://jobs.ashbyhq.com/ramp/abc"><img src="x.png" alt="Apply" width="70"/></a> | 3d |\n'
    '| <a href="https://palantir.com"><strong>Palantir</strong></a> | SWE Intern | New York, NY | '
    '<a href="https://jobs.lever.co/palantir/xyz"><img src="x.png" alt="Apply" width="70"/></a> | 94d |\n'
    '| <a href="https://beaconsoftware.com"><strong>Beacon Software</strong></a> | SWE Intern | '
    'San Francisco, CA | <a href="https://job-boards.greenhouse.io/beacon/jobs/42">'
    '<img src="x.png" alt="Apply" width="70"/></a> | 117d |\n'
)


def _commits(sha: str, when: str | None = None) -> list[dict]:
    commit = {"sha": sha}
    if when:
        commit["commit"] = {"committer": {"date": when}}
    return [commit]


class TestStaleListRows:
    @pytest.mark.asyncio
    async def test_postings_past_max_age_never_become_rows(self, db_session, github, monkeypatch):
        from backend.services import description_extractor

        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        github["routes"].update({
            "/repos/speedyapply/2027-SWE-College-Jobs/commits?per_page=1":
                (200, _commits("s1", "2026-09-27T12:00:00Z")),
            "/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md": (200, SPEEDY_README),
        })
        enriched: list[str] = []

        async def fake_extract(client, url):
            enriched.append(url)
            return "x" * 100

        monkeypatch.setattr(description_extractor, "extract_description_from_url", fake_extract)

        assert await AggregatorService(db_session).poll_source(source) == 2

        rows = db_session.query(ScrapedJob.id, ScrapedJob.company, ScrapedJob.listing_status) \
            .order_by(ScrapedJob.id).all()
        # The 94d and 117d postings are not stored at all (not even hidden),
        # and the fresher of the two stored rows gets the higher id.
        assert [(r.company, r.listing_status) for r in rows] == [
            ("Ramp", LISTING_ACTIVE), ("Amazon", LISTING_ACTIVE)]
        # No probe budget went on them, and enrichment works newest first.
        assert not any("palantir" in c or "beacon" in c for c in github["calls"])
        assert enriched == ["https://www.amazon.jobs/en/jobs/111", "https://jobs.ashbyhq.com/ramp/abc"]
        # Nothing stored is already due for the expiry sweep.
        assert sweep_aggregator_expiry(db_session, now=NOW) == 0

    def test_classify_and_store_skips_posting_past_max_age(self, db_session, monkeypatch):
        monkeypatch.setattr(aggregator_module, "_utcnow", lambda: NOW)
        source = _source(db_session)
        svc = AggregatorService(db_session)
        old = ParsedJob(title="Software Engineer", company="Acme", location="Austin, TX",
                        url="https://jobs.lever.co/acme/old",
                        posted_date=NOW - datetime.timedelta(days=31))
        undated = ParsedJob(title="Software Engineer", company="Acme", location="Austin, TX",
                            url="https://jobs.lever.co/acme/undated")
        edge = ParsedJob(title="Software Engineer", company="Acme", location="Austin, TX",
                         url="https://jobs.lever.co/acme/edge",
                         posted_date=NOW - datetime.timedelta(days=29))
        assert svc._classify_and_store(old, source) is False
        assert svc._classify_and_store(undated, source) is True
        assert svc._classify_and_store(edge, source) is True
        assert {r.url for r in db_session.query(ScrapedJob.url)} == {
            "https://jobs.lever.co/acme/undated", "https://jobs.lever.co/acme/edge"}

    def test_insert_order_is_oldest_first(self):
        day = datetime.datetime(2026, 9, 20)
        jobs = [ParsedJob(title=t, company="A", location="", url=f"https://x.io/{t}", posted_date=d)
                for t, d in [("new", day), ("same_top", day - datetime.timedelta(days=1)),
                             ("same_below", day - datetime.timedelta(days=1)),
                             ("undated", None), ("old", day - datetime.timedelta(days=9))]]
        order = [j.title for j in AggregatorService._oldest_first(jobs)]
        # Same-day ties keep reversed README order (the lists add at the top).
        assert order == ["undated", "old", "same_below", "same_top", "new"]


# ─── review fixes: retirement vs board reconciliation ───────────────────────

class TestRetireRespectsBoards:
    def test_board_reconciled_row_is_left_to_its_board(self, db_session):
        source = _source(db_session)
        listed = _row(db_session, source, "https://jobs.lever.co/acme/listed", title="Listed")
        on_board = _row(db_session, source, "https://job-boards.greenhouse.io/acme/jobs/1", title="Board")
        on_board.board_key = "greenhouse:acme"
        unknown = _row(db_session, source, "https://acme.com/careers/2", title="Unknown")
        unknown.board_key = "unknown"
        plain = _row(db_session, source, "https://acme.com/careers/3", title="Plain")
        db_session.commit()
        svc = AggregatorService(db_session)

        states = []
        for _ in range(2):
            svc._retire_delisted_rows(source, {listed.url}, [])
            db_session.commit()
            db_session.refresh(on_board)
            states.append(on_board.listing_status)
            reconcile_board(db_session, "greenhouse:acme", {on_board.url})
            db_session.refresh(on_board)
            states.append(on_board.listing_status)

        # The board still lists it: no removed/active flip-flop.
        assert states == [LISTING_ACTIVE] * 4
        assert db_session.get(ScrapedJob, unknown.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, plain.id).listing_status == LISTING_REMOVED
        assert db_session.get(ScrapedJob, listed.id).listing_status == LISTING_ACTIVE


# ─── review fixes: renames and seeding ───────────────────────────────────────

# The prod sources parked with 'HTTP 301' on their pre-rename URLs.
PROD_RENAMED = {
    "https://github.com/Ouckah/Summer2025-Internships": "https://github.com/vanshb03/Summer2027-Internships",
    "https://github.com/zapplyjobs/New-Grad-Jobs-2026": "https://github.com/zapplyjobs/underclassmen-internships",
    "https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2026":
        "https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2027",
    "https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2026":
        "https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2027",
    "https://github.com/zapplyjobs/Internships-2026": "https://github.com/zapplyjobs/Internships-2027",
    "https://github.com/speedyapply/2026-SWE-College-Jobs": "https://github.com/speedyapply/2027-SWE-College-Jobs",
    "https://github.com/negarprh/Canadian-Tech-Internships-2026":
        "https://github.com/negarprh/Canadian-Tech-Internships-2027",
}

SUMMER_RENAME_ROUTES = {
    "/repos/Ouckah/Summer2025-Internships/commits?per_page=1":
        (301, "https://api.github.com/repositories/7/commits?per_page=1"),
    "/repositories/7/commits?per_page=1": (200, [{"sha": "s"}]),
    "/repos/Ouckah/Summer2025-Internships": (301, "https://api.github.com/repositories/7"),
    "/repositories/7": (200, {"full_name": "vanshb03/Summer2027-Internships"}),
    "/repos/vanshb03/Summer2027-Internships/contents/README.md": (200, "no table"),
}


class TestRenameSeeding:
    def test_seed_list_carries_current_names_and_former_ones(self):
        by_url = {repo["url"]: repo for repo in AggregatorService.REPOS}
        for old, new in PROD_RENAMED.items():
            assert old not in by_url
            assert old in by_url[new]["renamed_from"]
            assert new.rsplit("/", 1)[-1] in AggregatorService.REPO_CATEGORY_MAP

    @pytest.mark.asyncio
    async def test_seed_sees_a_source_still_on_a_former_name(self, db_session):
        # Prod today: every renamed list still sits on its old URL (matched
        # case-insensitively, as GitHub does).
        for old in PROD_RENAMED:
            _source(db_session, url=old.lower() if "Ouckah" in old else old,
                    status="error", error_message="HTTP 301: Moved Permanently")
        svc = AggregatorService(db_session)

        result = await svc.seed_sources()

        assert result["created"] == len(AggregatorService.REPOS) - len(PROD_RENAMED)
        assert result["existing"] == len(PROD_RENAMED)
        urls = {s.repo_url for s in db_session.query(GitHubSource)}
        assert not urls & set(PROD_RENAMED.values())

    @pytest.mark.asyncio
    async def test_seed_after_rename_adoption_creates_nothing(self, db_session, github):
        svc = AggregatorService(db_session)
        svc.REPOS = [{"url": "https://github.com/vanshb03/Summer2027-Internships",
                      "renamed_from": ["https://github.com/Ouckah/Summer2025-Internships"],
                      "category": "Software Engineering", "level": "internship"}]
        owner = _source(db_session, url="https://github.com/Ouckah/Summer2025-Internships",
                        status="error", error_message="HTTP 301: Moved Permanently")
        assert (await svc.seed_sources())["created"] == 0
        github["routes"].update(SUMMER_RENAME_ROUTES)

        await svc.poll_source(owner)
        db_session.refresh(owner)
        # The README has no job table: the list is parked under its new name.
        assert (owner.status, owner.repo_url) == (
            "parked", "https://github.com/vanshb03/Summer2027-Internships")

        assert (await svc.seed_sources()) == {"created": 0, "existing": 1}
        assert db_session.query(GitHubSource).count() == 1

    @pytest.mark.asyncio
    async def test_rename_onto_tracked_source_hands_it_the_rows(self, db_session, github):
        owner = _source(db_session, url="https://github.com/Ouckah/Summer2025-Internships")
        rows = [_row(db_session, owner, f"https://jobs.lever.co/acme/{i}") for i in range(3)]
        # A new-name source seeded first and parked by a 404 from before the
        # repo took that name.
        tracked = _source(db_session, url="https://github.com/vanshb03/Summer2027-Internships",
                          status="error", error_message="HTTP 404: Not Found")
        github["routes"].update(SUMMER_RENAME_ROUTES)

        assert await AggregatorService(db_session).poll_source(owner) == 0

        db_session.refresh(owner)
        db_session.refresh(tracked)
        assert owner.status == "error"
        assert owner.error_message.startswith("Renamed to vanshb03/Summer2027-Internships")
        assert {db_session.get(ScrapedJob, r.id).github_source_id for r in rows} == {tracked.id}
        # The API just answered for that name: back in rotation.
        assert (tracked.status, tracked.error_message) == ("active", "")
        assert [s.id for s in AggregatorService(db_session).sources_due()] == [tracked.id]


# ─── review fixes: generic failure on a retried source ──────────────────────

class TestGenericErrorRetry:
    @pytest.mark.asyncio
    async def test_generic_error_on_retried_source_stays_retryable(self, db_session, github):
        long_ago = NOW - ERROR_RETRY_COOLDOWN - datetime.timedelta(days=30)
        source = _source(db_session, url="https://github.com/jobright-ai/2026-Consultant-New-Grad",
                         status="error", error_message="HTTP 504: Gateway Timeout",
                         last_polled_at=long_ago)
        svc = AggregatorService(db_session)
        assert [s.id for s in svc.sources_due(now=NOW)] == [source.id]
        # 200 with a body that isn't JSON: the generic handler.
        github["routes"]["/repos/jobright-ai/2026-Consultant-New-Grad/commits?per_page=1"] = (
            200, "<html>oops</html>")

        await svc.poll_source(source)

        db_session.refresh(source)
        assert source.error_message.startswith("Error:")
        later = source.last_polled_at + ERROR_RETRY_COOLDOWN + datetime.timedelta(hours=1)
        assert [s.id for s in svc.sources_due(now=later)] == [source.id]


# ─── review fixes: category and level from the title ────────────────────────

class TestTitleClassification:
    @pytest.mark.parametrize("title, category", [
        ("Data Analytics Intern (Winter 2027)", "Data Analysis"),
        ("Firmware Engineer Intern", "Engineering and Development"),
        ("Software Developer Co-op", "Software Engineering"),
        # A title that says nothing falls back to the list's category.
        ("Intern, Winter 2027", "Software Engineering"),
    ])
    def test_broad_list_rows_classified_by_title(self, db_session, title, category):
        source = _source(db_session, url="https://github.com/negarprh/Canadian-Tech-Internships-2027")
        job = ParsedJob(title=title, company="Kinaxis", location="Ottawa, ON",
                        url="https://kinaxis.wd3.myworkdayjobs.com/x/job/1")
        assert AggregatorService(db_session)._classify_and_store(job, source) is True
        assert db_session.query(ScrapedJob).one().role_category == category

    def test_section_header_still_wins(self, db_session):
        source = _source(db_session, url="https://github.com/jobright-ai/2026-Software-Engineer-Internship")
        job = ParsedJob(title="Data Analytics Intern", company="Acme", location="Austin, TX",
                        url="https://jobs.lever.co/acme/sec", section_category="Marketing")
        AggregatorService(db_session)._classify_and_store(job, source)
        assert db_session.query(ScrapedJob).one().role_category == "Marketing"

    @pytest.mark.parametrize("title", [
        "Software Engineer, Internal Tools",
        "ABAD Systems Engineer (International Assignment)",
        "Software Engineer 1 - OS Internals",
        "Cooperative Systems Engineer",
    ])
    def test_intern_substrings_are_not_internships(self, db_session, title):
        source = _source(db_session, url="https://github.com/vanshb03/New-Grad-2027")
        assert AggregatorService(db_session)._get_experience_level(source, title) == "new_grad"

    @pytest.mark.parametrize("title", [
        "Software Engineer Intern", "SWE Internship - Summer 2027", "Interns 2027",
        "Software Developer Co-op", "Coop - Firmware", "Intern-Summer 2027",
        # speedyapply INTERN_INTL.md, Montreal
        "Développeur Logiciels - Stagiaire - Backend - l'été 2027 - Montreal",
    ])
    def test_internship_words_are_internships(self, db_session, title):
        source = _source(db_session, url="https://github.com/vanshb03/New-Grad-2027")
        assert AggregatorService(db_session)._get_experience_level(source, title) == "internship"

    def test_lowercase_internship_repo_name(self, db_session):
        source = _source(db_session, url="https://github.com/zapplyjobs/underclassmen-internships")
        assert AggregatorService(db_session)._get_experience_level(source, "Analyst") == "internship"


# ─── review fixes: year-less dates across a year boundary ───────────────────

def _dated_table(rows: list[tuple[str, str, bool]]) -> str:
    """vansh layout; rows are (title, date, closed)."""
    lines = ["| Company | Role | Location | Application/Link | Date Posted |",
             "| --- | --- | --- | --- | --- |"]
    for i, (title, date, closed) in enumerate(rows):
        link = "🔒" if closed else f'<a href="https://jobs.lever.co/acme/{i}"><img src="x.png" alt="Apply"></a>'
        lines.append(f"| **Acme** | {title} | Austin, TX | {link} | {date} |")
    return "\n".join(lines) + "\n"


def _dates(jobs) -> dict[str, datetime.date]:
    return {job.title: job.posted_date.date() for job in jobs}


class TestYearWrap:
    # vanshb03/New-Grad-2027 (last commit Aug 21 2026): newest first from
    # Aug 05 2026 down through Oct 16 / Sep 26 (2025) to Apr 12 (2025).
    WRAPPED = [("A", "Aug 05", False), ("B", "Jan 02", False), ("C", "Dec 30", False),
               ("D", "Oct 16", False), ("E", "Sep 26", False), ("F", "Aug 20", False),
               ("G", "Apr 12", False)]
    COMMIT = datetime.datetime(2026, 8, 21, 15, 30)

    def test_rows_below_the_wrap_move_back_a_year(self):
        jobs = parser.parse(_dated_table(self.WRAPPED), now=self.COMMIT)
        assert _dates(jobs) == {
            "A": datetime.date(2026, 8, 5), "B": datetime.date(2026, 1, 2),
            "C": datetime.date(2025, 12, 30), "D": datetime.date(2025, 10, 16),
            "E": datetime.date(2025, 9, 26), "F": datetime.date(2025, 8, 20),
            "G": datetime.date(2025, 4, 12),
        }

    def test_wall_clock_anchor_gets_the_same_dates(self, frozen_now):
        # Without the commit time, 'Sep 26' used to become 2026-09-26.
        jobs = parser.parse(_dated_table(self.WRAPPED))
        assert _dates(jobs)["E"] == datetime.date(2025, 9, 26)
        assert _dates(jobs)["F"] == datetime.date(2025, 8, 20)

    def test_closed_rows_listed_after_the_open_ones_are_their_own_run(self):
        # vansh lists open rows first, then closed rows, each newest first.
        rows = self.WRAPPED + [("H", "Jul 31", True), ("I", "Apr 25", True),
                               ("J", "Feb 15", True), ("K", "Dec 12", True),
                               ("L", "Aug 10", True)]
        jobs = parser.parse(_dated_table(rows), include_closed=True, now=self.COMMIT)
        dates = _dates(jobs)
        assert dates["G"] == datetime.date(2025, 4, 12)
        assert (dates["H"], dates["I"], dates["J"]) == (
            datetime.date(2026, 7, 31), datetime.date(2026, 4, 25), datetime.date(2026, 2, 15))
        assert (dates["K"], dates["L"]) == (datetime.date(2025, 12, 12), datetime.date(2025, 8, 10))

    def test_unsorted_table_left_alone(self):
        rows = [("A", "Jan 05", False), ("B", "Aug 15", False), ("C", "Mar 03", False),
                ("D", "Aug 01", False), ("E", "Feb 02", False), ("F", "Jul 20", False)]
        jobs = parser.parse(_dated_table(rows), now=self.COMMIT)
        assert all(d.year == 2026 for d in _dates(jobs).values())

    def test_out_of_order_fresh_row_keeps_its_year(self):
        # A new row slipped in under older ones is weeks off, not a wrap.
        rows = [("A", "Aug 18", False), ("B", "Jul 10", False), ("C", "Aug 15", False),
                ("D", "Jul 01", False), ("E", "Jun 20", False), ("F", "Jun 01", False)]
        jobs = parser.parse(_dated_table(rows), now=self.COMMIT)
        assert _dates(jobs)["C"] == datetime.date(2026, 8, 15)

    # A few rows the table jumps back up from are strays, not a wrap. Taken as
    # the row above, one moved every row under it back a year, and the max-age
    # skip then dropped them all before insert.
    POLLED = datetime.datetime(2026, 9, 28, 12, 0)
    RECENT = [("R1", "Sep 27", False), ("R2", "Sep 26", False), ("R3", "Sep 25", False),
              ("R4", "Sep 24", False), ("R5", "Sep 23", False), ("R6", "Sep 22", False)]

    def _assert_recent_rows_kept(self, jobs):
        recent = [job for job in jobs if job.title.startswith("R")]
        assert [job.posted_date.date() for job in recent] == [
            datetime.date(2026, 9, day) for day in (27, 26, 25, 24, 23, 22)]
        assert not any(AggregatorService._past_max_age(job, self.POLLED) for job in recent)

    @pytest.mark.parametrize("stray", [
        ["Sep 30"],  # two days past the commit, so read as last year's
        ["Sep 30", "Sep 30"],
        ["Feb 10"],
    ])
    def test_stray_rows_on_top_leave_the_rows_below_alone(self, stray):
        rows = [(f"S{i}", date, False) for i, date in enumerate(stray)] + self.RECENT
        self._assert_recent_rows_kept(parser.parse(_dated_table(rows), now=self.POLLED))

    @pytest.mark.parametrize("stray, left_as", [
        (["Feb 10"], datetime.date(2026, 2, 10)),
        (["Mar 01"], datetime.date(2026, 3, 1)),
        (["Feb 10", "Feb 10", "Feb 09"], datetime.date(2026, 2, 10)),
    ])
    def test_stray_rows_in_the_middle_leave_the_rows_below_alone(self, stray, left_as):
        rows = (self.RECENT[:4] + [(f"S{i}", date, False) for i, date in enumerate(stray)]
                + self.RECENT[4:])
        jobs = parser.parse(_dated_table(rows), now=self.POLLED)
        self._assert_recent_rows_kept(jobs)
        assert _dates(jobs)["S0"] == left_as

    def test_list_gone_quiet_still_wraps(self):
        # vansh's newest row is Aug 05 2026. A commit five months later that
        # adds no rows moves the wrap up under less than half a year of rows;
        # the rows below it are still last year's, not fresh postings.
        rows = [("A", "Aug 05", False), ("B", "Jul 10", False), ("C", "Jun 02", False),
                ("D", "May 15", False), ("E", "Apr 20", False), ("F", "Mar 25", False),
                ("G", "Mar 01", False), ("H", "Feb 10", False), ("I", "Jan 12", False),
                ("J", "Dec 15", False), ("K", "Nov 20", False), ("L", "Oct 16", False),
                ("M", "Sep 26", False)]
        quiet_commit = datetime.datetime(2027, 2, 25, 12, 0)
        jobs = parser.parse(_dated_table(rows), now=quiet_commit)
        assert _dates(jobs) == _dates(parser.parse(_dated_table(rows), now=self.COMMIT))
        assert _dates(jobs)["H"] == datetime.date(2026, 2, 10)
        assert _dates(jobs)["M"] == datetime.date(2025, 9, 26)
        assert all(AggregatorService._past_max_age(job, quiet_commit) for job in jobs)

    @pytest.mark.asyncio
    async def test_poll_reads_dates_as_of_the_commit(self, db_session, github):
        source = _source(db_session, url="https://github.com/speedyapply/2027-SWE-College-Jobs")
        github["routes"].update({
            "/repos/speedyapply/2027-SWE-College-Jobs/commits?per_page=1":
                (200, _commits("s2", "2026-09-20T12:00:00Z")),
            "/repos/speedyapply/2027-SWE-College-Jobs/contents/README.md": (200, SPEEDY_README),
        })

        await AggregatorService(db_session).poll_source(source)

        amazon = db_session.query(ScrapedJob).filter(ScrapedJob.company == "Amazon").one()
        # '2d' in a README committed Sep 20 is Sep 18, not two days before this poll.
        assert amazon.posted_date == datetime.datetime(2026, 9, 18)
