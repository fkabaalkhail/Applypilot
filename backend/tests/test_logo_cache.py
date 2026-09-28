"""Self-hosted company logos: identity keys, the store, propagation, the
serving endpoint, and every insert path consulting the store."""

import asyncio
import datetime
import hashlib
import io
from dataclasses import dataclass
from typing import NamedTuple

import httpx
import pytest
from PIL import Image, ImageDraw
from sqlalchemy import create_engine, inspect

import backend.auth.dependencies as auth_deps
from backend.data import company_registry
from backend.db.models import CompanyLogo, ScrapedJob
from backend.services import logo_cache, logo_harvester
from backend.services.logo_harvester import LogoHints
from backend.services.logo_cache import (
    brand,
    clean_company_name,
    company_key,
    company_names_by_key,
    load_branding,
    logo_path,
    logo_quality,
    lookup_logo,
    propagate_logo,
    record_miss,
    retry_delay,
    seed_logo_urls,
    store_logo,
)
from backend.services.logo_resolver import (
    company_website_url,
    domain_from_logo_url,
    domain_from_url,
    resolve_domain,
)

SECRET = "test-cron-secret"
S2 = "https://www.google.com/s2/favicons?domain={}&sz=256"
LICDN = ("https://media.licdn.com/dms/image/v2/C4D0BAQE/company-logo_100_100/"
         "company-logo_100_100/0/1650410271177/tesla_logo?e=2147483647&v=beta&t=abc")
INDEED = "https://d2q79iu7y748jz.cloudfront.net/s/_squarelogo/256x256/0051d49bfbce"


class FakeLogo(NamedTuple):
    data: bytes
    sha: str
    fmt: str
    width: int
    height: int


@dataclass
class FakeResult:
    logo: FakeLogo
    source: str = "linkedin"
    source_url: str = "https://media.licdn.com/dms/image/x"
    verified_domain: str | None = None


def _logo(seed: bytes = b"x", fmt: str = "png") -> FakeLogo:
    data = (b"<svg xmlns='http://www.w3.org/2000/svg'/>" if fmt == "svg"
            else b"\x89PNG\r\n\x1a\n") + seed * 40
    return FakeLogo(data, hashlib.sha1(data).hexdigest(), fmt, 128, 128)


def _row(db, url, *, company="Tesla", logo="", domain="", listing_status="active",
         duplicate_of=None, company_url=""):
    row = ScrapedJob(
        title="Software Engineer Intern", company=company, url=url,
        location="Toronto, ON, CA", description="", country="CA",
        work_type="onsite", source_platform="ats", experience_level="internship",
        easy_apply=0, match_score=0, company_logo=logo, company_domain=domain,
        listing_status=listing_status, duplicate_of=duplicate_of,
        company_url=company_url,
    )
    db.add(row)
    db.commit()
    return row


def _cron_headers(monkeypatch):
    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    return {"x-cron-secret": SECRET}


# --- identity ---------------------------------------------------------------

@pytest.mark.parametrize("name,key", [
    ("Tesla", "tesla"),
    ("**Tesla**", "tesla"),
    ("Tesla, Inc.", "tesla"),
    ("__Warp__", "warp"),
    ("`Warp`", "warp"),
    ("Notion (Ashby)", "notion"),
    ("**Notion (Ashby)**", "notion"),
    ("Postman (Greenhouse)", "postman"),
    ("Skyworks Solutions, Inc.", "skyworks solutions"),
    ("Magna International Inc.", "magna international"),
    ("BDO Canada LLP", "bdo canada"),
    ("Foo Co., Ltd.", "foo"),
    ("Siemens AG", "siemens"),
    ("Company", "company"),  # never strips the last word
    ("AtkinsRéalis", "atkinsrealis"),
    ("Spot & Tango", "spot tango"),
    ("Susquehanna (SIG)", "susquehanna sig"),  # only ATS tags are dropped
    ("  Acme   Widgets  ", "acme widgets"),
    ("", ""),
    (None, ""),
    # Placeholders name nobody: no key, so no store and no harvest.
    ("nan", ""),
    ("NaN", ""),
    ("None", ""),
    ("null", ""),
    ("N/A", ""),
    ("Unknown", ""),
    ("Unknown Inc.", ""),
    ("**Undisclosed**", ""),
    ("Confidential", ""),
    ("Confidential Company", ""),
    ("Nando's", "nando s"),  # only an exact placeholder
    ("Unknown Worlds", "unknown worlds"),
])
def test_company_key(name, key):
    assert company_key(name) == key


def test_placeholder_employers_are_never_harvested_or_stored(db_session, monkeypatch):
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})
    for i in range(3):
        _row(db_session, f"https://x.test/nan-{i}", company="nan", logo=S2.format("nan.com"),
             domain="nan.com")
    _row(db_session, "https://x.test/real-1", company="Real Co")
    names = company_names_by_key(db_session)
    assert "nan" not in names
    plans = logo_cache.plan_harvest(db_session, names, LogoHints)
    assert [p.display for p in plans] == ["Real Co"]
    assert store_logo(db_session, "nan", FakeResult(_logo())) == ""
    record_miss(db_session, "N/A")
    assert db_session.query(CompanyLogo).count() == 0


def test_clean_company_name_keeps_case():
    assert clean_company_name("**Tesla**") == "Tesla"
    assert clean_company_name("Notion (Ashby)") == "Notion"
    assert clean_company_name("Susquehanna (SIG)") == "Susquehanna (SIG)"


def test_logo_path():
    sha = "a" * 40
    assert logo_path(sha, "png") == f"/jobs/logo/{sha}.png"
    assert logo_path(sha, "svg") == f"/jobs/logo/{sha}.svg"


def test_logo_quality_ranks_kinds():
    assert logo_quality(logo_path("a" * 40, "png")) == 3
    assert logo_quality(LICDN) == 2
    assert logo_quality(INDEED) == 2
    assert logo_quality("https://www.cibc.com/content/apple-touch-icon.png") == 1
    assert logo_quality("https://commons.wikimedia.org/wiki/Special:FilePath/X.svg?width=256") == 1
    assert logo_quality(S2.format("tesla.com")) == 0
    assert logo_quality("https://logo.clearbit.com/tesla.com") == 0
    assert logo_quality("https://icon.horse/icon/tesla.com") == 0
    assert logo_quality("https://www.spacex.com/assets/images/share.jpg") == 0
    assert logo_quality("https://static.hugedomains.com/images/og_hugedomains.png") == 0
    assert logo_quality("") == 0
    assert logo_quality(None) == 0


# --- domain parsing (logo_resolver) ------------------------------------------

def test_domain_from_logo_url_reads_the_registry_domain():
    assert domain_from_logo_url(
        "https://www.google.com/s2/favicons?domain=toasttab.com&sz=128") == "toasttab.com"
    assert domain_from_logo_url(
        "https://www.google.com/s2/favicons?domain=www.notion.so&sz=128") == "notion.so"
    assert domain_from_logo_url("https://cdn.example.com/logo.png") is None
    assert domain_from_logo_url("https://www.google.com/s2/favicons?domain=not a domain") is None
    assert domain_from_logo_url("") is None


