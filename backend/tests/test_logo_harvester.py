"""Logo harvester v2: identity-keyed source cascade, verified domains only,
every candidate downloaded and normalized. All HTTP is mocked and DNS is
monkeypatched, nothing here touches the network.

Behaviour changes vs v1 (intentional): candidates are decoded with Pillow, so
header-only fake PNGs no longer count as images; og:image is the LAST homepage
candidate and square-only (it used to rank second and let 1200x630 banners
through); a homepage is only used after verify_domain() accepts it; Wikidata
needs an exact label or an official-website match instead of a first-word
prefix; LinkedIn uses the guest jobPosting endpoint and requires the posting's
org name to BE the company. The sz=256 'favicon-only' sentinel is still the
callers' business: harvest_logo() returns '' when only s2 matched, which makes
them write that same URL.
"""

import asyncio
import hashlib
import io
import json
import re
import time

import httpx
import pytest
from PIL import Image, ImageDraw

import backend.services.logo_harvester as lh
import backend.services.logo_image as logo_image
from backend.services.logo_harvester import (
    LogoHints,
    harvest_company_logo,
    harvest_from_homepage,
    harvest_from_linkedin,
    harvest_from_wikidata,
    harvest_logo,
    image_width,
    name_key,
    verify_domain,
)

NXDOMAINS: set[str] = set()


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """No real DNS, no LinkedIn pacing delay."""
    NXDOMAINS.clear()

    async def fake_resolves(host):
        return host.removeprefix("www.") not in NXDOMAINS

    monkeypatch.setattr(lh, "_resolves", fake_resolves)
    monkeypatch.setattr(lh, "LINKEDIN_MIN_INTERVAL", 0)


# --- fixtures ---------------------------------------------------------------

