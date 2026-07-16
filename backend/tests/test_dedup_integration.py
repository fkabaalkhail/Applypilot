"""Ingest + listing integration for cross-source dedup."""

import backend.auth.dependencies as auth_deps
from backend.db.models import ScrapedJob, UserSavedJob, User
from backend.services.cross_source_dedup import normalize_title
from backend.services.location_parser import location_fields

SECRET = "test-cron-secret"


def _cron_headers(monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


def _mk(db_session, url, *, source="ats", title="Software Engineer Intern",
        company="Kinaxis", domain="kinaxis.com", location="Ottawa, ON, CA",
        description="Real description " * 10, duplicate_of=None):
    row = ScrapedJob(
        title=title, company=company, url=url, location=location,
        description=description, country="CA", work_type="onsite",
        source_platform=source, experience_level="internship", easy_apply=0,
        match_score=0, company_domain=domain, title_norm=normalize_title(title),
        duplicate_of=duplicate_of, **location_fields(location),
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_ingest_batch_skips_linkedin_twin_of_direct_row(client, db_session, monkeypatch):
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/100", source="ats")
    payload = {"jobs": [{
        "title": "Software Engineer Intern (Summer 2026)",
        "company": "Kinaxis",
        "location": "Ottawa, ON, CA",
        "url": "https://linkedin.com/jobs/view/100",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["created"] == 0
    assert body["cross_source_twins_skipped"] == 1
    assert db_session.query(ScrapedJob).filter(
        ScrapedJob.url == "https://linkedin.com/jobs/view/100"
    ).first() is None


def test_ingest_batch_still_inserts_when_no_twin(client, db_session, monkeypatch):
    payload = {"jobs": [{
        "title": "Robotics Intern",
        "company": "NoTwin Corp",
        "location": "Halifax, NS, CA",
        "url": "https://linkedin.com/jobs/view/101",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.json()["created"] == 1
    row = db_session.query(ScrapedJob).filter(
        ScrapedJob.url == "https://linkedin.com/jobs/view/101"
    ).one()
    assert row.title_norm == "robotics intern"


def test_cron_ats_hides_preexisting_linkedin_twin(client, db_session, monkeypatch):
    from backend.data import company_registry
    from backend.services.ats_scraper import ATSJob, ATSScraper, BoardSnapshot

    twin = _mk(
        db_session, "https://linkedin.com/jobs/view/102", source="linkedin",
        description="",
    )

    monkeypatch.setattr(
        company_registry, "load_companies",
        lambda **kw: [("greenhouse", "kinaxis", "Kinaxis")],
    )

    async def fake_scrape_board(self, client, platform, slug, company_name):
        job = ATSJob(
            title="Software Engineer Intern (Summer 2026)",
            company="Kinaxis",
            location="Ottawa, Ontario, Canada",
            url="https://boards.greenhouse.io/kinaxis/jobs/101",
            description="Full posting text " * 20,
        )
        return BoardSnapshot(platform=platform, slug=slug, company=company_name,
                             jobs=[job], all_urls={job.url})

    monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)
    res = client.post("/github-sources/cron-ats", headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["new_jobs"] == 1
    assert body["cross_source_twins_hidden"] == 1
    db_session.refresh(twin)
    winner = db_session.query(ScrapedJob).filter(
        ScrapedJob.url == "https://boards.greenhouse.io/kinaxis/jobs/101"
    ).one()
    assert twin.duplicate_of == winner.id


def test_listing_hides_duplicates_but_liked_keeps_them(client, db_session):
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/103", source="ats")
    hidden = _mk(db_session, "https://linkedin.com/jobs/view/103", source="linkedin",
                 duplicate_of=winner.id)

    res = client.get("/jobs", params={"page_size": 200})
    urls = [j["url"] for j in res.json()]
    assert winner.url in urls
    assert hidden.url not in urls

    # A user who saved the hidden twin must still see it in Liked.
    user = User(id=1, email="t@example.com", hashed_password="x")
    db_session.merge(user)
    db_session.add(UserSavedJob(user_id=1, job_id=hidden.id))
    db_session.commit()
    res = client.get("/jobs", params={"saved": 1, "page_size": 200})
    assert any(j["url"] == hidden.url for j in res.json())

    # Direct fetch still works for hidden rows.
    assert client.get(f"/jobs/{hidden.id}").status_code == 200


def test_pagination_is_stable_across_timestamp_ties(client, db_session):
    import datetime
    stamp = datetime.datetime(2026, 7, 1, 12, 0, 0)
    for i in range(60):
        row = ScrapedJob(
            title=f"Engineer {i}", company="Acme", url=f"https://x.test/page/{i}",
            location="Ottawa, ON, CA", description="", country="CA",
            work_type="onsite", source_platform="ats", experience_level="new_grad",
            easy_apply=0, match_score=0, posted_date=stamp, scraped_at=stamp,
            title_norm=f"engineer {i}", **location_fields("Ottawa, ON, CA"),
        )
        db_session.add(row)
    db_session.commit()

    page1 = {j["id"] for j in client.get("/jobs", params={"page_size": 30, "page": 1}).json()}
    page2 = {j["id"] for j in client.get("/jobs", params={"page_size": 30, "page": 2}).json()}
    assert len(page1) == 30 and len(page2) == 30
    assert page1.isdisjoint(page2), "same job must never appear on two pages"


def test_stats_and_cities_exclude_duplicates(client, db_session):
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/104", source="ats")
    _mk(db_session, "https://linkedin.com/jobs/view/104", source="linkedin",
        duplicate_of=winner.id)

    stats = client.get("/jobs/stats").json()
    assert stats["total"] == 1

    cities = client.get("/jobs/cities", params={"country": "CA"}).json()
    ottawa = next(c for c in cities if c["city"] == "Ottawa")
    assert ottawa["count"] == 1
