"""
Server-side logo harvesting for companies whose stored logo is missing, a
tiny favicon, a banner or someone else's icon.

harvest_company_logo() tries sources identity-keyed first and returns the
first candidate that survives logo_image.normalize_logo(), already
downloaded and normalized, so the caller self-hosts the bytes instead of
hotlinking a third party. Order and hit rates (prod, 250 no-logo companies):

0. logos already stored on other rows of the same company (licdn, Indeed
   squarelogo): half of the no-logo rows had one on a sibling row; the
   caller may add rows of the company's longer name ('Magna International'
   for 'Magna') after them;
1. LinkedIn's public job endpoint for one of the company's LinkedIn jobs
   (89%): accepted only when the posting's org name is the company;
2. LinkedIn's public job search, exact normalized company-name match (33%),
   else the company's longer name ('Magna' -> 'Magna International', see
   ALIAS_SUFFIXES) when only one employer answers to it;
3. the ATS board's own logo (Ashby, Workday, Lever, Greenhouse,
   SmartRecruiters, BambooHR, Workable), authoritative but often a wordmark;
4. homepage icons, ONLY on a domain verify_domain() accepted: most stored
   company_domain values are name guesses that are NXDOMAIN, parked, or
   another company's site;
5. Wikidata P154, only when the entity's official website (P856) is a
   verified domain, or with no verified domain when its label is exactly
   the company name (or its one unambiguous longer name);
6. google s2 at 256px on a verified domain (normalize_logo rejects the
   globe/GoDaddy placeholders and tiny favicons).

Nothing here raises: every HTTP call carries its own timeout, a harvest has
a per-company time cap, and a miss is None.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import logging
import re
import time
import weakref
from dataclasses import dataclass, field
from typing import NamedTuple
from urllib.parse import parse_qs, quote, unquote, unquote_to_bytes, urljoin, urlparse

import httpx

from backend.services.logo_image import NormalizedLogo, image_size, normalize_logo
from backend.services.logo_resolver import _registrable_domain

logger = logging.getLogger(__name__)

MIN_WIDTH = 64
HARVEST_TIME_CAP = 30.0       # seconds per company, whole cascade
LINKEDIN_MIN_INTERVAL = 1.2   # seconds between LinkedIn calls on one client
_MAX_IMAGE_BYTES = 2_000_000
_MAX_PAGE_BYTES = 900_000     # Lever's header logo sits ~700KB into the page
_MAX_HOME_BYTES = 600_000
_MAX_JSON_BYTES = 300_000
_MAX_HOMEPAGE_TRIES = 6
_MAX_EXISTING = 6             # the company's own seeds, then its longer name's
_DNS_TIMEOUT = 4.0
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_HARVEST_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_IMAGE_HEADERS = {
    "User-Agent": _UA,
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}
_JSON_HEADERS = {"User-Agent": _UA, "Accept": "application/json"}

# Wikimedia 403s spoofed browser UAs from script traffic and requires a
# descriptive one (api.wikimedia.org/wiki/Special:MyLanguage/User-Agent_policy).
# Corporate homepages want the opposite, keep both header sets.
_WIKIMEDIA_HEADERS = {
    "User-Agent": "TailrdJobBoard/1.0 (https://www.tailrd.ca; logo resolution)",
}
_WIKIMEDIA_HOSTS = ("wikimedia.org", "wikipedia.org", "wikidata.org")

# Never fetched or stored (project rule), whatever the caller passes in.
_BANNED_HOSTS = ("icon.horse", "clearbit.com")
# Logo services that render a guess from a domain, not the company's own art.
_GENERATED_LOGO_MARKERS = (
    "google.com/s2/favicons", "gstatic.com/favicon", "icon.horse", "clearbit.com",
    "apistemic", "unavatar.io", "logo.dev", "duckduckgo.com/ip3",
)


@dataclass
class LogoHints:
    company: str
    domains: list[str] = field(default_factory=list)
    job_urls: list[str] = field(default_factory=list)
    existing_logo_urls: list[str] = field(default_factory=list)


@dataclass
class HarvestResult:
    logo: NormalizedLogo
    source: str        # existing | linkedin_job | linkedin_search | ats_<name> | homepage | wikidata | s2
    source_url: str
    verified_domain: str | None = None


class _Page(NamedTuple):
    status: int
    url: str      # final URL after redirects
    text: str     # body (only read on 200)


# --- company names --------------------------------------------------------

_ATS_NAME_TAG = re.compile(
    r"\s*\((?:ashby|greenhouse|lever|workday|smartrecruiters|workable|bamboohr)\)\s*$",
    re.IGNORECASE,
)
# Trailing legal-entity suffixes. 'Company' is NOT one: 'The Bell Company'
# is a different employer from 'Bell'.
_LEGAL_SUFFIXES = {
    "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co",
    "plc", "gmbh", "ag", "sa", "lp", "llp",
}
# Words too generic to prove a domain or page belongs to the company.
_TOKEN_STOPWORDS = _LEGAL_SUFFIXES | {
    "the", "and", "of", "for", "company", "group", "holdings", "technologies",
    "technology", "tech", "solutions", "systems", "services", "labs",
    "international", "global", "canada", "usa", "us", "america",
    "de", "la", "le", "les", "et", "du",
}


def clean_company_name(name: str | None) -> str:
    """Display name without markdown emphasis, HTML escapes or registry ATS
    tags ('**Tesla**' -> 'Tesla', 'Notion (Ashby)' -> 'Notion')."""
    n = html.unescape(name or "").replace("*", " ").replace("`", " ")
    n = _ATS_NAME_TAG.sub("", n.strip().strip("_"))
    return re.sub(r"\s+", " ", n).strip()


def name_key(name: str | None) -> str:
    """Comparison key: lowercase alphanumerics without a leading 'the' or
    trailing legal suffixes, so 'AT&amp;T Inc.' and 'AT&T' compare equal."""
    n = clean_company_name(name).lower().replace("&", " and ")
    words = [t for t in re.split(r"[^a-z0-9]+", n) if t]
    if len(words) > 1 and words[0] == "the":
        words = words[1:]
    while len(words) > 1 and words[-1] in _LEGAL_SUFFIXES:
        words.pop()
    return "".join(words)


# Generic corporate words an employer's longer name adds to its short one:
# 'Magna' is 'Magna International', 'BMO' is 'BMO Financial Group', 'Bell' is
# 'Bell Canada'. A closed list on purpose: 'Bell Flight' (flight), 'Bell
# Industries' and 'The Bell Company' are other employers. 'Technologies' is
# the one sector word in it: LinkedIn only knows 'Palantir Technologies'
# (89 prod rows as plain 'Palantir'). Shared with logo_cache's cross-name
# seeding.
ALIAS_SUFFIXES = frozenset({
    "international", "intl", "group", "financial", "corporation", "corp",
    "incorporated", "inc", "limited", "ltd", "llc", "plc", "holdings", "holding",
    "global", "worldwide", "canada", "usa", "us", "america", "americas",
    "technologies",
})
_MAX_ALIAS_WORDS = 2
# Wikidata searches tried when the plain name finds nothing ('Bell' ->
# 'Bell Canada'); every hit still has to be a suffix variant.
_ALIAS_QUERY_SUFFIXES = ("International", "Group", "Canada", "Holdings")


def name_words(name: str | None) -> list[str]:
    """Lowercase alphanumeric words of a company name without trailing legal
    suffixes. Unlike name_key a leading 'the' is kept: 'The Bell Company' is
    not a longer name for 'Bell'."""
    n = clean_company_name(name).lower().replace("&", " and ")
    words = [t for t in re.split(r"[^a-z0-9]+", n) if t]
    while len(words) > 1 and words[-1] in _LEGAL_SUFFIXES:
        words.pop()
    return words


def is_suffix_variant_words(longer: list[str], base: list[str]) -> bool:
    """True when `longer` is `base` plus one or two ALIAS_SUFFIXES words, and
    `base` itself says more than a generic word."""
    extra = len(longer) - len(base)
    return (
        bool(base)
        and 1 <= extra <= _MAX_ALIAS_WORDS
        and longer[:len(base)] == base
        and all(w in ALIAS_SUFFIXES for w in longer[len(base):])
        and any(w not in ALIAS_SUFFIXES and w != "the" for w in base)
    )


def is_suffix_variant(longer: str | None, company: str | None) -> bool:
    """'Magna International' / 'BMO Financial Group' / 'Bell Canada' for
    'Magna' / 'BMO' / 'Bell'; never 'Bell Flight' or 'The Bell Company'."""
    return is_suffix_variant_words(name_words(longer), name_words(company))


def _company_tokens(name: str | None) -> list[str]:
    words = [t for t in re.split(r"[^a-z0-9]+", clean_company_name(name).lower()) if t]
    tokens = [t for t in words if t not in _TOKEN_STOPWORDS and len(t) >= 3]
    return tokens or [t for t in words if t not in _LEGAL_SUFFIXES and len(t) >= 2]


def _dedupe(items) -> list:
    seen: set = set()
    return [x for x in items if x and not (x in seen or seen.add(x))]


# --- HTTP -----------------------------------------------------------------

def _headers_for(url: str) -> dict:
    host = (urlparse(url).hostname or "").lower()
    return _WIKIMEDIA_HEADERS if host.endswith(_WIKIMEDIA_HOSTS) else _IMAGE_HEADERS


def _is_banned(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == b or host.endswith("." + b) for b in _BANNED_HOSTS)


def _decode_data_uri(uri: str) -> tuple[bytes, str] | None:
    m = re.match(r"data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)", uri, re.DOTALL)
    if not m:
        return None
    try:
        data = base64.b64decode(m.group(4)) if m.group(3) else unquote_to_bytes(m.group(4))
    except Exception:
        return None
    return (data, m.group(1)) if len(data) <= _MAX_IMAGE_BYTES else None


async def _download(
    client: httpx.AsyncClient, url: str, headers: dict | None = None
) -> tuple[bytes, str] | None:
    """(bytes, content-type) of an image candidate, None on any failure or
    when the body exceeds _MAX_IMAGE_BYTES (read streamed, never buffered)."""
    if url.startswith("data:"):
        return _decode_data_uri(url)
    if not url.startswith(("https://", "http://")) or _is_banned(url):
        return None
    try:
        async with client.stream(
            "GET", url, headers=headers or _headers_for(url),
            timeout=_TIMEOUT, follow_redirects=True,
        ) as resp:
            if resp.status_code != 200:
                return None
            if int(resp.headers.get("content-length") or 0) > _MAX_IMAGE_BYTES:
                return None
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body += chunk
                if len(body) > _MAX_IMAGE_BYTES:
                    return None
            return bytes(body), resp.headers.get("content-type", "")
    except Exception:
        return None


async def _fetch_page(
    client: httpx.AsyncClient,
    url: str,
    headers: dict | None = None,
    max_bytes: int = _MAX_PAGE_BYTES,
    params: dict | None = None,
) -> _Page | None:
    """Status, final URL and (on 200) the first max_bytes of a page."""
    try:
        async with client.stream(
            "GET", url, params=params, headers=headers or _HARVEST_HEADERS,
            timeout=_TIMEOUT, follow_redirects=True,
        ) as resp:
            body = bytearray()
            if resp.status_code == 200:
                async for chunk in resp.aiter_bytes():
                    body += chunk
                    if len(body) >= max_bytes:
                        break
            try:
                text = bytes(body).decode(resp.charset_encoding or "utf-8", errors="replace")
            except LookupError:
                text = bytes(body).decode("utf-8", errors="replace")
            return _Page(resp.status_code, str(resp.url), text)
    except Exception:
        return None


async def _fetch_json(
    client: httpx.AsyncClient, url: str, params: dict | None = None,
    max_bytes: int = _MAX_JSON_BYTES,
):
    headers = _WIKIMEDIA_HEADERS if "wikidata.org" in url else _JSON_HEADERS
    page = await _fetch_page(client, url, headers, max_bytes, params)
    if page is None or page.status != 200:
        return None
    try:
        return json.loads(page.text)
    except ValueError:
        return None


async def _try_logo(
    client: httpx.AsyncClient, url: str, *, allow_wide: bool = False
) -> NormalizedLogo | None:
    got = await _download(client, url)
    return normalize_logo(got[0], got[1], allow_wide=allow_wide) if got else None


# What a 429/999 does to the rest of a client's run. None (the cron): LinkedIn
# is skipped for the rest of the run. Seconds (the one-time backfill, where a
# skipped LinkedIn step means a worse logo stored for good): LinkedIn pauses
# that long, doubling on each block in a row, and queued calls wait instead of
# falling through; after _LINKEDIN_MAX_BLOCKS blocks in a row it is skipped.
LINKEDIN_BLOCK_COOLDOWN: float | None = None
_LINKEDIN_MAX_BLOCKS = 4
_LINKEDIN_MAX_COOLDOWN = 600.0


class _LinkedInGate:
    """Paces one client's LinkedIn calls and remembers rate-limit hits."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.last = 0.0
        self.blocked = False
        self.blocked_at: float | None = None  # time.monotonic() when given up on
        self.in_a_row = 0
        self.blocks = 0
        self.calls = 0