def _png(w=180, h=None, fg=(20, 60, 200, 255), bg=(0, 0, 0, 0)) -> bytes:
    h = h or w
    im = Image.new("RGBA", (w, h), bg)
    ImageDraw.Draw(im).ellipse((w // 5, h // 5, w - w // 5, h - h // 5), fill=fg)
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


LOGO = _png(180)
LOGO_B = _png(200, fg=(200, 20, 20, 255))
TINY = _png(16)
BANNER = _png(1200, 630, bg=(240, 200, 120, 255))  # og-style share image
WORKDAY_CANVAS = _png(1200, 630, fg=(220, 0, 0, 255), bg=(255, 255, 255, 255))


def _router(routes: list[tuple[str, object]], log: list[str] | None = None):
    """MockTransport answering the first route whose regex matches the URL.
    A route value is (status, body[, content_type[, headers]]) or an async
    callable taking the request."""
    async def handler(request: httpx.Request):
        url = str(request.url)
        if log is not None:
            log.append(url)
        for pattern, answer in routes:
            if re.search(pattern, url):
                if callable(answer):
                    return await answer(request)
                status, body, *rest = answer
                ctype = rest[0] if rest else "text/html"
                headers = {"content-type": ctype, **(rest[1] if len(rest) > 1 else {})}
                return httpx.Response(status, content=body, headers=headers)
        return httpx.Response(404, content=b"")
    return httpx.MockTransport(handler)


async def _harvest(routes, hints, log=None, **kw):
    async with httpx.AsyncClient(transport=_router(routes, log)) as client:
        return await harvest_company_logo(client, hints, **kw)


def _li_job_page(org: str, logo_id: str = "AAA") -> bytes:
    return (
        '<section class="top-card-layout"><div class="topcard__flavor-row">'
        f'<a class="topcard__org-name-link topcard__flavor--black-link" href="https://ca.linkedin.com/company/x">\n  {org}\n  </a>'
        '<img class="artdeco-entity-image" data-delayed-url="https://media.licdn.com/dms/image/v2/'
        f'{logo_id}/company-logo_100_100/company-logo_100_100/0/1/x_logo?e=2147483647&amp;v=beta&amp;t=sig" alt="{org}">'
        "</div></section>"
        '<section class="similar-jobs"><img data-delayed-url="https://media.licdn.com/dms/image/v2/'
        'ZZZ/company-logo_100_100/company-logo_100_100/0/2/other?e=2147483647&amp;v=beta&amp;t=s2"></section>'
    ).encode()


def _li_card(name: str, slug: str, logo_id: str) -> str:
    return (
        '<li><div class="base-card base-search-card"><img class="artdeco-entity-image" '
        f'data-delayed-url="https://media.licdn.com/dms/image/v2/{logo_id}/company-logo_100_100/'
        'company-logo_100_100/0/1/l?e=2147483647&amp;v=beta&amp;t=x" alt>'
        '<div class="base-search-card__info"><h3 class="base-search-card__title"> Engineer </h3>'
        '<h4 class="base-search-card__subtitle"> <a class="hidden-nested-link" '
        f'href="https://www.linkedin.com/company/{slug}?trk=x"> {name} </a> </h4></div></div></li>'
    )


LICDN = r"media\.licdn\.com/dms/image/v2/"


# --- name keys ----------------------------------------------------------------

def test_name_key_normalization():
    assert name_key("**Tesla**") == name_key("Tesla") == "tesla"
    assert name_key("Notion (Ashby)") == "notion"
    assert name_key("AT&amp;T Inc.") == name_key("AT&T") == "atandt"
    assert name_key("Skyworks Solutions, Inc.") == name_key("Skyworks Solutions")
    assert name_key("The Home Depot") == name_key("Home Depot")
    # 'Company' is part of the name, not a legal suffix.
    assert name_key("The Bell Company") != name_key("Bell")


def test_image_width_decodes_real_images():
    assert image_width(_png(180)) == 180
    im = Image.open(io.BytesIO(_png(128))).convert("RGBA")
    ico = io.BytesIO()
    im.save(ico, format="ICO", sizes=[(16, 16), (48, 48), (128, 128)])
    assert image_width(ico.getvalue()) == 128  # largest frame, not the first entry
    assert image_width(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 30"/>') == 90
    # header-only fakes are not images any more
    assert image_width(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 24) == 0
    assert image_width(b"junk") == 0


# --- 0. existing logos ----------------------------------------------------------

@pytest.mark.asyncio
async def test_existing_logo_wins_and_generated_urls_are_never_fetched():
    log: list[str] = []
    result = await _harvest(
        [(r"cloudfront\.net/s/_squarelogo", (200, LOGO, "image/png")),
         (r"google\.com/s2", (200, LOGO_B, "image/png")),
         (r"icon\.horse", (200, LOGO_B, "image/png"))],
        LogoHints(
            company="Magna",
            existing_logo_urls=[
                "https://www.google.com/s2/favicons?domain=magna.com&sz=256",
                "https://icon.horse/icon/magna.com",
                "/jobs/logo/abc.png",
                "https://d2q79iu7y748jz.cloudfront.net/s/_squarelogo/256x256/magna.png",
            ],
            job_urls=["https://www.linkedin.com/jobs/view/4470193130"],
        ),
        log,
    )
    assert result is not None
    assert result.source == "existing" and "_squarelogo" in result.source_url
    assert result.logo.fmt == "png" and result.logo.sha == hashlib.sha1(result.logo.data).hexdigest()
    assert not any("s2" in u or "icon.horse" in u or "linkedin" in u for u in log)


@pytest.mark.asyncio
async def test_existing_banner_is_skipped():
    result = await _harvest(
        [(r"salesforce-logo\.jpg", (200, BANNER, "image/png"))],
        LogoHints(company="Salesforce",
                  existing_logo_urls=["https://wp.sfdcdigital.com/salesforce-logo.jpg"]),
    )
    assert result is None


# --- 1. LinkedIn job page -------------------------------------------------------

@pytest.mark.asyncio
async def test_linkedin_job_page_logo_when_org_matches():
    log: list[str] = []
    result = await _harvest(
        [(r"jobs-guest/jobs/api/jobPosting/4470375540", (200, _li_job_page("Mobii Systems Inc."))),
         (LICDN + "AAA", (200, LOGO, "image/png")),
         (LICDN + "ZZZ", (200, LOGO_B, "image/png"))],
        LogoHints(company="**Mobii Systems**", job_urls=[
            "https://ca.linkedin.com/jobs/view/software-developer-at-mobii-systems-4470375540?refId=x",
        ]),
        log,
    )
    assert result.source == "linkedin_job"
    assert "/AAA/" in result.source_url                  # the top-card logo, not similar-jobs
    assert "&v=beta&t=sig" in result.source_url          # HTML-unescaped, signature intact
    assert "linkedin.com/jobs/view" not in " ".join(log)  # the 330KB page is never fetched


@pytest.mark.asyncio
async def test_linkedin_job_page_rejects_another_company():
    log: list[str] = []
    result = await _harvest(
        [(r"jobs-guest/jobs/api/jobPosting/", (200, _li_job_page("Unrelated Corp"))),
         (r"seeMoreJobPostings", (200, b"<ul></ul>")),
         (LICDN, (200, LOGO, "image/png"))],
        LogoHints(company="Mobii Systems", job_urls=["https://www.linkedin.com/jobs/view/4470193130"]),
        log,
    )
    assert result is None
    assert not any("licdn" in u for u in log)


# --- 2. LinkedIn search --------------------------------------------------------

@pytest.mark.asyncio
async def test_linkedin_search_exact_name_match():
    log: list[str] = []
    cards = (
        "<ul>" + _li_card("Acme Robotics", "acme-robotics", "ROB")
        + _li_card("Acme, Inc.", "acme", "ACM") + _li_card("Acme", "acme", "ACM") + "</ul>"
    )
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, cards.encode())),
         (LICDN + "ACM", (200, LOGO, "image/png")),
         (LICDN + "ROB", (200, LOGO_B, "image/png"))],
        LogoHints(company="Acme"),
        log,
    )
    assert result.source == "linkedin_search" and "/ACM/" in result.source_url
    search = next(u for u in log if "seeMoreJobPostings" in u)
    assert "keywords=Acme" in search


@pytest.mark.asyncio
async def test_linkedin_search_rejects_ambiguous_name():
    cards = "<ul>" + _li_card("Bell", "bell-flight", "BF") + _li_card("Bell", "bell-mechanical", "BM") + "</ul>"
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, cards.encode())), (LICDN, (200, LOGO, "image/png"))],
        LogoHints(company="Bell"),
    )
    assert result is None


@pytest.mark.parametrize("longer,company,expected", [
    ("Magna International", "Magna", True),
    ("Magna International Inc.", "**Magna**", True),
    ("BMO Financial Group", "BMO", True),
    ("Bell Canada", "Bell", True),
    ("Intact Financial Corporation", "Intact", True),
    ("Bell Flight", "Bell", False),            # another employer
    ("Bell Textron Canada", "Bell", False),
    ("The Bell Company", "Bell", False),       # prefix + 'Company'
    ("The Bell Group", "Bell", False),         # a leading 'The' is a different name
    ("Magnaporthe oryzae", "Magna", False),
    ("Magna", "Magna", False),                 # not longer
    ("Bell", "Bell Canada", False),            # one direction only
    ("Magna International Group Canada", "Magna", False),  # at most two words
    ("Global Group", "Global", False),         # the base must say more than a generic word
    ("BMO Capital Markets", "BMO", False),
])
def test_suffix_variants(longer, company, expected):
    assert lh.is_suffix_variant(longer, company) is expected