def test_ats_and_aggregator_hosts_are_never_employer_domains():
    assert domain_from_url("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1") is None
    assert domain_from_url("https://jobs.jobvite.com/acme/job/1") is None
    assert domain_from_url("https://acme.bamboohr.com/careers/12") is None
    assert domain_from_url("https://www.linkedin.com/jobs/view/123") is None
    assert domain_from_url("https://www.carvana.com/careers/job?gh_jid=1") == "carvana.com"


def test_resolve_domain_priority():
    # registry > company website > employer-hosted apply link > name guess
    assert resolve_domain("Toast", known_domain="toasttab.com",
                          company_url="https://toast.io") == "toasttab.com"
    assert resolve_domain("Toast", "https://www.toast.io/about",
                          apply_url="https://careers.toast.dev/1") == "toast.io"
    assert resolve_domain("Carvana Co",
                          apply_url="https://www.carvana.com/careers/1") == "carvana.com"
    assert resolve_domain("Acme Widgets",
                          apply_url="https://boards.greenhouse.io/acme/jobs/1") == "acmewidgets.com"
    # A curated domain outranks a careers-only apply host.
    assert resolve_domain("TikTok",
                          apply_url="https://lifeattiktok.com/search/7") == "tiktok.com"


def test_company_website_url_only_keeps_real_employer_sites():
    assert company_website_url("https://www.toasttab.com/about") == "https://www.toasttab.com/about"
    assert company_website_url("https://www.linkedin.com/company/toast") == ""
    assert company_website_url("javascript:alert(1)") == ""
    assert company_website_url("toasttab.com") == ""
    assert company_website_url("") == ""


# --- serving endpoint -------------------------------------------------------

def _stored(db, company="Tesla", fmt="png", status="ok", seed=b"x"):
    logo = _logo(seed, fmt)
    db.add(CompanyLogo(
        company_key=company_key(company), display_name=company, status=status,
        sha=logo.sha, fmt=fmt, data=logo.data, width=128, height=128,
    ))
    db.commit()
    return logo


def test_logo_endpoint_serves_png_immutably(client, db_session):
    logo = _stored(db_session)
    res = client.get(f"/jobs/logo/{logo.sha}.png")
    assert res.status_code == 200
    assert res.content == logo.data
    assert res.headers["content-type"] == "image/png"
    assert res.headers["cache-control"] == "public, max-age=31536000, s-maxage=31536000, immutable"
    assert res.headers["x-content-type-options"] == "nosniff"


def test_logo_endpoint_sandboxes_svg(client, db_session):
    logo = _stored(db_session, fmt="svg")
    res = client.get(f"/jobs/logo/{logo.sha}.svg")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/svg+xml")
    assert res.headers["content-security-policy"] == (
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    )


def test_logo_endpoint_404s(client, db_session):
    logo = _stored(db_session)
    missed = _stored(db_session, company="Nothing Found", status="miss", seed=b"y")
    assert client.get(f"/jobs/logo/{'b' * 40}.png").status_code == 404  # unknown
    assert client.get(f"/jobs/logo/{logo.sha}.svg").status_code == 404  # wrong format
    assert client.get("/jobs/logo/not-a-sha.png").status_code == 404
    assert client.get(f"/jobs/logo/{logo.sha}.gif").status_code == 404
    assert client.get(f"/jobs/logo/{missed.sha}.png").status_code == 404  # not ok


# --- store + propagate --------------------------------------------------------

def test_store_logo_propagates_to_every_spelling_and_keeps_trusted_hotlinks(db_session):
    generated = _row(db_session, "https://x.test/1", logo=S2.format("teslainc.com"),
                     domain="teslainc.com")
    blank = _row(db_session, "https://x.test/2", company="**Tesla**")
    licdn = _row(db_session, "https://x.test/3", company="Tesla, Inc.", logo=LICDN)
    indeed = _row(db_session, "https://x.test/4", logo=INDEED)
    hidden = _row(db_session, "https://x.test/5", logo="https://tesla.com/og/share.jpg",
                  duplicate_of=generated.id)
    removed = _row(db_session, "https://x.test/6", listing_status="removed",
                   logo="https://commons.wikimedia.org/wiki/Special:FilePath/Tesla.svg")
    other = _row(db_session, "https://x.test/7", company="Other Co",
                 logo=S2.format("other.com"), domain="other.com")

    result = FakeResult(_logo(), verified_domain="tesla.com")
    path = store_logo(db_session, "**Tesla**", result)
    assert path == logo_path(result.logo.sha, "png")

    db_session.expire_all()
    for row in (generated, blank, hidden, removed):
        assert db_session.get(ScrapedJob, row.id).company_logo == path
    assert db_session.get(ScrapedJob, licdn.id).company_logo == LICDN
    assert db_session.get(ScrapedJob, indeed.id).company_logo == INDEED
    assert db_session.get(ScrapedJob, other.id).company_logo == S2.format("other.com")
    # The verified domain fixes the wrong guess on every Tesla row.
    for row in (generated, blank, licdn, indeed, hidden, removed):
        assert db_session.get(ScrapedJob, row.id).company_domain == "tesla.com"
    assert db_session.get(ScrapedJob, other.id).company_domain == "other.com"

    record = db_session.query(CompanyLogo).filter_by(company_key="tesla").one()
    assert record.status == "ok"
    assert record.display_name == "Tesla"
    assert bytes(record.data) == result.logo.data
    assert record.domain == "tesla.com"
    assert record.next_retry_at is None


def test_restore_with_new_image_moves_rows_off_the_old_path(db_session):
    row = _row(db_session, "https://x.test/1", logo=S2.format("tesla.com"))
    first = store_logo(db_session, "Tesla", FakeResult(_logo(b"a")))
    second = store_logo(db_session, "Tesla", FakeResult(_logo(b"b")))
    assert first != second
    db_session.expire_all()
    assert db_session.get(ScrapedJob, row.id).company_logo == second
    assert db_session.query(CompanyLogo).count() == 1


def test_propagate_is_a_noop_without_a_stored_logo(db_session):
    row = _row(db_session, "https://x.test/1", logo=S2.format("tesla.com"))
    record_miss(db_session, "Tesla")
    assert propagate_logo(db_session, "Tesla") == 0
    db_session.expire_all()
    assert db_session.get(ScrapedJob, row.id).company_logo == S2.format("tesla.com")


# --- misses -------------------------------------------------------------------

def test_record_miss_backs_off_and_never_demotes(db_session):
    before = datetime.datetime.utcnow()
    record_miss(db_session, "Nobody Inc")
    record = db_session.query(CompanyLogo).filter_by(company_key="nobody").one()
    assert record.status == "miss" and record.attempts == 1
    assert record.next_retry_at - before >= datetime.timedelta(days=14)
    assert record.next_retry_at - before < datetime.timedelta(days=15)

    record_miss(db_session, "Nobody")
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="nobody").one()
    assert record.attempts == 2
    assert record.next_retry_at - before >= datetime.timedelta(days=28)

    assert retry_delay(50) == datetime.timedelta(days=90)  # capped, never permanent

    store_logo(db_session, "Nobody", FakeResult(_logo()))
    record_miss(db_session, "Nobody")
    db_session.expire_all()
    assert db_session.query(CompanyLogo).filter_by(company_key="nobody").one().status == "ok"


