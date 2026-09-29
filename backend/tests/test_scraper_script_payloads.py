"""The JobSpy and LinkedIn scraper scripts: payloads that httpx can always
send, the LinkedIn locations JobSpy blanks, and the ingest-batch counters the
run logs.

A live JobSpy 1.1.82 scrape (2026-09) gave 1 row in 161 a NaN company. NaN is
truthy, so ``value or ""`` passed it through, and httpx 0.28's JSON encoder
(allow_nan=False) then refused the whole chunk of up to 100 jobs.
"""

import importlib.util
import json
import math
import pathlib

import httpx
import pytest

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob


def _script(name):
    path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def jobspy():
    return _script("scrape_jobspy")


def _row(**cells):
    row = {"title": "Software Intern", "company": "Acme", "location": "Toronto, ON, CA",
           "job_url": "https://ca.indeed.com/viewjob?jk=1", "site": "indeed"}
    row.update(cells)
    return row


def _all_text(payload):
    return all(isinstance(value, str) for value in payload.values())


# ─── Empty pandas cells ──────────────────────────────────────────────────────

def test_a_dataframe_row_with_nan_cells_becomes_a_sendable_payload(jobspy):
    """The script's own path: scrape_jobs' DataFrame, row.to_dict(), to_payload."""
    pd = pytest.importorskip("pandas")
    no_company = _row(job_url="https://ca.indeed.com/viewjob?jk=nan-company")
    del no_company["company"]
    sparse = _row(job_url="https://ca.indeed.com/viewjob?jk=sparse")
    del sparse["location"]
    full = _row(job_url="https://ca.indeed.com/viewjob?jk=full", is_remote=True,
                date_posted="2026-09-25", company_logo="https://logo.example/a.png",
                company_url_direct="https://acme.example")
    # A cell a row lacks is NaN in the frame, as in scrape_jobs' output.
    frame = pd.DataFrame([no_company, sparse, full])
    rows = [row.to_dict() for _, row in frame.iterrows()]
    assert math.isnan(rows[0]["company"]) and math.isnan(rows[1]["is_remote"])

    payloads = [jobspy.to_payload(row) for row in rows]

    assert payloads[0] is None  # no company: not a job we can store
    sparse, full = payloads[1], payloads[2]
    assert _all_text(sparse) and _all_text(full)
    json.dumps([sparse, full], allow_nan=False)
    assert sparse["location"] == ""
    assert sparse["work_type"] == "onsite"  # a NaN is_remote is truthy, not remote
    assert not {"posted_date", "company_logo", "company_url"} & sparse.keys()
    assert full["work_type"] == "remote"
    assert full["posted_date"] == "2026-09-25"


@pytest.mark.parametrize("empty", [float("nan"), None, "nan", "NaT", ""])
@pytest.mark.parametrize("cell", ["title", "company", "job_url"])
def test_a_row_without_title_company_or_url_is_skipped(jobspy, cell, empty):
    assert jobspy.to_payload(_row(**{cell: empty})) is None


@pytest.mark.parametrize("empty", [float("nan"), None, "nan", "NaT"])
def test_empty_optional_cells_read_as_empty_text(jobspy, empty):
    payload = jobspy.to_payload(_row(location=empty, site=empty, is_remote=empty,
                                     date_posted=empty, company_logo=empty,
                                     company_url_direct=empty))
    assert _all_text(payload)
    json.dumps(payload, allow_nan=False)
    assert payload["location"] == ""
    assert payload["source_platform"] == "indeed"
    assert payload["work_type"] == "onsite"
    assert "posted_date" not in payload


def test_json_compliant_rejects_what_httpx_refuses(jobspy):
    assert jobspy.json_compliant({"company": "Acme"})
    assert not jobspy.json_compliant({"company": float("nan")})
    assert not jobspy.json_compliant({"company": float("inf")})


# ─── Pushing: counters, and one bad job never sinks its chunk ───────────────