def _search_page(*cards: tuple[str, str, str]) -> bytes:
    return ("<ul>" + "".join(_li_card(*card) for card in cards) + "</ul>").encode()


@pytest.mark.asyncio
@pytest.mark.parametrize("company,cards,logo_id", [
    # prod shapes: 'Magna' (181 rows, no logo) vs LinkedIn's 'Magna International'
    ("Magna", [("Magna International", "magna-international", "MAG"),
               ("Magnachip", "magnachip", "CHIP")], "MAG"),
    ("BMO", [("BMO Capital Markets", "bmo-capital-markets", "CAP"),
             ("BMO Financial Group", "bmo-financial-group", "BFG"),
             ("BMO Financial Group", "bmo-financial-group", "BFG")], "BFG"),
    ("Bell", [("Bell Flight", "bell-flight", "FLT"), ("Bell Canada", "bell-canada", "BCE")], "BCE"),
])
async def test_linkedin_search_accepts_the_longer_name(company, cards, logo_id):
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, _search_page(*cards))), (LICDN, (200, LOGO, "image/png"))],
        LogoHints(company=company),
    )
    assert result.source == "linkedin_search" and f"/{logo_id}/" in result.source_url


@pytest.mark.asyncio
@pytest.mark.parametrize("company,cards", [
    ("Bell", [("Bell Flight", "bell-flight", "FLT"), ("The Bell Company", "the-bell-company", "TBC")]),
    ("Bell", [("Bell Textron", "bell-textron", "TX")]),
    # two different employers answer to the longer name: neither is safe
    ("Magna", [("Magna International", "magna-international", "MAG"),
               ("MAGNA Global", "magna-global", "MG")]),
    ("Magna", [("Magna International", "magna-international", "MAG"),
               ("Magna International", "magna-intl-duplicate", "MG2")]),
])
async def test_linkedin_search_rejects_other_employers_and_ambiguous_longer_names(company, cards):
    log: list[str] = []
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, _search_page(*cards))), (LICDN, (200, LOGO, "image/png"))],
        LogoHints(company=company),
        log,
    )
    assert result is None
    assert not any("licdn" in u for u in log)


@pytest.mark.asyncio
async def test_linkedin_search_exact_name_beats_a_longer_one():
    cards = _search_page(("Magna Global", "magna-global", "MG"), ("Magna", "magna", "EXACT"))
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, cards)), (LICDN, (200, LOGO, "image/png"))],
        LogoHints(company="Magna"),
    )
    assert "/EXACT/" in result.source_url


@pytest.mark.asyncio
async def test_linkedin_cooldown_waits_out_a_block_instead_of_skipping(monkeypatch):
    monkeypatch.setattr(lh, "LINKEDIN_BLOCK_COOLDOWN", 0.05)
    answers = iter([429, 200])

    async def job_page(request):
        status = next(answers)
        return httpx.Response(status, content=_li_job_page("Kinaxis") if status == 200 else b"")

    routes = [(r"jobs-guest/jobs/api/jobPosting/", job_page), (LICDN + "AAA", (200, LOGO, "image/png"))]
    async with httpx.AsyncClient(transport=_router(routes)) as client:
        started = time.monotonic()
        result = await harvest_company_logo(client, LogoHints(
            company="Kinaxis", job_urls=["https://www.linkedin.com/jobs/view/4470193130"]))
        assert result.source == "linkedin_job"
        assert time.monotonic() - started >= 0.05
        assert lh.linkedin_stats(client) == {"calls": 2, "blocks": 1, "blocked": False,
                                             "blocked_at": None}


@pytest.mark.asyncio
async def test_linkedin_cooldown_gives_up_after_repeated_blocks(monkeypatch):
    monkeypatch.setattr(lh, "LINKEDIN_BLOCK_COOLDOWN", 0.001)
    log: list[str] = []
    async with httpx.AsyncClient(transport=_router([(r"linkedin\.com", (429, b""))], log)) as client:
        result = await harvest_company_logo(client, LogoHints(
            company="Acme", job_urls=["https://www.linkedin.com/jobs/view/4470193130"]))
        assert result is None
        stats = lh.linkedin_stats(client)
        assert stats["blocked"] is True and stats["blocks"] == lh._LINKEDIN_MAX_BLOCKS + 1
        assert stats["blocked_at"] is not None
    assert sum("linkedin.com" in u for u in log) == lh._LINKEDIN_MAX_BLOCKS + 1


@pytest.mark.asyncio
async def test_linkedin_429_skips_linkedin_for_the_rest_of_the_run():
    log: list[str] = []
    result = await _harvest(
        [(r"linkedin\.com", (429, b"")),
         (r"jobs\.ashbyhq\.com/acme$",
          (200, b'<link href="https://app.ashbyhq.com/api/images/org-theme-logo/o/t/l.png">')),
         (r"org-theme-logo", (200, LOGO, "image/png"))],
        LogoHints(company="Acme", job_urls=[
            "https://www.linkedin.com/jobs/view/4470193130",
            "https://www.linkedin.com/jobs/view/4470193131",
            "https://jobs.ashbyhq.com/acme/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
        ]),
        log,
    )
    assert result.source == "ats_ashby"
    assert sum("linkedin.com" in u for u in log) == 1  # no second job page, no search