# Keyed by client so a 429 only affects the rest of that run.
_linkedin_gates: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def linkedin_stats(client: httpx.AsyncClient) -> dict:
    """LinkedIn calls made, rate-limit blocks hit, and whether LinkedIn was
    given up on, for one client's run (the backfill report)."""
    gate = _linkedin_gates.get(client)
    if gate is None:
        return {"calls": 0, "blocks": 0, "blocked": False, "blocked_at": None}
    return {"calls": gate.calls, "blocks": gate.blocks, "blocked": gate.blocked,
            "blocked_at": gate.blocked_at}


async def _linkedin_get(
    client: httpx.AsyncClient, url: str, params: dict | None = None
) -> httpx.Response | None:
    gate = _linkedin_gates.get(client)
    if gate is None:
        gate = _linkedin_gates[client] = _LinkedInGate()
    if gate.blocked:
        return None
    async with gate.lock:
        while not gate.blocked:
            wait = gate.last + LINKEDIN_MIN_INTERVAL - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                resp = await client.get(
                    url, params=params, headers=_HARVEST_HEADERS,
                    timeout=_TIMEOUT, follow_redirects=True,
                )
            except Exception:
                resp = None
            gate.last = time.monotonic()
            gate.calls += 1
            if resp is None or resp.status_code not in (429, 999):
                gate.in_a_row = 0
                return resp
            gate.blocks += 1
            gate.in_a_row += 1
            cooldown = LINKEDIN_BLOCK_COOLDOWN
            if not cooldown or gate.in_a_row > _LINKEDIN_MAX_BLOCKS:
                gate.blocked = True
                gate.blocked_at = time.monotonic()
                logger.info("logo harvest: LinkedIn rate-limited (%s), skipping it for this run",
                            resp.status_code)
                break
            pause = min(cooldown * 2 ** (gate.in_a_row - 1), _LINKEDIN_MAX_COOLDOWN)
            logger.info("logo harvest: LinkedIn rate-limited (%s), pausing %.0fs",
                        resp.status_code, pause)
            # The lock stays held: every queued LinkedIn call waits this out.
            await asyncio.sleep(pause)
    return None