def _fake_api(monkeypatch, module, response):
    """Route the script's AsyncClient to an in-process handler; returns the
    list of job batches the "API" received."""
    received = []

    def handler(request):
        received.append(json.loads(request.content)["jobs"])
        return httpx.Response(200, json=response)

    real = httpx.AsyncClient
    monkeypatch.setattr(module.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return received


def test_an_unencodable_job_is_dropped_alone(jobspy, monkeypatch):
    received = _fake_api(monkeypatch, jobspy, {"created": 1})
    good = jobspy.to_payload(_row())
    bad = dict(good, url="https://ca.indeed.com/viewjob?jk=2", company=float("nan"))

    totals = jobspy.asyncio.run(jobspy.push_batches([good, bad]))

    assert received == [[good]]
    assert (totals["created"], totals["errors"]) == (1, 1)


@pytest.mark.parametrize("name", ["scrape_jobspy", "scrape_linkedin"])
def test_every_ingest_counter_is_summed_and_logged(name, monkeypatch):
    module = _script(name)
    response = {"received": 3, "created": 1, "duplicates": 2, "cross_source_twins_skipped": 1,
                "skipped": 0, "senior_skipped": 4}
    received = _fake_api(monkeypatch, module, response)
    monkeypatch.setattr(module, "BATCH_SIZE", 1)
    jobs = [{"title": "Software Intern", "company": "Acme", "url": f"https://x.example/{i}"}
            for i in range(2)]

    totals = module.asyncio.run(module.push_batches(jobs))

    assert len(received) == 2
    assert totals == {"created": 2, "duplicates": 4, "cross_source_twins_skipped": 2,
                      "skipped": 0, "senior_skipped": 8, "errors": 0}
    line = module.results_line(totals)
    assert "8 senior titles skipped" in line
    assert "(2 cross-source twins)" in line
    assert "4 duplicates" in line and "2 created" in line and "0 errors" in line


# ─── LinkedIn rows JobSpy left without a location ───────────────────────────
# JobSpy 1.1.82 displays a one-part LinkedIn location ("Canada", "United
# States", "Greater Vancouver Metropolitan Area") as "". The live scrape's two
# such rows were both Canadian; a "United States" card would have been sent
# as "CA" all the same.

def test_a_linkedin_row_without_location_sends_no_country(jobspy):
    payload = jobspy.to_payload(_row(site="linkedin", location="",
                                     job_url="https://www.linkedin.com/jobs/view/4470371715"))
    assert payload["country"] == ""


def test_an_indeed_row_without_location_stays_canadian(jobspy):
    """Indeed rows come from ca.indeed.com (country_indeed="Canada")."""
    assert jobspy.to_payload(_row(location=float("nan")))["country"] == "CA"


def _posting(location):
    return (
        '<h4 class="top-card-layout__second-subline"><div class="topcard__flavor-row">'
        '<span class="topcard__flavor"><a class="topcard__org-name-link">Acme</a></span>'
        '<span class="topcard__flavor topcard__flavor--bullet">\n'
        f'          {location}\n        </span></div></h4>'
    )


def _lookup(jobspy, jobs, pages, monkeypatch):
    monkeypatch.setattr(jobspy, "LOOKUP_DELAY_S", 0)
    requested = []

    def handler(request):
        job_id = request.url.path.rsplit("/", 1)[-1]
        requested.append(job_id)
        page = pages.get(job_id)
        if isinstance(page, Exception):
            raise page
        return httpx.Response(200, text=page) if page else httpx.Response(404)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await jobspy.recover_linkedin_locations(jobs, client)

    return jobspy.asyncio.run(run()), requested


def test_a_blanked_linkedin_location_is_read_back_from_the_posting(jobspy, monkeypatch):
    def linkedin(job_id, location=""):
        return _row(site="linkedin", location=location,
                    job_url=f"https://www.linkedin.com/jobs/view/{job_id}")

    jobs = [
        linkedin(1),
        linkedin(2),
        linkedin(3),
        linkedin(4),
        linkedin(5, "Toronto, ON"),        # JobSpy kept it: no lookup
        _row(location=""),                  # Indeed: no lookup
    ]
    pages = {
        "1": _posting("Greater Vancouver Metropolitan Area"),
        "2": None,                                       # 404
        "3": httpx.ConnectError("boom"),
        "4": _posting(" "),                              # the page shows none
    }

    recovered, requested = _lookup(jobspy, jobs, pages, monkeypatch)

    assert recovered == 1
    assert requested == ["1", "2", "3", "4"]
    assert jobs[0]["location"] == "Greater Vancouver Metropolitan Area"
    assert jobs[1]["location"] == jobs[2]["location"] == jobs[3]["location"] == ""
    payloads = [jobspy.to_payload(job) for job in jobs]
    assert payloads[0]["location"] == "Greater Vancouver Metropolitan Area"
    assert payloads[0]["country"] == "CA"      # the API re-derives it from the text too
    assert payloads[1]["country"] == payloads[2]["country"] == payloads[3]["country"] == ""


def test_location_lookups_are_capped_per_run(jobspy, monkeypatch):
    monkeypatch.setattr(jobspy, "MAX_LOCATION_LOOKUPS", 2)
    jobs = [_row(site="linkedin", location="", job_url=f"https://www.linkedin.com/jobs/view/{i}")
            for i in range(5)]

    recovered, requested = _lookup(jobspy, jobs, {str(i): _posting("Canada") for i in range(5)},
                                   monkeypatch)

    assert (recovered, requested) == (2, ["0", "1"])


# ─── What ingest-batch does with the empty country ──────────────────────────

@pytest.mark.parametrize("location, stored", [
    ("", ""),                                   # nothing to go on: no guess
    ("Canada", "CA"),
    ("United States", "US"),
    ("Greater Vancouver Metropolitan Area", "CA"),
])
def test_ingest_batch_derives_or_leaves_an_unsent_country(jobspy, client, db_session,
                                                          monkeypatch, location, stored):
    """The API's half: a payload that sends no country gets one from its
    location, and none at all when there is no location."""
    monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
    payload = jobspy.to_payload(_row(site="linkedin", location="",
                                     job_url="https://www.linkedin.com/jobs/view/4470371715"))
    assert payload["country"] == ""
    payload["location"] = location

    res = client.post("/jobs/ingest-batch", json={"jobs": [payload]},
                      headers={"x-cron-secret": "test-cron-secret"})

    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    assert db_session.query(ScrapedJob).one().country == stored