@pytest.mark.asyncio
async def test_linkedin_calls_are_paced(monkeypatch):
    monkeypatch.setattr(lh, "LINKEDIN_MIN_INTERVAL", 0.25)
    started = time.monotonic()
    await _harvest(
        [(r"jobs-guest/jobs/api/jobPosting/", (200, _li_job_page("Other"))),
         (r"seeMoreJobPostings", (200, b"<ul></ul>"))],
        LogoHints(company="Acme", job_urls=["https://www.linkedin.com/jobs/view/4470193130"]),
    )
    assert time.monotonic() - started >= 0.25


# --- 3. ATS boards ----------------------------------------------------------------

ATS_CASES = {
    "ashby": (
        "https://jobs.ashbyhq.com/acme/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
        [(r"jobs\.ashbyhq\.com/acme$",
          (200, b'<link rel="preload" as="image" href="https://app.ashbyhq.com/api/images/'
                b'org-theme-logo/org/theme/logo.png">"publicWebsite":"https://acme.example/"')),
         (r"org-theme-logo/org/theme/logo\.png", (200, LOGO, "image/png"))],
    ),
    "workday": (
        "https://acme.wd3.myworkdayjobs.com/en-US/External/job/Ottawa/Engineer_R1",
        [(r"acme\.wd3\.myworkdayjobs\.com/External/assets/logo$", (200, WORKDAY_CANVAS, "image/png"))],
    ),
    "lever": (
        "https://jobs.lever.co/acme/a9d061e9-4d28-4a30-8381-5f2dc28b4416",
        [(r"jobs\.lever\.co/acme$",
          (200, b'<meta property="og:image" content="https://lever-client-logos.s3.amazonaws.com/og.png" />'
                b'<div class="main-header-logo"><a href="/"><img alt="Acme logo" '
                b'src="https://lever-client-logos.s3.amazonaws.com/header.png"></a></div>')),
         (r"lever-client-logos.*/header\.png", (200, _png(400, 120), "image/png")),
         (r"lever-client-logos.*/og\.png", (200, BANNER, "image/png"))],
    ),
    "greenhouse": (
        "https://job-boards.greenhouse.io/acme/jobs/4716835006",
        [(r"boards\.greenhouse\.io/embed/job_board\?for=acme",
          (200, b'<meta property="og:image" content="https://s6-recruiting.cdn.greenhouse.io/'
                b'external_greenhouse_job_boards/logos/400/056/000/original/sq_icon.jpg?1740118785"/>')),
         (r"external_greenhouse_job_boards/logos/", (200, LOGO, "image/jpeg"))],
    ),
    "smartrecruiters": (
        "https://careers.smartrecruiters.com/AcmeGroup/744000151857044",
        [(r"jobs\.smartrecruiters\.com/AcmeGroup/744000151857044",
          (200, b'<span class="header-logo logo"><a href="https://www.acme.example/"><img '
                b'src="https://c.smartrecruiters.com/sr-company-logo-prod-aws-dc5/5865/huge?r=s3&amp;_17" '
                b'alt="Acme logo"></a></span>')),
         (r"c\.smartrecruiters\.com/sr-company-logo-prod-aws-dc5/5865/huge\?r=s3&_17$",
          (200, _png(285, 114), "image/png"))],
    ),
    "bamboohr": (
        "https://acme.bamboohr.com/careers/119",
        [(r"acme\.bamboohr\.com/careers/company-info",
          (200, b'{"result":{"name":"Acme","logoUrl":"https:\\/\\/images7.bamboohr.com\\/1\\/logos\\/cropped.jpg?v=42"}}',
           "application/json")),
         (r"images7\.bamboohr\.com/1/logos/cropped\.jpg", (200, _png(382, 120), "image/png"))],
    ),
    "workable": (
        "https:///.workable.com/acme/j/5E96914ADB",  # the malformed shape stored on prod
        [(r"apply\.workable\.com/api/v1/accounts/acme$",
          (200, b'{"logo":"https://workablehr.s3.amazonaws.com/uploads/account/logo/1/logo",'
                b'"url":"https://www.acme.example/"}', "application/json")),
         (r"workablehr\.s3\.amazonaws\.com/uploads/account/logo/1/logo", (200, LOGO, "image/png"))],
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("ats", list(ATS_CASES))
async def test_ats_board_logo(ats):
    job_url, routes = ATS_CASES[ats]
    log: list[str] = []
    result = await _harvest(
        [(r"linkedin\.com", (200, b"<ul></ul>"))] + routes,
        LogoHints(company="Acme", domains=["acme.example"], job_urls=[job_url]),
        log,
    )
    assert result is not None and result.source == f"ats_{ats}"
    assert result.verified_domain is None
    assert Image.open(io.BytesIO(result.logo.data)).size == (128, 128)
    assert not any(u.startswith("https://acme.example") for u in log)  # homepage never needed
    if ats == "smartrecruiters":
        # careers.smartrecruiters.com 302s to the careers home for every job
        assert not any("careers.smartrecruiters.com" in u for u in log)
    if ats == "lever":
        assert "header.png" in result.source_url


@pytest.mark.asyncio
async def test_lever_og_banner_alone_is_rejected():
    result = await _harvest(
        [(r"jobs\.lever\.co/acme$",
          (200, b'<meta property="og:image" content="https://lever-client-logos.s3.amazonaws.com/og.png" />')),
         (r"og\.png", (200, BANNER, "image/png"))],
        LogoHints(company="Acme", job_urls=["https://jobs.lever.co/acme/a9d061e9-4d28-4a30-8381-5f2dc28b4416"]),
    )
    assert result is None


@pytest.mark.asyncio
async def test_ats_website_feeds_domain_verification():
    """An ATS board that lists the company site (Ashby publicWebsite) but has
    no usable logo still lends that domain to the homepage step."""
    result = await _harvest(
        [(r"linkedin\.com", (200, b"<ul></ul>")),
         (r"jobs\.ashbyhq\.com/acme$", (200, b'"publicWebsite":"https://www.acme.io/"')),
         (r"https://acme\.io/$", (200, b"<title>Acme | Home</title>"
                                       b'<link rel="apple-touch-icon" href="/touch.png">')),
         (r"acme\.io/touch\.png", (200, LOGO, "image/png"))],
        LogoHints(company="Acme", domains=["acmecorp.com"],
                  job_urls=["https://jobs.ashbyhq.com/acme/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"]),
    )
    assert result.source == "homepage" and result.verified_domain == "acme.io"


# --- ordering -------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cascade_order_linkedin_before_ats_before_homepage():
    routes = [
        (r"jobs-guest/jobs/api/jobPosting/", (200, _li_job_page("Acme"))),
        (LICDN + "AAA", (200, LOGO, "image/png")),
        (r"seeMoreJobPostings", (200, b"<ul></ul>")),
        (r"acme\.wd3\.myworkdayjobs\.com/External/assets/logo$", (200, WORKDAY_CANVAS, "image/png")),
        (r"https://acme\.example/$", (200, b'<title>Acme</title><link rel="apple-touch-icon" href="/t.png">')),
        (r"acme\.example/t\.png", (200, LOGO_B, "image/png")),
    ]
    hints = LogoHints(company="Acme", domains=["acme.example"], job_urls=[
        "https://acme.wd3.myworkdayjobs.com/External/job/Ottawa/Engineer_R1",
        "https://www.linkedin.com/jobs/view/4470193130",
    ])
    first = await _harvest(routes, hints)
    assert first.source == "linkedin_job"
    without_li = await _harvest(routes[2:], hints)
    assert without_li.source == "ats_workday"
    log: list[str] = []
    homepage = await _harvest(routes[2:3] + routes[4:], hints, log)
    assert homepage.source == "homepage" and homepage.verified_domain == "acme.example"
    assert not any("wikidata" in u or "s2/favicons" in u for u in log)


# --- 4. homepage on verified domains only ----------------------------------------

HOMEPAGE = b"""<html><head><title>Acme Robotics - Home</title>
<meta property="og:image" content="https://acme.example/share.png">
<link rel="icon" href="/favicon-16.png" sizes="16x16">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
</head></html>"""


@pytest.mark.asyncio
async def test_homepage_prefers_apple_touch_icon_and_never_the_og_banner():
    log: list[str] = []
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, b"<ul></ul>")),
         (r"https://acme\.example/$", (200, HOMEPAGE)),
         (r"apple-touch-icon\.png", (200, LOGO, "image/png")),
         (r"share\.png", (200, BANNER, "image/png"))],
        LogoHints(company="Acme Robotics", domains=["acme.example"]),
        log,
    )
    assert result.source == "homepage" and result.source_url.endswith("/icons/apple-touch-icon.png")
    assert not any("share.png" in u for u in log)


