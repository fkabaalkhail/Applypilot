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

    def test_two_day_tolerance_for_timezone_skew(self):
        assert parse_listing_date("Sep 29", now=NOW) == datetime.datetime(2026, 9, 29)
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
            ("The Boeing Company", "Associate Software Engineer 🛂", ""),
        ]

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
    '<a href="https://www.tesla.com/careers/search/job/256719?utm_source=vansh"><img src="x.png" alt="Apply"></a> | Nov 10 |\n'
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
        assert (source.status, source.last_commit_sha, source.error_message) == ("active", "abc", "")
        tesla = db_session.query(ScrapedJob).filter(ScrapedJob.company == "Tesla").one()
        assert tesla.url == "https://www.tesla.com/careers/search/job/256719"
        assert tesla.posted_date == datetime.datetime(2025, 11, 10)
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
        assert (source.status, source.last_commit_sha) == ("active", "new")
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
        active = _source(db_session, url="https://github.com/a/active", last_polled_at=recent)
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
