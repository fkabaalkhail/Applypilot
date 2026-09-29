"""Ingest paths must populate structured location fields and never guess
icon.horse domains."""

import pytest

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob

SECRET = "test-cron-secret"


def _cron_headers(monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def test_ingest_batch_populates_location_fields(client, db_session, monkeypatch):
    payload = {"jobs": [{
        "title": "Software Intern",
        "company": "Kinaxis",
        "location": "Ottawa, ON, CA",
        "url": "https://example.com/jobs/ottawa-1",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/ottawa-1")
        .one()
    )
    assert row.city == "ottawa"
    assert row.region == "ON"
    assert "|ottawa|" in row.location_search
    assert row.locations_json[0]["city"] == "Ottawa"
    assert "icon.horse" not in (row.company_logo or "")
    assert row.company_domain == "kinaxis.com"


def test_ingest_batch_keeps_scraper_supplied_logo(client, db_session, monkeypatch):
    """A real logo the scraper captured (e.g. LinkedIn's media.licdn.com image)
    must be stored instead of the name-guessed favicon that renders as a letter
    avatar."""
    real_logo = "https://media.licdn.com/dms/image/v2/abc/company-logo_100_100/x"
    payload = {"jobs": [{
        "title": "Software Intern",
        "company": "Some Startup",
        "location": "Toronto, ON, CA",
        "url": "https://example.com/jobs/logo-1",
        "source_platform": "linkedin",
        "country": "CA",
        "experience_level": "internship",
        "company_logo": real_logo,
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/logo-1")
        .one()
    )
    assert row.company_logo == real_logo


def test_ingest_batch_falls_back_to_resolved_logo(client, db_session, monkeypatch):
    """Without a scraper logo, ingest still resolves a domain-based one."""
    payload = {"jobs": [{
        "title": "Software Intern",
        "company": "Shopify",
        "location": "Ottawa, ON, CA",
        "url": "https://example.com/jobs/logo-2",
        "source_platform": "linkedin",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/logo-2")
        .one()
    )
    assert row.company_domain == "shopify.com"
    assert row.company_logo  # a resolved favicon URL, not empty


def test_ingest_batch_multi_location_blob(client, db_session, monkeypatch):
    payload = {"jobs": [{
        "title": "EPM Consultant",
        "company": "Acme",
        "location": "Ottawa,Ontario,Canada; Kraków,Kraków,Poland",
        "url": "https://example.com/jobs/multi-1",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "new_grad",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    row = (
        db_session.query(ScrapedJob)
        .filter(ScrapedJob.url == "https://example.com/jobs/multi-1")
        .one()
    )
    assert "|ottawa|" in row.location_search
    assert "|krakow|" in row.location_search
    assert len(row.locations_json) == 2


# ─── Country: derived server-side, not trusted from the client ──────────────

@pytest.mark.parametrize("location, sent, stored", [
    # The LinkedIn script's ", ca" test matched ", canada": 653 visible rows.
    ("Toronto, Ontario, Canada", "US", "CA"),
    ("Calgary, Alberta, Canada", "US", "CA"),
    ("Seattle, WA, United States", "CA", "US"),
    ("Austin, TX, US", "CA", "US"),           # JobSpy: the tail is the ISO country
    ("Toronto, ON, CA", "US", "CA"),
    ("San Francisco, CA", "CA", "US"),
    # Nothing either way, or only a bare "CA" (JobSpy's Indeed "Remote, CA"
    # is ISO Canada): the client's value stands.
    ("Hybrid", "CA", "CA"),
    ("Remote, CA", "CA", "CA"),
])
def test_ingest_batch_derives_the_country(client, db_session, monkeypatch, location, sent, stored):
    url = "https://www.linkedin.com/jobs/view/" + "".join(c for c in location if c.isalnum())
    payload = {"jobs": [{
        "title": "Software Intern", "company": "Acme", "location": location, "url": url,
        "source_platform": "linkedin", "work_type": "onsite", "country": sent,
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    assert db_session.query(ScrapedJob).filter(ScrapedJob.url == url).one().country == stored


def _script(name):
    import importlib.util
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("location, country", [
    ("Calgary, Alberta, Canada", "CA"),
    ("Toronto, ON", "CA"),
    ("Greater Toronto Area", "CA"),
    ("Seattle, WA, United States", "US"),
    ("San Francisco, CA", "US"),        # uppercase: California
    ("United States", "US"),
])
def test_linkedin_script_country(location, country):
    module = _script("scrape_linkedin")
    job = module.Job(title="Software Intern", company="Acme", location=location,
                     url="https://www.linkedin.com/jobs/view/1")
    assert module.to_payload(job)["country"] == country


@pytest.mark.parametrize("row, country", [
    ({"location": "Toronto, ON, CA"}, "CA"),
    ({"location": "Austin, TX, US"}, "US"),
    ({"city": "San Jose", "state": "CA"}, "US"),
    ({"city": "Ottawa", "state": "ON"}, "CA"),
])
def test_jobspy_script_country(row, country):
    module = _script("scrape_jobspy")
    payload = module.to_payload({"title": "Software Intern", "company": "Acme",
                                 "job_url": "https://ca.indeed.com/viewjob?jk=1",
                                 "site": "indeed", **row})
    assert payload["country"] == country


# ─── Seniority: plainly senior titles are not stored ─────────────────────────

def test_ingest_batch_skips_hard_senior_titles(client, db_session, monkeypatch):
    """LinkedIn/Indeed searches are scoped to entry level, yet 89 visible rows
    were senior (2026-09). Only ats_scraper.HARD_SENIOR vetoes here: "Software
    Engineer II" is a soft marker and stays, and the crawler's weak-tier and
    frontline rules never apply to aggregator titles."""
    titles = {
        "Senior HR Specialist": False,
        "Director of Engineering": False,
        "Senior Java Full Stack Developer - Vice President": False,
        "Software Engineer (L5)": False,
        "Software Engineer II": True,
        "Operations Associate, Dallas, #118": True,
        "Software Engineering Intern - 8 months": True,
    }
    jobs = [{
        "title": title, "company": "Acme", "location": "Toronto, ON, CA",
        "url": (f"https://ca.indeed.com/viewjob?jk=senior{i}" if i % 2
                else f"https://www.linkedin.com/jobs/view/{4100 + i}"),
        "source_platform": "indeed" if i % 2 else "linkedin",
        "country": "CA", "experience_level": "new_grad",
    } for i, title in enumerate(titles)]

    res = client.post("/jobs/ingest-batch", json={"jobs": jobs}, headers=_cron_headers(monkeypatch))

    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["created"], body["senior_skipped"], body["skipped"]) == (3, 4, 0)
    stored = {row.title for row in db_session.query(ScrapedJob).all()}
    assert stored == {title for title, kept in titles.items() if kept}