def test_record_miss_clears_bogus_guessed_domains(db_session):
    bogus = _row(db_session, "https://x.test/1", company="BDO Canada",
                 logo=S2.format("bdocanada.com"), domain="bdocanada.com")
    real_logo = _row(db_session, "https://x.test/2", company="BDO Canada LLP",
                     logo=LICDN, domain="bdocanada.com")
    fine = _row(db_session, "https://x.test/3", company="BDO Canada",
                logo=S2.format("bdo.ca"), domain="bdo.ca")

    record_miss(db_session, "BDO Canada", rejected_domains=["bdocanada.com"])
    db_session.expire_all()
    assert db_session.get(ScrapedJob, bogus.id).company_domain == ""
    assert db_session.get(ScrapedJob, bogus.id).company_logo == ""
    assert db_session.get(ScrapedJob, real_logo.id).company_domain == ""
    assert db_session.get(ScrapedJob, real_logo.id).company_logo == LICDN
    assert db_session.get(ScrapedJob, fine.id).company_domain == "bdo.ca"
    record = db_session.query(CompanyLogo).filter_by(company_key="bdo canada").one()
    assert record.rejected_domains == ["bdocanada.com"]


# --- replaced hotlinks, demotion, provisional logos ---------------------------------

HOME = "https://www.acme.com/apple-touch-icon.png"
WIKI = "https://commons.wikimedia.org/wiki/Special:FilePath/Acme.svg?width=256"
WRONG = ("https://media.licdn.com/dms/image/v2/C4D0BAQ/company-logo_100_100/"
         "company-logo_100_100/0/1/acme_widgets_logo?e=2147483647&v=beta&t=wrong")


def _acme_rows(db):
    """Acme rows with two real hotlinks, a generated favicon, nothing, and a
    LinkedIn logo; returns them by kind."""
    return {
        "home": [_row(db, f"https://x.test/home-{i}", company="Acme", logo=HOME) for i in range(2)],
        "wiki": _row(db, "https://x.test/wiki", company="Acme Inc.", logo=WIKI, listing_status="removed"),
        "generated": _row(db, "https://x.test/gen", company="Acme", logo=S2.format("acme.com")),
        "blank": _row(db, "https://x.test/blank", company="**Acme**"),
        "licdn": _row(db, "https://x.test/li", company="Acme", logo=LICDN),
    }


def _logo_of(db, row):
    return db.get(ScrapedJob, row.id).company_logo


def test_store_remembers_the_real_hotlinks_it_replaces(db_session):
    rows = _acme_rows(db_session)
    path = store_logo(db_session, "Acme", FakeResult(_logo(), source="linkedin_search", source_url=WRONG))
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    # Most-used first; generated favicons and trusted hotlinks are not "replaced".
    assert record.prior_logo_urls == [HOME, WIKI]
    assert _logo_of(db_session, rows["home"][0]) == path  # still broad propagation
    assert _logo_of(db_session, rows["licdn"]) == LICDN

    # Storing again keeps what the first store replaced.
    store_logo(db_session, "Acme", FakeResult(_logo(b"again")))
    db_session.expire_all()
    assert db_session.query(CompanyLogo).filter_by(company_key="acme").one().prior_logo_urls == [HOME, WIKI]


def test_demote_restores_rows_blocks_the_image_and_reharvests_prior_urls_first(db_session, monkeypatch):
    rows = _acme_rows(db_session)
    wrong = FakeResult(_logo(b"wrong"), source="linkedin_search", source_url=WRONG,
                       verified_domain="acmewidgets.com")
    path = store_logo(db_session, "Acme", wrong)
    assert "acme" not in _plans(db_session, monkeypatch)  # an ok logo is never planned again

    # Planning a re-harvest (the script's dry run) already avoids the image.
    acme = _plans(db_session, monkeypatch, reharvest=["Acme"])["acme"]
    assert acme.hints.existing_logo_urls[:2] == [HOME, WIKI]
    assert acme.hints.blocked_shas == [wrong.logo.sha]

    assert logo_cache.demote_logo(db_session, "Acme", dry_run=True)["rows"] == 5
    db_session.expire_all()
    assert _logo_of(db_session, rows["blank"]) == path  # a dry run writes nothing

    done = logo_cache.demote_logo(db_session, "Acme")
    assert done["rows"] == 5 and done["restored_to"] == HOME and done["source_url"] == WRONG
    db_session.expire_all()
    for row in rows["home"] + [rows["wiki"], rows["generated"], rows["blank"]]:
        assert _logo_of(db_session, row) == HOME
    assert _logo_of(db_session, rows["licdn"]) == LICDN
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert (record.status, record.attempts, record.domain, record.next_retry_at) == ("miss", 0, None, None)
    assert record.blocked_shas == [wrong.logo.sha]
    # A LinkedIn pick says nothing about the domain: it is forgotten, not rejected.
    assert done["rejected_domain"] == "" and not record.rejected_domains
    assert lookup_logo(db_session, "Acme") is None
    assert logo_cache.demote_logo(db_session, "Acme") is None  # nothing stored any more

    # Due now, trying what the rows showed before anything else.
    acme = _plans(db_session, monkeypatch)["acme"]
    assert acme.hints.existing_logo_urls[:2] == [HOME, WIKI]
    assert LICDN in acme.hints.existing_logo_urls
    assert acme.hints.blocked_shas == [wrong.logo.sha]


FAST_ICON = "https://fast.com/assets/favicons/apple-icon-180x180.png"


@pytest.mark.parametrize("source", ["homepage", "wikidata", "s2"])
def test_demoting_a_pick_its_domain_chose_rejects_that_domain(db_session, monkeypatch, source):
    """'Fast' verified fast.com (Netflix's speed test) and stored its icon:
    blocking that one image is not enough, the same site has an icon at
    every size, and the rows' fast.com would keep the s2 fallback alive."""
    rows = [_row(db_session, "https://x.test/fast-1", company="Fast", logo=S2.format("fast.com"),
                 domain="fast.com"),
            _row(db_session, "https://x.test/fast-2", company="Fast")]
    other = _row(db_session, "https://x.test/other", company="Other Co", logo=S2.format("fast.com"),
                 domain="fast.com")
    wrong = FakeResult(_logo(b"netflix"), source=source, source_url=FAST_ICON,
                       verified_domain="fast.com")
    path = store_logo(db_session, "Fast", wrong)
    db_session.expire_all()
    assert {_logo_of(db_session, r) for r in rows} == {path}
    assert {db_session.get(ScrapedJob, r.id).company_domain for r in rows} == {"fast.com"}

    # Planning the re-harvest (the script's dry run) already avoids the site.
    fast = _plans(db_session, monkeypatch, reharvest=["Fast"])["fast"]
    assert "fast.com" not in fast.hints.domains
    assert fast.hints.blocked_shas == [wrong.logo.sha]

    assert logo_cache.demote_logo(db_session, "Fast", dry_run=True)["rejected_domain"] == "fast.com"
    db_session.expire_all()
    assert db_session.get(ScrapedJob, rows[0].id).company_domain == "fast.com"  # dry: nothing written

    done = logo_cache.demote_logo(db_session, "Fast")
    assert done["rejected_domain"] == "fast.com" and done["rows"] == 2
    db_session.expire_all()
    for row in rows:
        stored = db_session.get(ScrapedJob, row.id)
        assert (stored.company_logo, stored.company_domain) == ("", "")
    other_row = db_session.get(ScrapedJob, other.id)  # another employer's row is untouched
    assert (other_row.company_logo, other_row.company_domain) == (S2.format("fast.com"), "fast.com")
    record = db_session.query(CompanyLogo).filter_by(company_key="fast").one()
    assert (record.status, record.domain, record.rejected_domains) == ("miss", None, ["fast.com"])

    # The next harvest never tries the site again, not even as the name guess...
    fast = _plans(db_session, monkeypatch)["fast"]
    assert "fast.com" not in fast.hints.domains and "fast.com" not in fast.suspect_domains
    assert fast.hints.blocked_shas == [wrong.logo.sha]
    # ...and insert paths stop planting it.
    assert brand(load_branding(db_session, ["Fast"]), "Fast", S2.format("fast.com"), "fast.com") == ("", "")