@pytest.mark.asyncio
async def test_homepage_og_image_only_when_square():
    page = (b"<title>Acme</title><meta property='og:image' content='/og.png'>")
    routes = [(r"https://acme\.example/$", (200, page)), (r"acme\.example/og\.png", (200, BANNER, "image/png"))]
    assert await _harvest(routes, LogoHints(company="Acme", domains=["acme.example"])) is None
    routes[1] = (r"acme\.example/og\.png", (200, LOGO, "image/png"))
    square = await _harvest(routes, LogoHints(company="Acme", domains=["acme.example"]))
    assert square.source == "homepage" and square.source_url.endswith("/og.png")


@pytest.mark.asyncio
async def test_homepage_manifest_svg_and_favicon_fallbacks():
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
           b'<circle cx="32" cy="32" r="30" fill="#0a7"/></svg>')
    page = (b'<title>Acme</title><link rel="manifest" href="/m.json">'
            b'<link rel="icon" type="image/svg+xml" href="/icon.svg">')
    manifest = b'{"icons":[{"src":"/i-192.png","sizes":"192x192"},{"src":"/i-512.png","sizes":"512x512"}]}'
    base = [(r"https://acme\.example/$", (200, page))]
    got = await _harvest(base + [(r"m\.json", (200, manifest, "application/manifest+json")),
                                 (r"i-512\.png", (200, LOGO, "image/png"))],
                         LogoHints(company="Acme", domains=["acme.example"]))
    assert got.source_url.endswith("/i-512.png")  # largest manifest icon first
    got = await _harvest(base + [(r"icon\.svg", (200, svg, "image/svg+xml"))],
                         LogoHints(company="Acme", domains=["acme.example"]))
    assert got.logo.fmt == "svg" and got.source_url.endswith("/icon.svg")
    ico = io.BytesIO()
    Image.open(io.BytesIO(_png(96))).save(ico, format="ICO", sizes=[(16, 16), (96, 96)])
    got = await _harvest([(r"https://acme\.example/$", (200, b"<title>Acme</title>")),
                          (r"acme\.example/favicon\.ico", (200, ico.getvalue(), "image/x-icon"))],
                         LogoHints(company="Acme", domains=["acme.example"]))
    assert got.source_url.endswith("/favicon.ico") and got.logo.width == 96


