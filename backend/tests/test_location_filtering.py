"""Token-boundary location filtering: Ottawa means Ottawa, not Ontario."""

from backend.db.models import ScrapedJob
from backend.services.location_parser import location_fields


def _mk(db_session, url, location, country="CA", work_type="onsite"):
    row = ScrapedJob(
        title="Engineer", company="Acme", url=url, location=location,
        description="", country=country, work_type=work_type,
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0, **location_fields(location),
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_ottawa_excludes_toronto_and_london(client, db_session):
    _mk(db_session, "https://x.test/1", "Ottawa, Ontario, Canada")
    _mk(db_session, "https://x.test/2", "Toronto, Ontario, Canada")
    _mk(db_session, "https://x.test/3", "London, Ontario, Canada")
    res = client.get("/jobs", params={"location": "Ottawa"})
    urls = [j["url"] for j in res.json()]
    assert "https://x.test/1" in urls
    assert "https://x.test/2" not in urls
    assert "https://x.test/3" not in urls


def test_city_with_region_tag_equals_city(client, db_session):
    _mk(db_session, "https://x.test/4", "Ottawa, ON, CA")
    res = client.get("/jobs", params={"location": "Ottawa, ON"})
    assert any(j["url"] == "https://x.test/4" for j in res.json())
    res2 = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/4" for j in res2.json())


def test_multi_tag_semicolon_or(client, db_session):
    _mk(db_session, "https://x.test/5", "Ottawa, ON, CA")
    _mk(db_session, "https://x.test/6", "Calgary, AB, CA")
    _mk(db_session, "https://x.test/7", "Toronto, ON, CA")
    res = client.get("/jobs", params={"location": "Ottawa;Calgary"})
    urls = [j["url"] for j in res.json()]
    assert "https://x.test/5" in urls and "https://x.test/6" in urls
    assert "https://x.test/7" not in urls


def test_multi_city_blob_matches_each_city(client, db_session):
    _mk(db_session, "https://x.test/8",
        "Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland")
    res = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/8" for j in res.json())


def test_legacy_rows_fall_back_to_substring(client, db_session):
    row = ScrapedJob(
        title="Engineer", company="Acme", url="https://x.test/9",
        location="Ottawa, Ontario, Canada", description="", country="CA",
        work_type="onsite", source_platform="ats", experience_level="new_grad",
        easy_apply=0, match_score=0, location_search="",
    )
    db_session.add(row)
    db_session.commit()
    res = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/9" for j in res.json())


def test_remote_tag_matches_work_type(client, db_session):
    _mk(db_session, "https://x.test/10", "Toronto, ON, CA", work_type="remote")
    res = client.get("/jobs", params={"location": "Remote"})
    assert any(j["url"] == "https://x.test/10" for j in res.json())


def test_cities_endpoint_lists_parsed_cities(client, db_session):
    _mk(db_session, "https://x.test/11", "Ottawa, ON, CA")
    _mk(db_session, "https://x.test/12", "Ottawa, Ontario, Canada")
    _mk(db_session, "https://x.test/13", "Toronto, ON, CA")
    res = client.get("/jobs/cities", params={"country": "CA", "q": "ot"})
    assert res.status_code == 200
    entries = {e["city"]: e["count"] for e in res.json()}
    assert entries.get("Ottawa", 0) >= 2
    assert "Toronto" not in entries