def test_provisional_logo_fills_only_rows_without_a_real_logo(db_session):
    rows = _acme_rows(db_session)
    before = datetime.datetime.utcnow()
    path = store_logo(db_session, "Acme", FakeResult(_logo(), source="homepage"), provisional=True)
    db_session.expire_all()
    assert _logo_of(db_session, rows["generated"]) == path
    assert _logo_of(db_session, rows["blank"]) == path
    assert _logo_of(db_session, rows["home"][0]) == HOME  # real hotlinks wait for the final logo
    assert _logo_of(db_session, rows["wiki"]) == WIKI
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert record.status == "ok" and record.attempts == 1 and not record.prior_logo_urls
    assert datetime.timedelta(hours=23) < record.next_retry_at - before < datetime.timedelta(days=2)
    assert lookup_logo(db_session, "Acme") == path  # served meanwhile

    # Insert paths keep a real logo over a provisional one, never a generated one.
    branding = load_branding(db_session, ["Acme"])
    assert branding["acme"].provisional
    assert brand(branding, "Acme", LICDN, "")[0] == LICDN
    assert brand(branding, "Acme", HOME, "")[0] == HOME
    assert brand(branding, "Acme", S2.format("acme.com"), "")[0] == path

    # LinkedIn skipped again: re-checked later, still provisional.
    record_miss(db_session, "Acme", linkedin_skipped=True)
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert record.status == "ok" and record.attempts == 2
    assert record.next_retry_at - before > datetime.timedelta(days=1, hours=23)

    # A miss nobody confirmed LinkedIn answered (a timeout) proves nothing either.
    record_miss(db_session, "Acme")
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert record.status == "ok" and record.attempts == 3 and record.next_retry_at is not None
    assert _logo_of(db_session, rows["home"][0]) == HOME

    # LinkedIn answered and had nothing better: final, and propagated fully.
    record_miss(db_session, "Acme", linkedin_answered=True)
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert (record.status, record.next_retry_at, record.attempts) == ("ok", None, 0)
    assert _logo_of(db_session, rows["home"][0]) == path
    assert record.prior_logo_urls == [HOME, WIKI]
    assert not load_branding(db_session, ["Acme"])["acme"].provisional


def test_provisional_logos_are_rechecked_after_employers_with_none(db_session, monkeypatch):
    for i in range(3):
        _row(db_session, f"https://x.test/p-{i}", company="Provisional Co")
    _row(db_session, "https://x.test/n-1", company="No Logo Co")
    store_logo(db_session, "Provisional Co", FakeResult(_logo(), source="s2"), provisional=True)
    assert list(_plans(db_session, monkeypatch)) == ["no logo"]  # not due yet
    assert list(_plans(db_session, monkeypatch, retry_misses=True)) == ["no logo", "provisional"]
    db_session.query(CompanyLogo).filter_by(company_key="provisional").update(
        {"next_retry_at": datetime.datetime.utcnow() - datetime.timedelta(minutes=1)})
    db_session.commit()
    plans = logo_cache.plan_harvest(db_session, company_names_by_key(db_session), LogoHints)
    assert [p.display for p in plans] == ["No Logo Co", "Provisional Co"]  # fewer rows, still first


def test_recheck_delay_is_short_and_capped():
    assert logo_cache.recheck_delay(1) == datetime.timedelta(days=1)
    assert logo_cache.recheck_delay(3) == datetime.timedelta(days=4)
    assert logo_cache.recheck_delay(10_000) == logo_cache.RETRY_CAP


def test_record_miss_after_a_linkedin_block_retries_soon(db_session):
    before = datetime.datetime.utcnow()
    record_miss(db_session, "Nobody", linkedin_skipped=True)
    record = db_session.query(CompanyLogo).filter_by(company_key="nobody").one()
    assert record.status == "miss" and record.attempts == 1
    assert record.next_retry_at - before < datetime.timedelta(days=2)


# --- lookups ------------------------------------------------------------------

def test_lookup_logo_hit_and_miss(db_session):
    logo = _stored(db_session, company="Tesla")
    assert lookup_logo(db_session, "**Tesla, Inc.**") == logo_path(logo.sha, "png")
    assert lookup_logo(db_session, "Rivian") is None
    record_miss(db_session, "Rivian")
    assert lookup_logo(db_session, "Rivian") is None


def test_brand_prefers_store_and_drops_rejected_guesses(db_session):
    store_logo(db_session, "Notion (Ashby)", FakeResult(_logo(), verified_domain="notion.so"))
    record_miss(db_session, "BDO Canada", rejected_domains=["bdocanada.com"])
    branding = load_branding(db_session, ["Notion", "BDO Canada", "Unknown Startup"])

    logo, domain = brand(branding, "Notion", S2.format("notionashby.com"), "notionashby.com")
    assert logo.startswith("/jobs/logo/") and domain == "notion.so"

    assert brand(branding, "BDO Canada", S2.format("bdocanada.com"), "bdocanada.com") == ("", "")
    assert brand(branding, "BDO Canada", LICDN, "bdocanada.com") == (LICDN, "")
    assert brand(branding, "Unknown Startup", "x", "y.com") == ("x", "y.com")


def test_seed_logo_urls_ranks_real_logos(db_session):
    dated = "https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/x?e=1790000000&v=beta&t=z"
    wiki = "https://commons.wikimedia.org/wiki/Special:FilePath/Tesla.svg?width=256"
    ats = "https://recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/tesla.png"
    for i in range(5):
        _row(db_session, f"https://x.test/w{i}", logo=wiki)
    _row(db_session, "https://x.test/i", logo=INDEED)
    _row(db_session, "https://x.test/a", company="**Tesla**", logo=ats)
    _row(db_session, "https://x.test/d", logo=dated)
    _row(db_session, "https://x.test/l", company="Tesla, Inc.", logo=LICDN,
         duplicate_of=1)  # hidden twins count too
    _row(db_session, "https://x.test/s", logo=S2.format("tesla.com"))
    _row(db_session, "https://x.test/o", company="Other", logo=LICDN)

    seeds = seed_logo_urls(db_session, company_names_by_key(db_session), per_key=5)
    assert seeds["tesla"] == [LICDN, dated, INDEED, ats, wiki]
    assert seed_logo_urls(db_session, company_names_by_key(db_session), per_key=2)["tesla"] == [
        LICDN, dated,
    ]


