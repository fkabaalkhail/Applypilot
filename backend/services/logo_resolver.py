"""
LogoResolver, turns a company name and/or website URL into an accurate,
stable company logo URL.

Accuracy strategy (highest confidence first):
1. Use the company website URL that jobright tables provide in the company cell
   (e.g. ``**[Repligen Corporation](http://www.repligen.com)**``). The registrable
   domain of that URL is the authoritative key for a logo.
2. Fall back to a curated KNOWN_DOMAINS map for well-known companies whose name
   does not trivially map to their domain (e.g. "Electronic Arts" -> ea.com).
3. Fall back to a heuristic domain guess derived from the company name.

The logo image itself is served by Google's favicon service, which is fast,
high-availability, and returns a transparent 1x1 (not a broken image) when it
has nothing, but we also expose the resolved domain so the frontend can render
a deterministic letter-avatar fallback and never show a broken <img>.

These are pure functions with no I/O so they are cheap and unit-testable.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import parse_qs, urlparse

# Logo image provider. Google's favicon service is reliable and CORS-friendly.
# sz=128 gives a crisp logo for card + detail views.
_LOGO_TEMPLATE = "https://www.google.com/s2/favicons?domain={domain}&sz=128"

# A bare hostname: labels of letters/digits/hyphens with a dotted suffix.
_DOMAIN_SHAPE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")

# Multi-part public suffixes we must keep intact when reducing to a
# registrable domain (so "company.co.uk" doesn't collapse to "co.uk").
_MULTI_PART_TLDS = {
    "co.uk", "org.uk", "ac.uk", "gov.uk",
    "com.au", "net.au", "org.au",
    "co.jp", "co.kr", "co.in", "co.nz", "co.za",
    "com.br", "com.mx", "com.sg", "com.hk", "com.tr",
}

# Hosts that are never a real company website (aggregators, ATS, social, etc.).
# If a URL points here we ignore it and fall back to the name-based resolution.
_NON_COMPANY_HOSTS = {
    "jobright.ai", "newgrad-jobs.com", "linkedin.com", "indeed.com",
    "glassdoor.com", "github.com", "greenhouse.io", "lever.co",
    "myworkdayjobs.com", "ashbyhq.com", "smartrecruiters.com",
    "icims.com", "taleo.net", "bit.ly", "google.com",
}

# Hosted career-site and job-board platforms. An apply link on one of these
# names the vendor, not the employer, so it is never a domain hint (an apply
# link on carvana.com/careers is).
_ATS_HOSTS = {
    "myworkdaysite.com", "myworkday.com", "successfactors.com",
    "successfactors.eu", "sapsf.com", "sapsf.eu", "oraclecloud.com",
    "jobvite.com", "bamboohr.com", "workable.com", "recruitee.com",
    "breezy.hr", "applytojob.com", "jazzhr.com", "eightfold.ai",
    "phenompeople.com", "avature.net", "csod.com", "brassring.com",
    "ultipro.com", "dayforcehcm.com", "paylocity.com", "paycomonline.net",
    "adp.com", "rippling.com", "pinpointhq.com", "teamtailor.com",
    "personio.de", "personio.com", "gem.com", "dover.com", "comeet.com",
    "comeet.co", "zohorecruit.com", "freshteam.com", "hrmdirect.com",
    "applicantpro.com", "jobscore.com", "careers-page.com", "trinethire.com",
    "wellfound.com", "angel.co", "ycombinator.com", "workatastartup.com",
    "simplify.jobs", "builtin.com", "ziprecruiter.com", "monster.com",
    "careerbuilder.com", "joinhandshake.com", "notion.site", "github.io",
    "lnkd.in", "tinyurl.com", "governmentjobs.com", "usajobs.gov",
    "careerplug.com", "paycor.com", "recruitingbypaycor.com",
    "clearcompany.com", "applicantstack.com", "jobdiva.com", "ceipal.com",
    "bullhornstaffing.com", "hirebridge.com", "isolvedhire.com",
    "silkroad.com", "catsone.com", "homerun.co", "join.com", "manatal.com",
    "recruitcrm.io", "welcometothejungle.com", "otta.com", "ripplematch.com",
    "dice.com", "hired.com", "remoteok.com", "weworkremotely.com",
    "remotive.com",
}

# Curated map for companies whose display name does not map cleanly to a domain.
# Keys are lowercased, punctuation-stripped company names.
KNOWN_DOMAINS: dict[str, str] = {
    # Consulting / finance
    "pwc": "pwc.com", "pwc canada": "pwc.com",
    "deloitte": "deloitte.com", "deloitte canada": "deloitte.com",
    "kpmg": "kpmg.com", "ey": "ey.com", "ernst young": "ey.com",
    "accenture": "accenture.com", "accenture federal services": "afs.com",
    "mckinsey": "mckinsey.com", "mckinsey company": "mckinsey.com",
    "capgemini": "capgemini.com",
    "jp morgan": "jpmorgan.com", "jpmorgan": "jpmorgan.com",
    "jpmorgan chase": "jpmorgan.com", "goldman sachs": "goldmansachs.com",
    "two sigma": "twosigma.com", "de shaw": "deshaw.com",
    "jane street": "janestreet.com", "capital one": "capitalone.com",
    # Canadian banks
    "td bank": "td.com", "td": "td.com",
    "rbc": "rbc.com", "royal bank": "rbc.com", "royal bank of canada": "rbc.com",
    "cibc": "cibc.com", "bmo": "bmo.com", "bank of montreal": "bmo.com",
    "scotiabank": "scotiabank.com",
    "national bank": "nbc.ca", "national bank of canada": "nbc.ca",
    "manulife": "manulife.com", "sun life": "sunlife.com",
    "wealthsimple": "wealthsimple.com",
    # Big tech (name != domain)
    "meta": "meta.com", "facebook": "meta.com",
    "google": "google.com", "alphabet": "google.com",
    "amazon": "amazon.com", "aws": "amazon.com", "amazon web services": "amazon.com",
    "electronic arts": "ea.com", "electronic arts ea": "ea.com",
    "bytedance": "bytedance.com", "tiktok": "tiktok.com",
    "twitter": "x.com", "x": "x.com",
    "snap": "snap.com", "snapchat": "snap.com",
    "alphabet inc": "google.com",
    "hewlett packard enterprise": "hpe.com", "hpe": "hpe.com",
    "hp": "hp.com",
    # Data / infra
    "databricks": "databricks.com", "snowflake": "snowflake.com",
    "datadog": "datadoghq.com", "mongodb": "mongodb.com",
    "cockroachdb": "cockroachlabs.com", "cockroach labs": "cockroachlabs.com",
    "dbt labs": "getdbt.com", "elastic": "elastic.co",
    "confluent": "confluent.io", "neon": "neon.tech",
    "hashicorp": "hashicorp.com",
    # Canadian tech
    "shopify": "shopify.com", "kinaxis": "kinaxis.com", "ciena": "ciena.com",
    "ross video": "rossvideo.com", "trend micro": "trendmicro.com",
    "magnet forensics": "magnetforensics.com",
    "ribbon communications": "ribboncommunications.com",
    "assent compliance": "assentcompliance.com", "assent": "assentcompliance.com",
    "you.i tv": "youi.tv", "youi tv": "youi.tv",
    "cgi": "cgi.com", "blackberry": "blackberry.com", "mitel": "mitel.com",
    "coveo": "coveo.com", "clio": "clio.com", "fullscript": "fullscript.com",
    "solace": "solace.com", "calian": "calian.com",
    # Other notable
    "openai": "openai.com", "anthropic": "anthropic.com", "nvidia": "nvidia.com",
    "salesforce": "salesforce.com", "oracle": "oracle.com", "adobe": "adobe.com",
    "intuit": "intuit.com", "spotify": "spotify.com", "discord": "discord.com",
    "figma": "figma.com", "notion": "notion.so", "bloomberg": "bloomberg.com",
    "palantir": "palantir.com", "coinbase": "coinbase.com",
    "robinhood": "robinhood.com", "doordash": "doordash.com",
    "roblox": "roblox.com", "tesla": "tesla.com", "spacex": "spacex.com",
    "ericsson": "ericsson.com", "nokia": "nokia.com", "huawei": "huawei.com",
    "huawei canada": "huawei.com", "fortinet": "fortinet.com",
}

# Suffixes / filler words stripped when guessing a domain from a company name.
_NAME_NOISE = re.compile(
    r"\b("
    r"inc|incorporated|llc|ltd|limited|corp|corporation|co|company|"
    r"group|holdings|technologies|technology|tech|solutions|solution|"
    r"systems|labs|laboratories|services|service|software|the|and|of"
    r")\b",
    re.IGNORECASE,
)


def _normalize_name(name: str) -> str:
    """Lowercase + strip punctuation for use as a KNOWN_DOMAINS key."""
    cleaned = re.sub(r"[^a-z0-9\s]", " ", (name or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def domain_from_url(url: Optional[str]) -> Optional[str]:
    """Return the registrable domain for a company website URL.

    Returns None for empty input, non-http(s) URLs, or known non-company hosts
    (job boards, ATS, social, link shorteners).
    """
    if not url:
        return None

    raw = url.strip()
    if not raw:
        return None
    # urlparse needs a scheme to populate netloc; add one if missing.
    if "://" not in raw:
        raw = "http://" + raw

    try:
        parsed = urlparse(raw)
    except ValueError:
        return None

    if parsed.scheme not in ("http", "https"):
        return None

    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return None
    if host.startswith("www."):
        host = host[4:]

    registrable = _registrable_domain(host)

    # Reject job boards / ATS / social hosts, not real company sites.
    if registrable in _NON_COMPANY_HOSTS or host in _NON_COMPANY_HOSTS:
        return None
    if registrable in _ATS_HOSTS:
        return None

    return registrable


def domain_from_logo_url(logo_url: Optional[str]) -> Optional[str]:
    """The company domain a favicon-service URL was built for.

    Registry entries store ``https://www.google.com/s2/favicons?domain=notion.so``;
    the ``domain=`` value is a curated, correct domain (toasttab.com for Toast,
    notion.so for Notion) that the name guess gets wrong. None for any other URL.
    """
    if not logo_url or "domain=" not in logo_url:
        return None
    try:
        query = urlparse(logo_url.strip()).query
    except ValueError:
        return None
    values = parse_qs(query).get("domain") or []
    if not values:
        return None
    candidate = values[0].strip().lower()
    if not _DOMAIN_SHAPE.match(candidate):
        return None
    return domain_from_url(candidate)


def company_website_url(url: Optional[str]) -> str:
    """``url`` when it is an http(s) link to a real company website, else "".

    Scraper payloads carry employer links of mixed quality (LinkedIn company
    pages, ATS boards, bare hosts); only a real employer site is worth storing
    as company_url, and only http(s) is safe to render as a link.
    """
    raw = (url or "").strip()
    if not raw.lower().startswith(("https://", "http://")) or len(raw) > 500:
        return ""
    return raw if domain_from_url(raw) else ""


def _registrable_domain(host: str) -> str:
    """Reduce a hostname to its registrable domain, honoring multi-part TLDs."""
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    last_two = ".".join(parts[-2:])
    last_three = ".".join(parts[-3:])
    if last_two in _MULTI_PART_TLDS:
        return last_three
    return last_two


def curated_domain(company: Optional[str]) -> Optional[str]:
    """The KNOWN_DOMAINS entry for a company name, or None. Curated, so it
    outranks evidence like an apply link on a careers-only domain
    (lifeattiktok.com, amazon.jobs)."""
    return KNOWN_DOMAINS.get(_normalize_name(company or "")) or None


def domain_from_name(company: Optional[str]) -> Optional[str]:
    """Best-effort domain guess from a company name.

    Checks the curated KNOWN_DOMAINS map first, then strips corporate
    filler words and concatenates the remaining tokens with a .com suffix.
    Returns None if nothing usable remains.
    """
    if not company:
        return None

    normalized = _normalize_name(company)
    if not normalized:
        return None

    if normalized in KNOWN_DOMAINS:
        return KNOWN_DOMAINS[normalized]

    # Strip filler words, then collapse to a bare token.
    stripped = _NAME_NOISE.sub(" ", normalized)
    token = re.sub(r"[^a-z0-9]", "", stripped)
    if len(token) < 2:
        # Filler-stripping removed everything (e.g. name was just "Tech").
        token = re.sub(r"[^a-z0-9]", "", normalized)
    if len(token) < 2:
        return None

    return f"{token}.com"


def resolve_domain(
    company: Optional[str],
    company_url: Optional[str] = None,
    *,
    known_domain: Optional[str] = None,
    apply_url: Optional[str] = None,
) -> Optional[str]:
    """Resolve the best company domain.

    Priority: a domain the caller already trusts (the curated registry) >
    a real company website URL > curated known map > an employer-hosted
    apply link > name guess.
    """
    return (
        (known_domain or "").strip().lower()
        or domain_from_url(company_url)
        or curated_domain(company)
        or domain_from_url(apply_url)
        or domain_from_name(company)
    )


def logo_url_for_domain(domain: Optional[str]) -> str:
    """Build a logo image URL for a resolved domain ("" if no domain)."""
    if not domain:
        return ""
    return _LOGO_TEMPLATE.format(domain=domain)


def resolve_logo(
    company: Optional[str],
    company_url: Optional[str] = None,
    *,
    known_domain: Optional[str] = None,
    apply_url: Optional[str] = None,
) -> tuple[str, str]:
    """Resolve (logo_url, domain) for a company.

    Both elements are "" when nothing could be resolved, letting callers fall
    back to a letter avatar instead of rendering a broken image.
    """
    domain = resolve_domain(
        company, company_url, known_domain=known_domain, apply_url=apply_url
    )
    return logo_url_for_domain(domain), (domain or "")