@pytest.mark.asyncio
async def test_homepage_icons_ignored_on_unverified_domain():
    log: list[str] = []
    result = await _harvest(
        [(r"https://nvidiaai\.com/$", (200, b"<title>nvidiaai.com is for sale</title>"
                                            b"<p>Buy this domain</p><link rel='apple-touch-icon' href='/t.png'>")),
         (r"t\.png", (200, LOGO, "image/png")),
         (r"google\.com/s2", (200, LOGO, "image/png"))],
        LogoHints(company="NVIDIA AI", domains=["nvidiaai.com"]),
        log,
    )
    assert result is None
    assert not any(u.endswith("/t.png") or "s2/favicons" in u for u in log)


# --- verify_domain ---------------------------------------------------------------

async def _verify(routes, domain, company, log=None):
    async with httpx.AsyncClient(transport=_router(routes, log)) as client:
        return await verify_domain(client, domain, company)


@pytest.mark.asyncio
async def test_verify_domain_accepts_title_or_label_match():
    assert await _verify([(r"kinaxis\.com/$", (200, b"<title>Kinaxis | Supply chain</title>"))],
                         "kinaxis.com", "Kinaxis") == "kinaxis.com"
    # label carries no token, but the page names the company
    assert await _verify([(r"rbc\.com/$", (200, b"<title>RBC Royal Bank</title>"))],
                         "https://www.rbc.com/", "Royal Bank of Canada") == "rbc.com"
    # a bot wall (403) still verifies when the domain label is the company
    assert await _verify([(r"carvana\.com/$", (403, b""))], "carvana.com", "Carvana") == "carvana.com"


@pytest.mark.asyncio
async def test_verify_domain_rejects_nxdomain_without_http():
    NXDOMAINS.add("bdocanada.com")
    log: list[str] = []
    assert await _verify([(r".", (200, b"<title>BDO Canada</title>"))], "bdocanada.com", "BDO Canada", log) is None
    assert log == []


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["kochag", "peopleinc..com", "mom'sorganicmarket.com", "pure(ycs23).com", ""])
async def test_verify_domain_rejects_bad_syntax(domain):
    assert await _verify([(r".", (200, b"<title>x</title>"))], domain, "Koch AG") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    b'<html><script>window.location.href="/lander"</script></html>',
    b"<title>helmai.com</title><img src='https://forsale.spaceship-cdn.com/x.png'>",
    b"<title>Helm AI</title><h1>This domain is for sale!</h1>",
    b"<title>helmai.com</title><a href='https://www.hugedomains.com/domain_profile.cfm?d=helmai.com'>",
], ids=["godaddy-lander", "spaceship", "for-sale-text", "hugedomains"])
async def test_verify_domain_rejects_parked_pages(body):
    assert await _verify([(r"helmai\.com/$", (200, body))], "helmai.com", "Helm AI") is None


@pytest.mark.asyncio
async def test_verify_domain_redirects():
    toast = [(r"^https://toast\.example/$", (301, b"", "text/html", {"location": "https://www.nhncloud.example/"})),
             (r"nhncloud\.example/$", (200, b"<title>NHN Cloud</title>"))]
    assert await _verify(toast, "toast.example", "Toast") is None
    notion = [(r"^https://notion\.com/$", (301, b"", "text/html", {"location": "https://www.notion.so/"})),
              (r"notion\.so/$", (200, b"<title>Notion - your connected workspace</title>"))]
    assert await _verify(notion, "notion.com", "Notion (Ashby)") == "notion.so"
    lander = [(r"^https://mda\.example/$", (302, b"", "text/html", {"location": "https://mda.example/lander"})),
              (r"mda\.example/lander", (200, b"<title>MDA</title>"))]
    assert await _verify(lander, "mda.example", "MDA") is None


@pytest.mark.asyncio
async def test_verify_domain_rejects_unrelated_site():
    assert await _verify([(r"thera\.com/$", (200, b"<title>Therapy Rooms Rental</title>"))],
                         "thera.com", "Acme Health") is None

    async def refused(request):
        raise httpx.ConnectError("connection refused")

    # resolves, but no web server answers
    assert await _verify([(r".", refused)], "acme.example", "Acme") is None


# --- 5. Wikidata ------------------------------------------------------------------

def _entity(qid, label, sites, logos):
    return {
        "id": qid,
        "labels": {"en": {"value": label}},
        "claims": {
            "P856": [{"mainsnak": {"datavalue": {"value": s}}} for s in sites],
            "P154": [
                {"rank": rank, "mainsnak": {"datavalue": {"value": f}},
                 **({"qualifiers": {"P582": [{}]}} if ended else {})}
                for f, rank, ended in logos
            ],
        },
    }


def _wd_routes(search_hits, entities, logo_bytes=LOGO):
    return [
        (r"list=search", (200, json.dumps({"query": {"search": [{"title": q} for q in search_hits]}}).encode(),
                          "application/json")),
        (r"wbsearchentities", (200, json.dumps({"search": [{"id": e["id"]} for e in entities]}).encode(),
                               "application/json")),
        (r"wbgetentities", (200, json.dumps({"entities": {e["id"]: e for e in entities}}).encode(),
                            "application/json")),
        (r"commons\.wikimedia\.org/wiki/Special:FilePath/", (200, logo_bytes, "image/png")),
    ]