# --- migration ----------------------------------------------------------------

def test_migration_creates_table_idempotently(tmp_path):
    from backend.migrations.add_company_logos import run_migration

    engine = create_engine(f"sqlite:///{tmp_path / 'm.db'}")
    run_migration(engine)
    run_migration(engine)  # second run must be a no-op
    inspector = inspect(engine)
    cols = {c["name"] for c in inspector.get_columns("company_logos")}
    assert {"company_key", "domain", "status", "sha", "fmt", "data", "attempts",
            "rejected_domains", "prior_logo_urls", "blocked_shas", "next_retry_at"} <= cols
    indexes = {i["name"] for i in inspector.get_indexes("company_logos")}
    assert {"ix_company_logos_company_key", "ix_company_logos_sha"} <= indexes


def test_migration_adds_new_columns_to_a_table_created_before_them(tmp_path):
    """Dev already has company_logos from the first version of this migration."""
    from sqlalchemy import text

    from backend.migrations.add_company_logos import run_migration

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE company_logos (id INTEGER PRIMARY KEY, company_key VARCHAR NOT NULL, "
            "status VARCHAR NOT NULL DEFAULT 'miss', sha VARCHAR, rejected_domains JSON)"
        ))
        conn.execute(text("INSERT INTO company_logos (company_key, status) VALUES ('acme', 'ok')"))
    run_migration(engine)
    run_migration(engine)  # idempotent
    cols = {c["name"] for c in inspect(engine).get_columns("company_logos")}
    assert {"prior_logo_urls", "blocked_shas"} <= cols
    with engine.connect() as conn:
        assert conn.execute(text("SELECT company_key, prior_logo_urls FROM company_logos")).all() == [
            ("acme", None)
        ]


# --- insert paths ---------------------------------------------------------------

def _ingest(client, monkeypatch, **job):
    payload = {"jobs": [{
        "title": "Software Intern", "location": "Toronto, ON, CA",
        "source_platform": "linkedin", "country": "CA",
        "experience_level": "internship", **job,
    }]}
    res = client.post("/jobs/ingest-batch", json=payload, headers=_cron_headers(monkeypatch))
    assert res.status_code == 200, res.text
    return res.json()


def test_ingest_batch_uses_the_stored_logo(client, db_session, monkeypatch):
    store_logo(db_session, "Kinaxis", FakeResult(_logo(), verified_domain="kinaxis.com"))
    _ingest(client, monkeypatch, company="Kinaxis Inc.", url="https://example.com/jobs/1",
            company_logo=LICDN)
    row = db_session.query(ScrapedJob).filter_by(url="https://example.com/jobs/1").one()
    assert row.company_logo == lookup_logo(db_session, "Kinaxis")
    assert row.company_domain == "kinaxis.com"


def test_ingest_batch_derives_domain_from_company_url(client, db_session, monkeypatch):
    _ingest(client, monkeypatch, company="Toast", url="https://example.com/jobs/2",
            company_url="https://www.toasttab.com/about",
            company_logo="https://logo.clearbit.com/toast.com")
    row = db_session.query(ScrapedJob).filter_by(url="https://example.com/jobs/2").one()
    assert row.company_domain == "toasttab.com"
    assert row.company_url == "https://www.toasttab.com/about"
    assert "clearbit" not in row.company_logo  # generated logos are never stored
    assert "toasttab.com" in row.company_logo

    _ingest(client, monkeypatch, company="Toast", url="https://example.com/jobs/3",
            company_url="https://www.linkedin.com/company/toast")
    row = db_session.query(ScrapedJob).filter_by(url="https://example.com/jobs/3").one()
    assert row.company_url == ""  # a LinkedIn page is not the employer's site
    assert row.company_domain == "toast.com"


def _mock_board(monkeypatch, company, job_url, logo_map=None):
    from backend.data import company_registry
    from backend.services.ats_scraper import ATSJob, ATSScraper, BoardSnapshot

    monkeypatch.setattr(
        company_registry, "load_companies",
        lambda **kw: [("greenhouse", "board", company)],
    )
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: dict(logo_map or {}))
    job = ATSJob(title="Software Engineer Intern", company=company,
                 location="Toronto, ON, Canada", url=job_url,
                 description="Build things. " * 20, external_id="1")

    async def fake_scrape_board(self, client, platform, slug, company_name):
        return BoardSnapshot(platform=platform, slug=slug, company=company_name,
                             jobs=[job], all_urls={job.url})

    monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)


def test_cron_ats_takes_the_domain_from_the_registry_logo(client, db_session, monkeypatch):
    registry_logo = "https://www.google.com/s2/favicons?domain=toasttab.com&sz=128"
    _mock_board(monkeypatch, "Toast", "https://boards.greenhouse.io/toast/jobs/1",
                {"toast": registry_logo})
    res = client.post("/github-sources/cron-ats", headers=_cron_headers(monkeypatch))
    assert res.json()["new_jobs"] == 1
    row = db_session.query(ScrapedJob).one()
    assert row.company_domain == "toasttab.com"  # not the toast.com name guess
    assert row.company_logo == registry_logo


def test_cron_ats_uses_an_employer_hosted_apply_link(client, db_session, monkeypatch):
    _mock_board(monkeypatch, "Carvana Co", "https://www.carvana.com/careers/job?gh_jid=77")
    client.post("/github-sources/cron-ats", headers=_cron_headers(monkeypatch))
    assert db_session.query(ScrapedJob).one().company_domain == "carvana.com"


def test_cron_ats_uses_the_stored_logo(client, db_session, monkeypatch):
    path = store_logo(db_session, "Toast", FakeResult(_logo(), verified_domain="toasttab.com"))
    _mock_board(monkeypatch, "Toast", "https://boards.greenhouse.io/toast/jobs/2",
                {"toast": "https://www.google.com/s2/favicons?domain=toasttab.com&sz=128"})
    client.post("/github-sources/cron-ats", headers=_cron_headers(monkeypatch))
    row = db_session.query(ScrapedJob).one()
    assert row.company_logo == path
    assert row.company_domain == "toasttab.com"


def test_aggregator_insert_uses_apply_link_and_store(db_session):
    from backend.db.models import GitHubSource
    from backend.services.aggregator import AggregatorService
    from backend.services.markdown_parser import ParsedJob

    source = GitHubSource(repo_url="https://github.com/x/list", repo_owner="x",
                          repo_name="New-Grad-Positions", role_category="software")
    db_session.add(source)
    db_session.commit()
    svc = AggregatorService(db_session)

    job = ParsedJob(title="Software Engineer, New Grad", company="**Susquehanna (SIG)**",
                    location="Toronto, ON, Canada", url="https://careers.sig.com/job/1",
                    company_logo=S2.format("susquehannasig.com").replace("256", "128"),
                    company_domain="susquehannasig.com")
    assert svc._classify_and_store(job, source) is True
    row = db_session.query(ScrapedJob).filter_by(url="https://careers.sig.com/job/1").one()
    assert row.company_domain == "sig.com"
    assert "sig.com" in row.company_logo

    path = store_logo(db_session, "Susquehanna (SIG)", FakeResult(_logo()))
    job2 = ParsedJob(title="Quant Intern", company="**Susquehanna (SIG)**",
                     location="Toronto, ON, Canada", url="https://careers.sig.com/job/2")
    assert svc._classify_and_store(job2, source) is True
    row2 = db_session.query(ScrapedJob).filter_by(url="https://careers.sig.com/job/2").one()
    assert row2.company_logo == path