async def _resolves(host: str) -> bool:
    """DNS lookup off the event loop's thread pool, bounded."""
    loop = asyncio.get_running_loop()
    try:
        await asyncio.wait_for(loop.getaddrinfo(host, 443), _DNS_TIMEOUT)
        return True
    except Exception:
        return False


# --- 0. logos already on other rows -----------------------------------------

async def _from_existing(client: httpx.AsyncClient, urls: list[str]) -> HarvestResult | None:
    for url in _dedupe(urls)[:_MAX_EXISTING]:
        if any(marker in url for marker in _GENERATED_LOGO_MARKERS):
            continue
        logo = await _try_logo(client, url)
        if logo:
            return HarvestResult(logo, "existing", url)
    return None


# --- 1-2. LinkedIn public endpoints ---------------------------------------

_LINKEDIN_JOB_ID = re.compile(r"linkedin\.com/jobs/view/(?:[^/?#]*?-)?(\d{6,})(?=[/?#]|$)")
_LI_ORG_NAME = re.compile(r"topcard__org-name-link[^>]*>\s*([^<]+?)\s*<")
_LICDN_LOGO = re.compile(r'https://media\.licdn\.com/dms/image/[^"\s]*company-logo[^"\s]*')
_LI_SUBTITLE = re.compile(r"base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>\s*)?([^<]+?)\s*<")
_LI_CARD_LOGO = re.compile(r'data-delayed-url="(https://media\.licdn\.com/[^"]*company-logo[^"]*)"')
_LI_COMPANY_PAGE = re.compile(
    r'base-search-card__subtitle[^>]*>\s*<a[^>]*href="https://[a-z]{2,3}\.linkedin\.com/company/([^"?/]+)'
)