@pytest.mark.asyncio
async def test_wikidata_by_verified_domain_picks_current_logo():
    bmo = _entity("Q806693", "Bank of Montreal", ["http://www.bmo.com/"],
                  [("BMO old (1990-2000).svg", "normal", True), ("BMO Logo.svg", "normal", False)])
    log: list[str] = []
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, b"<ul></ul>")),
         (r"https://bmo\.com/$", (200, b"<title>BMO Financial Group</title>"))]
        + _wd_routes(["Q806693"], [bmo]),
        LogoHints(company="BMO", domains=["bmo.com"]),
        log,
    )
    assert result.source == "wikidata" and result.verified_domain == "bmo.com"
    assert "BMO%20Logo.svg" in result.source_url and "width=256" in result.source_url
    search = next(u for u in log if "list=search" in u)
    assert "haswbstatement" in search and "P856" in search
    assert not any("s2/favicons" in u for u in log)


@pytest.mark.asyncio
async def test_wikidata_rejects_entity_with_other_website():
    dune = _entity("Q1", "Dune", ["https://dunemovie.net/"], [("Dune.svg", "preferred", False)])
    result = await _harvest(
        [(r"seeMoreJobPostings", (200, b"<ul></ul>")),
         (r"https://dune\.example/$", (200, b"<title>Dune Security</title>"))]
        + _wd_routes([], [dune]),
        LogoHints(company="Dune", domains=["dune.example"]),
    )
    assert result is None


@pytest.mark.asyncio
async def test_wikidata_without_verified_domain_needs_the_name_or_its_longer_name():
    # W2 change: 'Magna' (prod: 181 rows, no logo) used to be refused here;
    # 'Magna International' is its longer name, the fungus never was.
    magna = _entity("Q697311", "Magna International", ["https://www.magna.com/"], [("Magna logo.svg", "normal", False)])
    fungus = _entity("Q2", "Magnaporthe oryzae", [], [("Fungus.svg", "normal", False)])
    NXDOMAINS.add("magnaguess.com")
    assert await _harvest(_wd_routes([], [fungus]),
                          LogoHints(company="Magna", domains=["magnaguess.com"])) is None
    hit = await _harvest(_wd_routes([], [fungus, magna]),
                         LogoHints(company="Magna", domains=["magnaguess.com"]))
    assert hit.source == "wikidata" and "Magna%20logo.svg" in hit.source_url
    assert hit.verified_domain is None
    hit = await _harvest(_wd_routes([], [fungus, magna]),
                         LogoHints(company="**Magna International**", domains=["magnaguess.com"]))
    assert hit.source == "wikidata" and hit.verified_domain is None
    async with httpx.AsyncClient(transport=_router(_wd_routes([], [fungus, magna]))) as client:
        assert "Magna%20logo.svg" in await harvest_from_wikidata(client, "Magna International")
        assert "Magna%20logo.svg" in await harvest_from_wikidata(client, "Magna")
        # a shorter label never stands in for a longer company name
        assert await harvest_from_wikidata(client, "Magna International Group Canada") == ""


def _wd_search_routes(hits_for: dict[str, list[dict]], logo_bytes=LOGO, log=None):
    """Wikidata answering each name search with its own entities."""
    entities = {e["id"]: e for found in hits_for.values() for e in found}

    async def search(request):
        query = request.url.params.get("search", "")
        found = hits_for.get(query, [])
        body = {"search": [{"id": e["id"], "label": e["labels"]["en"]["value"]} for e in found]}
        if log is not None:
            log.append(query)
        return httpx.Response(200, json=body)

    async def get(request):
        ids = request.url.params.get("ids", "").split("|")
        return httpx.Response(200, json={"entities": {i: entities[i] for i in ids if i in entities}})

    return [
        (r"list=search", (200, b'{"query": {"search": []}}', "application/json")),
        (r"wbsearchentities", search),
        (r"wbgetentities", get),
        (r"commons\.wikimedia\.org/wiki/Special:FilePath/", (200, logo_bytes, "image/png")),
    ]


@pytest.mark.asyncio
async def test_wikidata_searches_the_longer_name_when_the_name_finds_nothing():
    # 'Bell' only finds bells, a surname and a town; 'Bell Canada' is the employer.
    surname = _entity("Q1444604", "Bell", [], [])
    bell_canada = _entity("Q815694", "Bell Canada", ["https://www.bell.ca/"], [("Bell logo.svg", "normal", False)])
    bell_flight = _entity("Q3", "Bell Flight", ["https://www.bellflight.com/"], [("Bell Flight.svg", "normal", False)])
    queries: list[str] = []
    routes = _wd_search_routes({
        "Bell": [surname, bell_flight],
        "Bell Canada": [bell_canada, bell_flight],
        "Bell Group": [bell_flight],
    }, log=queries)
    hit = await _harvest(routes, LogoHints(company="Bell"))
    assert hit.source == "wikidata" and "Bell%20logo.svg" in hit.source_url
    assert "Bell Canada" in queries and "Bell International" in queries
    # 'Bell Flight' answers every search and is never a longer name for Bell
    only_flight = _wd_search_routes({"Bell": [surname, bell_flight], "Bell Canada": [bell_flight]})
    assert await _harvest(only_flight, LogoHints(company="Bell")) is None