def test_scrape_linkedin_uses_the_stored_logo(client, db_session, monkeypatch):
    from backend.main import app
    from backend.services.linkedin_scraper import LinkedInJob, LinkedInScraper

    path = store_logo(db_session, "Shopify", FakeResult(_logo()))

    async def fake_scrape_city(self, city, province):
        return [LinkedInJob(title="Software Intern", company="Shopify Inc.",
                            location="Ottawa, ON", url="https://www.linkedin.com/jobs/view/42")]

    async def admin():
        return 1

    monkeypatch.setattr(LinkedInScraper, "scrape_city", fake_scrape_city)
    app.dependency_overrides[auth_deps.get_admin_user_id] = admin
    try:
        res = client.post("/github-sources/scrape-linkedin", params={"city": "Ottawa"})
    finally:
        app.dependency_overrides.pop(auth_deps.get_admin_user_id, None)
    assert res.status_code == 200, res.text
    assert db_session.query(ScrapedJob).one().company_logo == path


def test_jobspy_payload_sends_the_employer_website():
    import importlib.util
    import pathlib

    script = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scrape_jobspy.py"
    spec = importlib.util.spec_from_file_location("scrape_jobspy_under_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    payload = module.to_payload({
        "title": "Software Intern", "company": "Toast", "job_url": "https://ca.indeed.com/viewjob?jk=1",
        "site": "indeed", "company_url_direct": "https://www.toasttab.com",
    })
    assert payload["company_url"] == "https://www.toasttab.com"
    payload = module.to_payload({
        "title": "Software Intern", "company": "Toast", "job_url": "https://ca.indeed.com/viewjob?jk=2",
        "site": "indeed", "company_url_direct": float("nan"),
    })
    assert "company_url" not in payload


# --- bogus-domain proof -------------------------------------------------------

def _bogus(monkeypatch, domain, handler, resolves=True):
    async def fake_dns(name):
        return resolves

    monkeypatch.setattr(logo_cache, "_dns_resolves", fake_dns)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                     follow_redirects=True) as client:
            return await logo_cache.domain_is_bogus(client, domain)

    return asyncio.run(run())


def test_domain_is_bogus_on_nxdomain_only_when_the_answer_is_definite(monkeypatch):
    def unreachable(request):
        raise AssertionError("no HTTP after a definite DNS answer")

    assert _bogus(monkeypatch, "bdocanada.com", unreachable, resolves=False) is True
    assert _bogus(monkeypatch, "slowdns.com", unreachable, resolves=None) is False


def test_domain_is_bogus_on_parked_pages(monkeypatch):
    def godaddy_lander(request):
        return httpx.Response(200, text='<script>window.location.href="/lander"</script>')

    assert _bogus(monkeypatch, "helmai.com", godaddy_lander) is True

    def for_sale(request):
        if request.url.host == "agat.com":
            return httpx.Response(
                302, headers={"location": "https://www.hugedomains.com/domain_profile.cfm?d=agat.com"}
            )
        return httpx.Response(200, text="<html>Premium domain</html>")

    assert _bogus(monkeypatch, "agat.com", for_sale) is True


def test_domain_is_bogus_never_on_mere_failures(monkeypatch):
    def real_site(request):
        return httpx.Response(200, text="<title>Kinaxis | Supply chain</title>")

    assert _bogus(monkeypatch, "kinaxis.com", real_site) is False

    def bot_wall(request):
        return httpx.Response(403, text="buy this domain")  # a wall proves nothing

    assert _bogus(monkeypatch, "walled.com", bot_wall) is False

    def refused(request):
        raise httpx.ConnectError("refused")

    assert _bogus(monkeypatch, "down.com", refused) is False

    def own_site(request):
        return httpx.Response(200, text="<title>Namecheap</title>")

    assert _bogus(monkeypatch, "namecheap.com", own_site) is False


# --- longer names of the same employer (W2) ---------------------------------------

BCE_LICDN = ("https://media.licdn.com/dms/image/v2/D4E0BAQ/company-logo_100_100/"
             "company-logo_100_100/0/1/bell_canada_logo?e=2147483647&v=beta&t=bce")
FLIGHT_LICDN = ("https://media.licdn.com/dms/image/v2/C4E0BAQ/company-logo_100_100/"
                "company-logo_100_100/0/1/bell_flight_logo?e=2147483647&v=beta&t=flt")


def _plans(db, monkeypatch, registry=None, **kw):
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: registry or {})
    plans = logo_cache.plan_harvest(db, company_names_by_key(db), LogoHints, **kw)
    return {plan.key: plan for plan in plans}


def test_alias_keys_are_the_name_plus_generic_corporate_words():
    keys = ["magna", "magna international", "bmo", "bmo financial group",
            "bmo capital markets", "bell", "bell canada", "bell flight", "the bell",
            "intact", "intact financial", "global group", "global"]
    assert logo_cache.alias_keys(keys) == {
        "magna": ["magna international"],
        "bmo": ["bmo financial group"],
        "bell": ["bell canada"],
        "intact": ["intact financial"],
    }


def test_magna_is_seeded_from_magna_international_rows(db_session, monkeypatch):
    for i in range(3):
        _row(db_session, f"https://magna.wd3.myworkdayjobs.com/Magna/job/{i}",
             company="Magna", logo=S2.format("magna.com"), domain="magna.com")
    first = _row(db_session, "https://x.test/mi-1", company="Magna International",
                 logo=LICDN, domain="magnainternational.com", listing_status="removed")
    _row(db_session, "https://x.test/mi-2", company="Magna International Inc.",
         logo=INDEED, duplicate_of=first.id)
    plans = _plans(db_session, monkeypatch, {"Magna": S2.format("magna.com")})
    magna = plans["magna"]
    assert magna.aliases == ["magna international"]
    assert magna.hints.existing_logo_urls == [LICDN, INDEED]
    assert magna.hints.domains[0] == "magna.com"
    assert magna.rows == 3
    assert "magna international" not in plans  # no visible rows of its own


def test_own_logos_come_before_the_longer_names(db_session, monkeypatch):
    _row(db_session, "https://x.test/bmo-1", company="BMO", logo=LICDN, domain="bmo.com")
    _row(db_session, "https://x.test/bmo-2", company="BMO", logo=S2.format("bmo.com"), domain="bmo.com")
    _row(db_session, "https://x.test/bfg-1", company="BMO Financial Group", logo=INDEED,
         domain="bmofinancialgroup.com", listing_status="expired")
    _row(db_session, "https://x.test/cap-1", company="BMO Capital Markets", logo=BCE_LICDN,
         listing_status="expired")
    bmo = _plans(db_session, monkeypatch)["bmo"]
    assert bmo.aliases == ["bmo financial group"]
    assert bmo.hints.existing_logo_urls == [LICDN, INDEED]  # never Capital Markets'
    # a name-guessed domain on the longer name's rows proves nothing
    assert "bmofinancialgroup.com" not in bmo.hints.domains