def _linkedin_job_ids(job_urls: list[str]) -> list[str]:
    ids = []
    for url in job_urls:
        m = _LINKEDIN_JOB_ID.search(url or "")
        if m:
            ids.append(m.group(1))
    return _dedupe(ids)


async def _linkedin_job_logo(
    client: httpx.AsyncClient, job_id: str, company: str
) -> tuple[NormalizedLogo, str] | None:
    """The posting company's logo from the guest jobPosting endpoint (a 30KB
    fragment, not the 330KB /jobs/view page). The top card names the org;
    the first company-logo after it is that org's, the rest of the page is
    similar-jobs noise."""
    resp = await _linkedin_get(
        client, f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
    )
    if resp is None or resp.status_code != 200:
        return None
    text = resp.text
    org = _LI_ORG_NAME.search(text)
    if not org or name_key(html.unescape(org.group(1))) != name_key(company):
        return None
    m = _LICDN_LOGO.search(text, max(text.find("topcard"), 0))
    if not m:
        return None
    url = html.unescape(m.group(0))
    logo = await _try_logo(client, url)
    return (logo, url) if logo else None


async def _linkedin_search_logo(
    client: httpx.AsyncClient, company: str
) -> tuple[NormalizedLogo, str] | None:
    resp = await _linkedin_get(
        client,
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
        params={"keywords": company, "start": 0},
    )
    if resp is None or resp.status_code != 200:
        return None
    key = name_key(company)
    # (company page, card name key, logo url): exact names first; failing
    # that, the company's longer name ('Magna' -> 'Magna International').
    exact: list[tuple[str, str, str]] = []
    longer: list[tuple[str, str, str]] = []
    for card in resp.text.split("<li")[1:]:
        sub = _LI_SUBTITLE.search(card)
        logo_m = _LI_CARD_LOGO.search(card)
        if not (sub and logo_m):
            continue
        card_name = html.unescape(sub.group(1))
        page = _LI_COMPANY_PAGE.search(card)
        entry = (page.group(1) if page else "", name_key(card_name), html.unescape(logo_m.group(1)))
        if entry[1] == key:
            exact.append(entry)
        elif is_suffix_variant(card_name, company):
            longer.append(entry)
    matches = exact or longer
    # Two different employers answering to the name ('Bell' pages for two
    # companies, or 'Magna International' and 'Magna Global'): neither is safe.
    if len({page for page, _, _ in matches if page}) > 1:
        return None
    if len({name for _, name, _ in matches}) > 1:
        return None
    for url in _dedupe(url for _, _, url in matches)[:2]:
        logo = await _try_logo(client, url)
        if logo:
            return logo, url
    return None


# --- 3. ATS board logos -----------------------------------------------------

_ASHBY_LOGO = re.compile(r"https://app\.ashbyhq\.com/api/images/org-theme-logo/[^\"'\\\s<>]+")
_ASHBY_WORDMARK = re.compile(r"https://app\.ashbyhq\.com/api/images/org-theme-wordmark/[^\"'\\\s<>]+")
_ASHBY_WEBSITE = re.compile(r'"publicWebsite"\s*:\s*"([^"]+)"')
_LEVER_HEADER_LOGO = re.compile(
    r'main-header-logo[^>]*>\s*(?:<a[^>]*>\s*)?<img[^>]+src="([^"]+)"', re.IGNORECASE
)
_GREENHOUSE_LOGO = re.compile(
    r"https://[a-z0-9.-]*greenhouse\.io/external_greenhouse_job_boards/logos/[^\"'\s<>]+"
)
_SR_LOGO = re.compile(r"https://c\.smartrecruiters\.com/sr-company-logo[^\"'\s<>]+")
_SR_WEBSITE = re.compile(r'header-logo[^>]*>\s*<a[^>]+href="(https?://[^"]+)"')
_WORKABLE_SLUG = re.compile(r"(?:^|[/.])workable\.com/([A-Za-z0-9_-]+)")
_LOCALE_SEGMENT = re.compile(r"^[a-z]{2}-[A-Za-z]{2}$")


def _ats_boards(job_urls: list[str]) -> list[tuple[str, tuple]]:
    """(ats, board key) for each distinct board the company's job URLs use."""
    boards = []
    for url in job_urls:
        url = (url or "").strip()
        p = urlparse(url)
        host = (p.hostname or "").lower()
        segs = [unquote(s) for s in p.path.split("/") if s]
        if host == "jobs.ashbyhq.com" and segs:
            boards.append(("ashby", (segs[0],)))
        elif host.endswith(".myworkdayjobs.com"):
            if segs and _LOCALE_SEGMENT.match(segs[0]):
                segs = segs[1:]
            if segs:
                boards.append(("workday", (f"https://{host}/{segs[0]}",)))
        elif host.endswith("lever.co") and segs:
            boards.append(("lever", (segs[0],)))
        elif host.endswith("greenhouse.io"):
            token = parse_qs(p.query).get("for", [""])[0] or (
                segs[0] if segs and segs[0] != "embed" else ""
            )
            if token:
                boards.append(("greenhouse", (token,)))
        elif host.endswith("smartrecruiters.com") and len(segs) >= 2:
            m = re.match(r"\d{6,}", segs[1])
            if m:
                boards.append(("smartrecruiters", (segs[0], m.group(0))))
        elif host.endswith(".bamboohr.com"):
            boards.append(("bamboohr", (host.split(".")[0],)))
        elif "workable.com" in url:
            m = _WORKABLE_SLUG.search(url)
            slug = m.group(1) if m and m.group(1) not in ("api", "j") else ""
            if not slug and host.endswith(".workable.com") and host.split(".")[0] not in ("apply", "www"):
                slug = host.split(".")[0]
            if slug:
                boards.append(("workable", (slug,)))
    return _dedupe(boards)