@pytest.mark.asyncio
async def test_wikidata_two_longer_names_are_ambiguous():
    intl = _entity("Q697311", "Magna International", [], [("Magna logo.svg", "normal", False)])
    agency = _entity("Q9", "Magna Global", [], [("Magna Global.svg", "normal", False)])
    routes = _wd_search_routes({"Magna": [intl, agency]})
    assert await _harvest(routes, LogoHints(company="Magna")) is None
    # an exact label still wins over longer ones
    exact = _entity("Q10", "Magna", [], [("Magna exact.svg", "normal", False)])
    routes = _wd_search_routes({"Magna": [intl, agency, exact]})
    hit = await _harvest(routes, LogoHints(company="Magna"))
    assert "Magna%20exact.svg" in hit.source_url


@pytest.mark.asyncio
async def test_wikidata_large_entity_payload_still_parses():
    # Ten big companies' claims top the 300KB page cap that used to truncate
    # the JSON into a silent miss.
    magna = _entity("Q697311", "Magna International", ["https://www.magna.com/"], [("Magna logo.svg", "normal", False)])
    magna["claims"]["P999"] = [{"mainsnak": {"datavalue": {"value": "x" * 1000}}}] * 450
    routes = [(r"https://magna\.com/$", (200, b"<title>Magna International</title>"))]
    routes += _wd_routes(["Q697311"], [magna])
    hit = await _harvest(routes, LogoHints(company="Magna", domains=["magna.com"]))
    assert hit is not None and hit.source == "wikidata" and hit.verified_domain == "magna.com"


# --- 6. google s2 -------------------------------------------------------------------

@pytest.mark.asyncio
async def test_s2_last_resort_on_verified_domain_only(monkeypatch):
    routes = [(r"https://acme\.example/$", (200, b"<title>Acme</title>")),
              (r"google\.com/s2/favicons\?domain=acme\.example&sz=256", (200, _png(256), "image/png"))]
    result = await _harvest(routes, LogoHints(company="Acme", domains=["acme.example"]))
    assert result.source == "s2" and result.verified_domain == "acme.example"
    # the GoDaddy/globe placeholders are rejected by hash
    monkeypatch.setattr(logo_image, "PLACEHOLDER_SHAS",
                        logo_image.PLACEHOLDER_SHAS | {hashlib.sha1(_png(256)).hexdigest()[:16]})
    assert await _harvest(routes, LogoHints(company="Acme", domains=["acme.example"])) is None
    # a 16px favicon upscales into a blur
    routes[1] = (r"google\.com/s2", (200, TINY, "image/png"))
    assert await _harvest(routes, LogoHints(company="Acme", domains=["acme.example"])) is None


# --- robustness ---------------------------------------------------------------------

@pytest.mark.asyncio
async def test_harvest_time_cap():
    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200, content=b"")

    started = time.monotonic()
    result = await _harvest([(r".", slow)], LogoHints(company="Acme", domains=["acme.example"]), time_cap=0.2)
    assert result is None and time.monotonic() - started < 2


@pytest.mark.asyncio
async def test_harvest_never_raises():
    async def boom(request):
        raise httpx.ConnectError("down")

    hints = LogoHints(company="Acme", domains=["acme.example"],
                      job_urls=["https://www.linkedin.com/jobs/view/4470193130",
                                "https://jobs.lever.co/acme/a9d061e9-4d28-4a30-8381-5f2dc28b4416"],
                      existing_logo_urls=["https://cdn.example/logo.png"])
    assert await _harvest([(r".", boom)], hints) is None


@pytest.mark.asyncio
async def test_oversized_images_are_not_downloaded_whole():
    huge = b"\x89PNG" + b"\x00" * (lh._MAX_IMAGE_BYTES + 10)
    result = await _harvest([(r"big\.png", (200, huge, "image/png"))],
                            LogoHints(company="Acme", existing_logo_urls=["https://cdn.example/big.png"]))
    assert result is None


# --- legacy URL API ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_legacy_harvest_logo_returns_url_or_empty_for_s2():
    routes = [(r"jobs-guest/jobs/api/jobPosting/", (200, _li_job_page("Kinaxis"))),
              (LICDN + "AAA", (200, LOGO, "image/png"))]
    async with httpx.AsyncClient(transport=_router(routes)) as client:
        url = await harvest_logo(client, "kinaxis.com", "Kinaxis", "https://www.linkedin.com/jobs/view/4470193130")
        assert url.startswith("https://media.licdn.com/") and "&amp;" not in url
        assert await harvest_from_linkedin(client, "https://www.linkedin.com/jobs/view/4470193130", "Kinaxis") == url
        assert await harvest_from_linkedin(client, "https://www.linkedin.com/jobs/view/4470193130", "Other") == ""
    s2_only = [(r"seeMoreJobPostings", (200, b"<ul></ul>")),
               (r"https://acme\.example/$", (200, b"<title>Acme</title>")),
               (r"google\.com/s2", (200, _png(256), "image/png"))]
    async with httpx.AsyncClient(transport=_router(s2_only)) as client:
        # s2 is exactly the callers' sz=256 sentinel, so report "nothing better"
        assert await harvest_logo(client, "acme.example", "Acme") == ""


@pytest.mark.asyncio
async def test_legacy_harvest_from_homepage_verifies_first():
    routes = [(r"https://acme\.example/$", (200, HOMEPAGE)),
              (r"apple-touch-icon\.png", (200, LOGO, "image/png"))]
    async with httpx.AsyncClient(transport=_router(routes)) as client:
        assert (await harvest_from_homepage(client, "acme.example", "Acme Robotics")).endswith("apple-touch-icon.png")
        assert await harvest_from_homepage(client, "acme.example", "Zebra Foods") == ""
        NXDOMAINS.add("acme.example")
        assert await harvest_from_homepage(client, "acme.example") == ""