def test_bell_never_takes_another_employers_logo(db_session, monkeypatch):
    _row(db_session, "https://x.test/bell-1", company="Bell", logo=S2.format("bell.com"), domain="bell.com")
    _row(db_session, "https://x.test/flt-1", company="Bell Flight", logo=FLIGHT_LICDN)
    _row(db_session, "https://x.test/tbc-1", company="The Bell Company", logo=INDEED)
    plans = _plans(db_session, monkeypatch)
    assert plans["bell"].aliases == []
    assert plans["bell"].hints.existing_logo_urls == []
    assert plans["bell flight"].hints.existing_logo_urls == [FLIGHT_LICDN]

    # Bell Canada is Bell's longer name: its stored logo's source and its
    # verified domain seed Bell.
    _row(db_session, "https://x.test/bce-1", company="Bell Canada", listing_status="expired")
    store_logo(db_session, "Bell Canada", FakeResult(_logo(b"bce"), source="linkedin_job",
                                                     source_url=BCE_LICDN, verified_domain="bell.ca"))
    bell = _plans(db_session, monkeypatch)["bell"]
    assert bell.aliases == ["bell canada"]
    assert bell.hints.existing_logo_urls == [BCE_LICDN]
    assert "bell.ca" in bell.hints.domains
    assert bell.hints.domains.index("bell.ca") < bell.hints.domains.index("bell.com")


def test_two_longer_names_are_ambiguous_unless_a_proven_domain_says_so(db_session, monkeypatch):
    _row(db_session, "https://x.test/m-1", company="Magna", logo=S2.format("magna.com"))
    _row(db_session, "https://x.test/mi-1", company="Magna International", logo=LICDN,
         listing_status="expired")
    _row(db_session, "https://x.test/mg-1", company="Magna Global", logo=INDEED,
         listing_status="expired")
    magna = _plans(db_session, monkeypatch)["magna"]
    assert magna.aliases == [] and magna.hints.existing_logo_urls == []

    # Magna's registry domain is the one verified for Magna International.
    db_session.add(CompanyLogo(company_key="magna international", status="miss",
                               domain="magna.com"))
    db_session.commit()
    magna = _plans(db_session, monkeypatch, {"Magna": S2.format("magna.com")})["magna"]
    assert magna.aliases == ["magna international"]
    assert magna.hints.existing_logo_urls == [LICDN]


def test_a_conflicting_proven_domain_vetoes_the_longer_name(db_session, monkeypatch):
    _row(db_session, "https://x.test/m-1", company="Magna", logo=S2.format("magna.com"))
    _row(db_session, "https://x.test/mg-1", company="Magna Global", logo=INDEED,
         listing_status="expired")
    db_session.add(CompanyLogo(company_key="magna global", status="miss", domain="magnaglobal.com"))
    db_session.commit()
    # With nothing proven for Magna itself, nothing contradicts the name.
    assert _plans(db_session, monkeypatch)["magna"].aliases == ["magna global"]
    magna = _plans(db_session, monkeypatch, {"Magna": S2.format("magna.com")})["magna"]
    assert magna.aliases == [] and magna.hints.existing_logo_urls == []


def test_plan_harvest_work_list(db_session, monkeypatch):
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})
    for i in range(3):
        _row(db_session, f"https://x.test/big-{i}", company="Big Co")
    _row(db_session, "https://x.test/small-1", company="Small Co")
    _row(db_session, "https://x.test/hidden-1", company="Hidden Co", listing_status="removed")
    _row(db_session, "https://x.test/done-1", company="Done Co")
    _row(db_session, "https://x.test/wait-1", company="Waiting Co")
    _row(db_session, "https://x.test/blank-1", company="  ")
    store_logo(db_session, "Done Co", FakeResult(_logo()))
    record_miss(db_session, "Waiting Co")
    names = company_names_by_key(db_session)

    plans = logo_cache.plan_harvest(db_session, names, LogoHints)
    assert [p.display for p in plans] == ["Big Co", "Small Co"]
    assert [p.rows for p in plans] == [3, 1]
    plans = logo_cache.plan_harvest(db_session, names, LogoHints, retry_misses=True, limit=None)
    assert [p.display for p in plans] == ["Big Co", "Small Co", "Waiting Co"]
    plans = logo_cache.plan_harvest(db_session, names, LogoHints, only=["**Small Co**", "Done Co"])
    assert [p.display for p in plans] == ["Small Co"]
    assert len(logo_cache.plan_harvest(db_session, names, LogoHints, limit=1)) == 1


def test_repropagate_dry_run_counts_without_writing(db_session):
    _row(db_session, "https://x.test/kx-1", company="Kinaxis")
    store_logo(db_session, "Kinaxis", FakeResult(_logo()))
    planted = _row(db_session, "https://x.test/kx-2", company="Kinaxis",
                   logo="https://www.kinaxis.com/og/share.jpg")
    names = company_names_by_key(db_session)
    assert logo_cache.repropagate_known_logos(db_session, names, dry_run=True) == 1
    db_session.expire_all()
    assert db_session.get(ScrapedJob, planted.id).company_logo.endswith("share.jpg")
    assert logo_cache.repropagate_known_logos(db_session, names, max_companies=None) == 1
    db_session.expire_all()
    assert db_session.get(ScrapedJob, planted.id).company_logo == lookup_logo(db_session, "Kinaxis")


def test_timeouts_are_reported_and_recorded_only_when_asked(db_session, monkeypatch):
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})
    _row(db_session, "https://x.test/slow-1", company="Slow Co")
    plans = logo_cache.plan_harvest(db_session, company_names_by_key(db_session), LogoHints)

    async def slow(client, hints):
        await asyncio.sleep(2)

    outcomes = asyncio.run(logo_cache.run_harvest(None, plans, slow, budget_s=60,
                                                  per_company_timeout=0.05))
    assert [o.status for o in outcomes] == ["timeout"]
    stats = logo_cache.new_harvest_stats()
    logo_cache.apply_outcomes(db_session, outcomes, stats, record_timeouts=False)
    assert stats["timeouts"] == 1 and stats["missed"] == 0
    assert db_session.query(CompanyLogo).count() == 0  # the next backfill run retries it
    logo_cache.apply_outcomes(db_session, outcomes, logo_cache.new_harvest_stats())
    assert db_session.query(CompanyLogo).one().status == "miss"  # the cron's rule


# --- Phase 3 end to end with the real harvester ----------------------------------

