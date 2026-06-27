"""
LogoResolver — turns a company name and/or website URL into an accurate,
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
has nothing — but we also expose the resolved domain so the frontend can render
a deterministic letter-avatar fallback and never show a broken <img>.

These are pure functions with no I/O so they are cheap and unit-testable.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

# Logo image provider. Google's favicon service is reliable and CORS-friendly.
# sz=128 gives a crisp logo for card + detail views.
_LOGO_TEMPLATE = "https://www.google.com/s2/favicons?domain={domain}&sz=128"

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

    # Reject job boards / ATS / social hosts — not real company sites.
    if registrable in _NON_COMPANY_HOSTS or host in _NON_COMPANY_HOSTS:
        return None

    return registrable


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


def resolve_domain(company: Optional[str], company_url: Optional[str] = None) -> Optional[str]:
    """Resolve the best company domain.

    Priority: a real company website URL > curated known map / name guess.
    """
    return domain_from_url(company_url) or domain_from_name(company)


def logo_url_for_domain(domain: Optional[str]) -> str:
    """Build a logo image URL for a resolved domain ("" if no domain)."""
    if not domain:
        return ""
    return _LOGO_TEMPLATE.format(domain=domain)


def resolve_logo(company: Optional[str], company_url: Optional[str] = None) -> tuple[str, str]:
    """Resolve (logo_url, domain) for a company.

    Both elements are "" when nothing could be resolved, letting callers fall
    back to a letter avatar instead of rendering a broken image.
    """
    domain = resolve_domain(company, company_url)
    return logo_url_for_domain(domain), (domain or "")