def _website_domain(url: str | None) -> str:
    if not url:
        return ""
    host = (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()
    return _registrable_domain(host.removeprefix("www.")) if "." in host else ""


def _meta_content(text: str, prop: str) -> str:
    for tag in re.findall(r"<meta\b[^>]*>", text, re.IGNORECASE):
        if re.search(r'(?:property|name)\s*=\s*["\']' + re.escape(prop) + r'["\']', tag, re.IGNORECASE):
            content = _attr(tag, "content")
            if content:
                return content
    return ""


async def _board_logo(
    client: httpx.AsyncClient, ats: str, key: tuple, discovered: list[str]
) -> tuple[NormalizedLogo, str] | None:
    """One ATS board's logo. Company websites the board lists are appended
    to `discovered` for the verified-domain sources further down."""
    candidates: list[tuple[str, bool]] = []  # (url, allow_wide)
    if ats == "ashby":
        page = await _fetch_page(client, f"https://jobs.ashbyhq.com/{quote(key[0])}")
        if page is None or page.status != 200:
            return None
        for rx in (_ASHBY_LOGO, _ASHBY_WORDMARK):
            m = rx.search(page.text)
            if m:
                candidates.append((m.group(0), True))
        site = _ASHBY_WEBSITE.search(page.text)
        discovered.append(_website_domain(site.group(1)) if site else "")
    elif ats == "workday":
        candidates.append((key[0] + "/assets/logo", True))
    elif ats == "lever":
        page = await _fetch_page(client, f"https://jobs.lever.co/{quote(key[0])}")
        if page is None or page.status != 200:
            return None
        m = _LEVER_HEADER_LOGO.search(page.text)
        if m:
            candidates.append((html.unescape(m.group(1)), True))
        og = _meta_content(page.text, "og:image")
        if og:
            # Lever's og:image is often a custom "Open Roles" banner: no allow_wide.
            candidates.append((html.unescape(og), False))
    elif ats == "greenhouse":
        page = await _fetch_page(
            client, "https://boards.greenhouse.io/embed/job_board", params={"for": key[0]}
        )
        if page is None or page.status != 200:
            return None
        m = _GREENHOUSE_LOGO.search(page.text)
        if m:
            candidates.append((html.unescape(m.group(0)), True))
    elif ats == "smartrecruiters":
        # careers.smartrecruiters.com 302s to the employer's careers home;
        # the jobs. host serves the real posting page with the logo.
        page = await _fetch_page(
            client, f"https://jobs.smartrecruiters.com/{quote(key[0])}/{key[1]}"
        )
        if page is None or page.status != 200:
            return None
        m = _SR_LOGO.search(page.text)
        if m:
            candidates.append((html.unescape(m.group(0)), True))
        site = _SR_WEBSITE.search(page.text)
        discovered.append(_website_domain(html.unescape(site.group(1))) if site else "")
    elif ats == "bamboohr":
        data = await _fetch_json(client, f"https://{key[0]}.bamboohr.com/careers/company-info")
        logo_url = ((data or {}).get("result") or {}).get("logoUrl") if isinstance(data, dict) else None
        if isinstance(logo_url, str) and logo_url:
            candidates.append((logo_url, True))
    elif ats == "workable":
        data = await _fetch_json(client, f"https://apply.workable.com/api/v1/accounts/{quote(key[0])}")
        if isinstance(data, dict):
            if isinstance(data.get("logo"), str) and data["logo"]:
                candidates.append((data["logo"], True))
            discovered.append(_website_domain(data.get("url") if isinstance(data.get("url"), str) else ""))
    for url, allow_wide in candidates:
        logo = await _try_logo(client, url, allow_wide=allow_wide)
        if logo:
            return logo, url
    return None


async def _from_ats(
    client: httpx.AsyncClient, job_urls: list[str], discovered: list[str]
) -> HarvestResult | None:
    for ats, key in _ats_boards(job_urls)[:3]:
        hit = await _board_logo(client, ats, key, discovered)
        if hit:
            return HarvestResult(hit[0], f"ats_{ats}", hit[1])
    return None


# --- domain verification ----------------------------------------------------

_DOMAIN_SYNTAX = re.compile(
    r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
_PARKED = re.compile(
    r"window\.location\.href\s*=\s*[\"']/lander|spaceship-cdn|hugedomains|aftermarket\.com"
    r"|sedo\.com|sedoparking|afternic|(?<![a-z0-9-])dan\.com|parkingcrew|bodis\.com"
    r"|domain (?:name )?(?:is|may be) for sale|buy this domain",
    re.IGNORECASE,
)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


class _VerifiedSite(NamedTuple):
    domain: str
    page: _Page | None   # the homepage when it returned 200


def _clean_domain(domain: str | None) -> str:
    d = (domain or "").strip().lower()
    if "://" in d:
        d = urlparse(d).hostname or ""
    d = d.split("/")[0].split("?")[0].rstrip(".")
    return d.removeprefix("www.")


def _label_has_token(registrable: str, tokens: list[str]) -> bool:
    label = registrable.split(".")[0]
    return any(t in label for t in tokens)


def _page_names_company(text: str, tokens: list[str]) -> bool:
    m = _TITLE.search(text[:300_000])
    names = " ".join([m.group(1) if m else "", _meta_content(text[:300_000], "og:site_name")])
    names = html.unescape(names).lower()
    return any(re.search(r"(?<![a-z0-9])" + re.escape(t), names) for t in tokens)


async def _verify(
    client: httpx.AsyncClient, domain: str, company: str
) -> _VerifiedSite | None:
    d = _clean_domain(domain)
    if not _DOMAIN_SYNTAX.match(d):
        return None
    if not (await _resolves(d) or await _resolves("www." + d)):
        return None
    page: _Page | None = None
    for url in (f"https://{d}/", f"https://www.{d}/"):
        got = await _fetch_page(client, url, max_bytes=_MAX_HOME_BYTES)
        if got is not None and (page is None or got.status == 200):
            page = got
        if page is not None and page.status == 200:
            break
    if page is None:
        return None  # resolves, but no web server answers
    final = _registrable_domain((urlparse(page.url).hostname or "").lower().removeprefix("www."))
    tokens = _company_tokens(company)
    if final != _registrable_domain(d) and not (tokens and _label_has_token(final, tokens)):
        return None  # redirected to an unrelated company (toast.com -> nhncloud.com)
    if urlparse(page.url).path.rstrip("/") == "/lander" or _PARKED.search(page.url):
        return None
    if page.status == 200 and _PARKED.search(page.text[:100_000]):
        return None
    if tokens:
        named = page.status == 200 and _page_names_company(page.text, tokens)
        if not (named or _label_has_token(final, tokens)):
            return None
    return _VerifiedSite(final, page if page.status == 200 else None)


async def verify_domain(client: httpx.AsyncClient, domain: str, company: str) -> str | None:
    """The registrable domain `domain` really serves for `company`, or None.

    Rejects bad syntax, NXDOMAIN, hosts with no web server, redirects to a
    different registrable domain that does not carry a company token,
    parked/for-sale pages, and sites whose title/og:site_name and domain
    label both lack every company token. A plausible redirect (notion.com ->
    notion.so) returns the final domain."""
    try:
        site = await _verify(client, domain, company)
    except Exception:
        return None
    return site.domain if site else None


# --- 4. homepage icons ----------------------------------------------------

def _attr(tag: str, name: str) -> str | None:
    m = re.search(
        r"\b" + name + r"\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", tag, re.IGNORECASE
    )
    if not m:
        return None
    return html.unescape(next(g for g in m.groups() if g is not None))


def _size_of(sizes: str | None) -> int:
    best = 0
    for m in re.finditer(r"(\d+)x\d+", (sizes or "").lower()):
        best = max(best, int(m.group(1)))
    return best


def _homepage_candidates(text: str, base_url: str) -> list[tuple[str, str]]:
    """What a homepage declares, best-first, as (kind, url): kind 'icon',
    'manifest' (a web manifest whose icons are fetched lazily), or 'og'
    (square-only: og:image is usually a 1200x630 share banner)."""
    touch: list[tuple[int, str]] = []
    sized: list[tuple[int, str]] = []
    manifests: list[str] = []
    svg: list[str] = []
    unsized: list[str] = []
    for tag in re.findall(r"<link\b[^>]*>", text[:300_000], re.IGNORECASE):
        rel = (_attr(tag, "rel") or "").lower()
        href = _attr(tag, "href")
        if not href:
            continue
        url = urljoin(base_url, href.strip())
        if rel == "manifest":
            manifests.append(url)
        elif "mask-icon" in rel:
            continue  # Safari pinned-tab silhouette
        elif "apple-touch-icon" in rel:
            touch.append((_size_of(_attr(tag, "sizes")) or 180, url))
        elif "icon" in rel.split():
            if "svg" in (_attr(tag, "type") or "").lower() or url.lower().split("?")[0].endswith(".svg"):
                svg.append(url)
            elif _size_of(_attr(tag, "sizes")) >= MIN_WIDTH:
                sized.append((_size_of(_attr(tag, "sizes")), url))
            else:
                unsized.append(url)
    ordered = [("icon", u) for _, u in sorted(touch, reverse=True)]
    ordered += [("icon", u) for _, u in sorted(sized, reverse=True)]
    ordered += [("manifest", u) for u in manifests[:1]]
    ordered += [("icon", u) for u in svg]
    if not touch:
        ordered.append(("icon", urljoin(base_url, "/apple-touch-icon.png")))
    ordered += [("icon", u) for u in unsized]
    ordered.append(("icon", urljoin(base_url, "/favicon.ico")))
    og = _meta_content(text[:300_000], "og:image")
    if og:
        ordered.append(("og", urljoin(base_url, og.strip())))
    return _dedupe(ordered)


async def _manifest_icons(client: httpx.AsyncClient, manifest_url: str) -> list[str]:
    data = await _fetch_json(client, manifest_url)
    icons = data.get("icons") if isinstance(data, dict) else None
    ranked = []
    for icon in icons if isinstance(icons, list) else []:
        if not isinstance(icon, dict) or not isinstance(icon.get("src"), str):
            continue
        if "monochrome" in str(icon.get("purpose") or ""):
            continue
        ranked.append((_size_of(icon.get("sizes")), urljoin(manifest_url, icon["src"])))
    return [u for _, u in sorted(ranked, reverse=True)][:2]


async def _homepage_logo(
    client: httpx.AsyncClient, page: _Page
) -> tuple[NormalizedLogo, str] | None:
    tries = 0
    for kind, url in _homepage_candidates(page.text, page.url):
        urls = await _manifest_icons(client, url) if kind == "manifest" else [url]
        for candidate in urls:
            if tries >= _MAX_HOMEPAGE_TRIES:
                return None
            tries += 1
            logo = await _try_logo(client, candidate)
            if not logo:
                continue
            if kind == "og" and not (0.8 <= logo.width / max(logo.height, 1) <= 1.25):
                continue
            return logo, candidate
    return None


# --- 5. Wikidata P154 -----------------------------------------------------

_WIKIDATA_API = "https://www.wikidata.org/w/api.php"


def _website_forms(domain: str) -> list[str]:
    """P856 values are exact strings: cover scheme, www and trailing slash."""
    return [
        f"{scheme}{host}{slash}"
        for scheme in ("https://", "http://")
        for host in (f"www.{domain}", domain)
        for slash in ("/", "")
    ]


async def _wikidata_ids_by_domain(client: httpx.AsyncClient, domain: str) -> list[str]:
    query = "haswbstatement:" + "|".join(f"P856={u}" for u in _website_forms(domain))
    data = await _fetch_json(client, _WIKIDATA_API, {
        "action": "query", "list": "search", "srsearch": query,
        "srlimit": 10, "srprop": "", "format": "json",
    })
    hits = ((data or {}).get("query") or {}).get("search") or [] if isinstance(data, dict) else []
    return [h["title"] for h in hits if isinstance(h, dict) and str(h.get("title", "")).startswith("Q")]


async def _wikidata_hits_by_name(client: httpx.AsyncClient, name: str) -> list[tuple[str, str]]:
    """(qid, English label) of the entities a name search returns."""
    data = await _fetch_json(client, _WIKIDATA_API, {
        "action": "wbsearchentities", "search": name, "language": "en",
        "type": "item", "limit": 5, "format": "json",
    })
    hits = (data or {}).get("search") or [] if isinstance(data, dict) else []
    return [
        (h["id"], str(h.get("label") or ""))
        for h in hits if isinstance(h, dict) and h.get("id")
    ]


def _name_variants(company: str) -> list[str]:
    base = clean_company_name(company)
    no_paren = re.sub(r"\s*\([^)]*\)", "", base).strip()
    no_suffix = re.sub(
        r"[,\s]+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|plc)\.?$", "",
        no_paren, flags=re.IGNORECASE,
    ).strip()
    return _dedupe([base, no_paren, no_suffix])[:3]


def _suffix_queries(company: str) -> list[str]:
    """Longer names worth searching when the plain name finds nothing:
    'Bell' -> 'Bell Canada' (a 'Bell' search only returns bells and people).
    Nothing for a name that already ends in a generic word."""
    base = _name_variants(company)[-1]
    words = name_words(base)
    if not words or words[-1] in ALIAS_SUFFIXES:
        return []
    return [f"{base} {suffix}" for suffix in _ALIAS_QUERY_SUFFIXES]


def _current_logo_file(entity: dict) -> str:
    """P154 filename: the preferred claim, else a normal one without an end
    time (P582), so 'Intel logo (1968-2006)' loses to the current logo."""
    claims = (entity.get("claims") or {}).get("P154") or []
    preferred = [c for c in claims if c.get("rank") == "preferred"]
    current = [
        c for c in claims
        if c.get("rank") == "normal" and "P582" not in (c.get("qualifiers") or {})
    ]
    for claim in preferred + current:
        try:
            value = claim["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        if isinstance(value, str) and value:
            return value
    return ""


def _entity_sites(entity: dict) -> set[str]:
    sites = set()
    for claim in (entity.get("claims") or {}).get("P856") or []:
        try:
            sites.add(_website_domain(claim["mainsnak"]["datavalue"]["value"]))
        except (KeyError, TypeError):
            continue
    return sites - {""}


async def _wikidata_pick(
    client: httpx.AsyncClient, ids: list[str], company: str, domains: list[str]
) -> tuple[NormalizedLogo, str, str | None] | None:
    ids = _dedupe(ids)[:10]
    if not ids:
        return None
    # Big companies carry hundreds of claims: ten entities can top 300KB.
    data = await _fetch_json(client, _WIKIDATA_API, {
        "action": "wbgetentities", "ids": "|".join(ids), "props": "claims|labels",
        "languages": "en", "format": "json",
    }, max_bytes=_MAX_IMAGE_BYTES)
    entities = (data or {}).get("entities") or {} if isinstance(data, dict) else {}
    key = name_key(company)

    def label(qid: str) -> str:
        return (((entities.get(qid) or {}).get("labels") or {}).get("en") or {}).get("value") or ""

    candidates: list[tuple[str, str | None]] = []  # (qid, matched verified domain)
    if domains:
        # Among equally valid entities, the one named exactly like the company wins.
        for qid in sorted((q for q in ids if q in entities), key=lambda q: name_key(label(q)) != key):
            matched = next((d for d in domains if d in _entity_sites(entities[qid])), None)
            if matched:
                candidates.append((qid, matched))
    elif key:
        # No verified website to compare: the label has to BE the company, or
        # its longer name when exactly one employer answers to that
        # ('Magna' -> 'Magna International', never the fungus 'Magnaporthe').
        present = [q for q in ids if q in entities and _current_logo_file(entities[q])]
        exact = [q for q in present if name_key(label(q)) == key]
        longer = [q for q in present if is_suffix_variant(label(q), company)]
        if not exact and len({name_key(label(q)) for q in longer}) > 1:
            longer = []
        candidates = [(q, None) for q in exact or longer]
    for qid, matched in candidates:
        filename = _current_logo_file(entities[qid])
        if not filename:
            continue
        url = (
            "https://commons.wikimedia.org/wiki/Special:FilePath/"
            + quote(filename) + "?width=256"
        )
        logo = await _try_logo(client, url)
        if logo:
            return logo, url, matched
    return None


async def _wikidata_logo(
    client: httpx.AsyncClient, company: str, domains: list[str]
) -> tuple[NormalizedLogo, str, str | None] | None:
    ids: list[str] = []
    for d in domains[:2]:
        ids += await _wikidata_ids_by_domain(client, d)
    hit = await _wikidata_pick(client, ids, company, domains)
    if hit or not name_key(company):
        return hit
    ids = []
    for variant in _name_variants(company):
        ids += [qid for qid, _ in await _wikidata_hits_by_name(client, variant)]
    hit = await _wikidata_pick(client, ids, company, domains)
    if hit:
        return hit
    # The longer names: only hits labelled exactly so are worth fetching.
    ids = []
    for query in _suffix_queries(company):
        ids += [
            qid for qid, label in await _wikidata_hits_by_name(client, query)
            if is_suffix_variant(label, company)
        ]
    return await _wikidata_pick(client, ids, company, domains)


# --- the cascade ----------------------------------------------------------

async def _harvest(client: httpx.AsyncClient, hints: LogoHints) -> HarvestResult | None:
    company = clean_company_name(hints.company)
    hit = await _from_existing(client, hints.existing_logo_urls or [])
    if hit:
        return hit

    if name_key(company):
        for job_id in _linkedin_job_ids(hints.job_urls or [])[:2]:
            found = await _linkedin_job_logo(client, job_id, company)
            if found:
                return HarvestResult(found[0], "linkedin_job", found[1])
        found = await _linkedin_search_logo(client, company)
        if found:
            return HarvestResult(found[0], "linkedin_search", found[1])

    discovered: list[str] = []
    hit = await _from_ats(client, hints.job_urls or [], discovered)
    if hit:
        return hit

    sites: list[_VerifiedSite] = []
    for domain in _dedupe(discovered + [_clean_domain(d) for d in hints.domains or []])[:3]:
        site = await _verify(client, domain, company)
        if site and site.domain not in [s.domain for s in sites]:
            sites.append(site)
    for site in sites:
        if site.page is None:
            continue
        found = await _homepage_logo(client, site.page)
        if found:
            url = found[1] if found[1].startswith("http") else site.page.url
            return HarvestResult(found[0], "homepage", url, site.domain)

    domains = [s.domain for s in sites]
    found_wd = await _wikidata_logo(client, company, domains)
    if found_wd:
        return HarvestResult(found_wd[0], "wikidata", found_wd[1], found_wd[2])

    for domain in domains:
        url = f"https://www.google.com/s2/favicons?domain={domain}&sz=256"
        logo = await _try_logo(client, url)
        if logo:
            return HarvestResult(logo, "s2", url, domain)
    return None


async def harvest_company_logo(
    client: httpx.AsyncClient, hints: LogoHints, *, time_cap: float | None = None
) -> HarvestResult | None:
    """Best real logo for a company, downloaded and normalized, or None.

    Never raises; gives up after time_cap seconds (HARVEST_TIME_CAP)."""
    try:
        result = await asyncio.wait_for(_harvest(client, hints), time_cap or HARVEST_TIME_CAP)
    except Exception as exc:
        logger.info("logo harvest: %r gave up: %r", hints.company, exc)
        return None
    if result:
        logger.info("logo harvest: %r -> %s %s", hints.company, result.source,
                    result.source_url[:120])
    return result


# --- legacy URL-returning API (cron-backfill phase 3, harvest_logos.py) ------

def image_width(data: bytes) -> int:
    """Pixel width decoded from raw bytes (largest ICO frame, SVG viewBox); 0 if unknown."""
    return image_size(data)[0]


async def harvest_from_homepage(client: httpx.AsyncClient, domain: str, company: str = "") -> str:
    """Best icon a VERIFIED domain's homepage declares, or ''."""
    try:
        site = await _verify(client, domain, company)
        found = await _homepage_logo(client, site.page) if site and site.page else None
    except Exception:
        return ""
    return found[1] if found and found[1].startswith("http") else ""


async def harvest_from_wikidata(
    client: httpx.AsyncClient, company: str, domains: list[str] | None = None
) -> str:
    """Wikidata P154 logo URL (Commons, 256px), or ''. Without verified
    domains the entity's label must equal the company name exactly."""
    try:
        found = await _wikidata_logo(client, clean_company_name(company), list(domains or []))
    except Exception:
        return ""
    return found[1] if found else ""


async def harvest_from_linkedin(
    client: httpx.AsyncClient, linkedin_job_url: str, company: str
) -> str:
    """The posting company's licdn logo URL for a LinkedIn job, or ''."""
    ids = _linkedin_job_ids([linkedin_job_url])
    if not ids or not name_key(company):
        return ""
    try:
        found = await _linkedin_job_logo(client, ids[0], clean_company_name(company))
    except Exception:
        return ""
    return found[1] if found else ""


async def harvest_logo(
    client: httpx.AsyncClient,
    domain: str,
    company: str,
    linkedin_job_url: str = "",
) -> str:
    """Best real logo URL for a company, or '' when none can be verified.

    Runs the full cascade; an s2 win returns '' because the caller's
    'favicon-only' sentinel is that same sz=256 URL."""
    result = await harvest_company_logo(
        client,
        LogoHints(
            company=company,
            domains=[domain] if domain else [],
            job_urls=[linkedin_job_url] if linkedin_job_url else [],
        ),
        time_cap=15.0,
    )
    if not result or result.source == "s2" or not result.source_url.startswith("http"):
        return ""
    return result.source_url