def _real_png(size=120) -> bytes:
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((20, 20, size - 20, size - 20), fill=(200, 20, 20, 255))
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def test_phase3_with_the_real_harvester_seeds_magna_from_its_longer_name(db_session, monkeypatch):
    async def no_dns(host):
        return False

    monkeypatch.setattr(logo_harvester, "_resolves", no_dns)
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {"Magna": S2.format("magna.com")})
    rows = [_row(db_session, f"https://magna.wd3.myworkdayjobs.com/Magna/job/{i}", company="Magna",
                 logo=S2.format("magna.com"), domain="magna.com") for i in range(3)]
    donor = _row(db_session, "https://x.test/mi-1", company="Magna International", logo=LICDN,
                 listing_status="expired")
    fetched: list[str] = []
    png = _real_png()

    def handler(request):
        fetched.append(str(request.url))
        if str(request.url).startswith("https://media.licdn.com/"):
            return httpx.Response(200, content=png, headers={"content-type": "image/png"})
        return httpx.Response(404)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await logo_cache.harvest_missing_logos(db_session, client)

    stats = asyncio.run(run())
    assert stats["harvester_available"] is True
    assert stats["stored"] == 1 and stats["companies_attempted"] == 1
    assert fetched == [LICDN]  # the borrowed seed won before any other source ran
    record = db_session.query(CompanyLogo).filter_by(company_key="magna").one()
    assert record.status == "ok" and record.source == "existing" and record.source_url == LICDN
    assert record.width == 120 and record.fmt == "png"
    path = lookup_logo(db_session, "Magna")
    db_session.expire_all()
    for row in rows:
        assert db_session.get(ScrapedJob, row.id).company_logo == path
    assert db_session.get(ScrapedJob, donor.id).company_logo == LICDN  # another key, untouched


# --- a provisional logo's re-check when LinkedIn never answers ---------------------

ACME_MARK = "https://www.acme.com/static/acme-mark.png"


def _due_provisional_acme(db):
    """Acme: a real hotlink on one row, nothing on the other, and a
    provisional s2 pick (stored while LinkedIn was rate-limited) due for
    its re-check now."""
    shown = _row(db, "https://x.test/acme-1", company="Acme", logo=ACME_MARK)
    blank = _row(db, "https://x.test/acme-2", company="Acme")
    path = store_logo(db, "Acme", FakeResult(_logo(b"s2"), source="s2"), provisional=True)
    db.query(CompanyLogo).filter_by(company_key="acme").update(
        {"next_retry_at": datetime.datetime.utcnow() - datetime.timedelta(minutes=1)})
    db.commit()
    return shown, blank, path


async def _tarpit(request):
    """Never answers and never sends a 429: nothing trips the LinkedIn gate."""
    await asyncio.sleep(3600)


def _answers(status, body=b""):
    async def answer(request):
        return httpx.Response(status, content=body)
    return answer


async def _refused(request):
    raise httpx.ConnectError("reset by peer")


def _cron_pass(db, monkeypatch, routes: dict):
    """One Phase 3 pass with the real harvester and no network: each URL
    containing a `routes` key gets that handler, everything else a 404."""
    async def no_dns(host):
        return False

    async def never_bogus(client, domain):
        return False

    monkeypatch.setattr(logo_harvester, "_resolves", no_dns)
    monkeypatch.setattr(logo_harvester, "LINKEDIN_MIN_INTERVAL", 0)
    monkeypatch.setattr(logo_cache, "domain_is_bogus", never_bogus)
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})

    async def handler(request):
        for marker, answer in routes.items():
            if marker in str(request.url):
                return await answer(request)
        return httpx.Response(404)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            stats = await logo_cache.harvest_missing_logos(db, client)
            assert logo_harvester.linkedin_stats(client)["blocked"] is False  # no 429, ever
            return stats

    return asyncio.run(run())


def _backstop(seconds):
    """run_harvest with its per-company backstop at `seconds`."""
    real = logo_cache.run_harvest

    async def run_harvest(client, plans, harvest, **kw):
        return await real(client, plans, harvest, **{**kw, "per_company_timeout": seconds})
    return run_harvest


@pytest.mark.parametrize("linkedin,cut", [
    (_tarpit, "harvester cap"),
    (_tarpit, "backstop"),
    (_refused, None),
    (_answers(503), None),
], ids=["tarpit-harvester-cap", "tarpit-backstop", "connection-refused", "server-error"])
def test_a_provisional_logo_stays_provisional_when_linkedin_never_answers(
        db_session, monkeypatch, linkedin, cut):
    shown, blank, path = _due_provisional_acme(db_session)
    if cut == "harvester cap":
        monkeypatch.setattr(logo_harvester, "HARVEST_TIME_CAP", 0.3)
    elif cut == "backstop":
        monkeypatch.setattr(logo_cache, "run_harvest", _backstop(0.3))
    before = datetime.datetime.utcnow()
    stats = _cron_pass(db_session, monkeypatch, {"seeMoreJobPostings": linkedin})
    assert stats["companies_attempted"] == 1 and stats["linkedin_deferred"] == 1

    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert record.status == "ok" and record.attempts == 2
    assert record.next_retry_at is not None and record.next_retry_at > before  # re-checked again
    assert not record.prior_logo_urls
    assert _logo_of(db_session, shown) == ACME_MARK  # the real hotlink stays
    assert _logo_of(db_session, blank) == path
    assert load_branding(db_session, ["Acme"])["acme"].provisional


def test_a_timeout_never_makes_a_provisional_logo_final(db_session, monkeypatch):
    """LinkedIn answered (nothing by that name) but the cap ended the
    cascade before the rest of it ran: no proof nothing better exists."""
    shown, _blank, _path = _due_provisional_acme(db_session)
    monkeypatch.setattr(logo_harvester, "HARVEST_TIME_CAP", 0.3)
    stats = _cron_pass(db_session, monkeypatch, {
        "seeMoreJobPostings": _answers(200, b"<ul></ul>"),
        "wikidata.org": _tarpit,
    })
    assert stats["timeouts"] == 1 and stats["linkedin_deferred"] == 0
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert record.status == "ok" and record.next_retry_at is not None
    assert _logo_of(db_session, shown) == ACME_MARK


def test_a_provisional_logo_becomes_final_once_linkedin_answered(db_session, monkeypatch):
    shown, blank, path = _due_provisional_acme(db_session)
    stats = _cron_pass(db_session, monkeypatch, {"seeMoreJobPostings": _answers(200, b"<ul></ul>")})
    assert stats["missed"] == 1 and stats["linkedin_deferred"] == 0 and stats["timeouts"] == 0
    db_session.expire_all()
    record = db_session.query(CompanyLogo).filter_by(company_key="acme").one()
    assert (record.status, record.next_retry_at, record.attempts) == ("ok", None, 0)
    assert {_logo_of(db_session, shown), _logo_of(db_session, blank)} == {path}
    assert record.prior_logo_urls == [ACME_MARK]  # demote_logo can still give it back


def test_run_harvest_keeps_each_concurrent_harvests_linkedin_report(db_session, monkeypatch):
    for name in ("Answered Co", "Silent Co"):
        _row(db_session, f"https://x.test/{name[0]}", company=name)
    monkeypatch.setattr(company_registry, "load_logo_map", lambda: {})
    plans = logo_cache.plan_harvest(db_session, company_names_by_key(db_session), LogoHints)

    async def harvest(client, hints):
        report = logo_harvester.harvest_report.get()
        report.linkedin_asked = True
        await asyncio.sleep(0.05)  # both in flight at once
        report.linkedin_answered = hints.company == "Answered Co"

    async def never_bogus(client, domain):
        return False

    monkeypatch.setattr(logo_cache, "domain_is_bogus", never_bogus)
    outcomes = asyncio.run(logo_cache.run_harvest(None, plans, harvest, budget_s=60))
    assert {o.plan.display: (o.status, o.linkedin_missing) for o in outcomes} == {
        "Answered Co": ("miss", False), "Silent Co": ("miss", True),
    }
    assert logo_harvester.harvest_report.get() is None  # nothing leaks out of run_harvest
