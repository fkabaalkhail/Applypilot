"""
ATS Scraper — directly polls public ATS (Applicant Tracking System) APIs
for job listings with direct company apply links.

Supported platforms:
- Greenhouse (boards-api.greenhouse.io)
- Lever (api.lever.co)
- Ashby (api.ashbyhq.com)
- SmartRecruiters (api.smartrecruiters.com)
- Workday (per-tenant CxS JSON endpoints — registry entries that carry a
  ``workday_url_template``)

These APIs are public and intended for job board consumption.
No authentication required.

Two consumption shapes:
- ``scrape_all`` / ``scrape_company`` / ``_scrape_<platform>`` return filtered
  ``list[ATSJob]`` (the original interface — tests and callers rely on it).
- ``scrape_board`` returns a ``BoardSnapshot``: the filtered jobs PLUS the
  full set of live listing URLs on the board, which is what lets the ingest
  reconcile its rows against reality (mark removed / revive) instead of only
  ever adding.
"""

import asyncio
import logging
import datetime
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from backend.services.description_extractor import clean_html

logger = logging.getLogger(__name__)


@dataclass
class ATSJob:
    """A job listing from an ATS platform."""
    title: str
    company: str
    location: str
    url: str  # Direct apply link
    posted_date: Optional[datetime.datetime] = None
    department: Optional[str] = None
    work_type: Optional[str] = None  # Remote, On Site, Hybrid
    description: str = ""  # Plain text, captured from the board API when it carries content
    external_id: str = ""  # The source's own posting id — stable across URL changes
    employment_type: str = ""  # Source-declared commitment (Intern / Full-time / …)
    salary_text: str = ""  # Source-structured pay range, verbatim-ish
    detail_ref: str = ""  # Connector-specific ref for a lazy detail fetch (Workday externalPath)


@dataclass
class BoardSnapshot:
    """One board crawl: what to ingest, and what the board says is live.

    ``all_urls`` covers EVERY listing on the board, including ones the
    entry-level/NA filters rejected — reconciliation must never mistake
    "filtered out" for "taken down". ``complete`` is False when the fetch was
    partial (huge Workday boards); an incomplete snapshot must not be used to
    mark rows removed.
    """
    platform: str
    slug: str
    company: str
    jobs: list[ATSJob] = field(default_factory=list)
    all_urls: set[str] = field(default_factory=set)
    complete: bool = True
    total_listed: int = 0

    @property
    def board_key(self) -> str:
        return f"{self.platform}:{self.slug}"


# ─── Company → ATS mapping ───────────────────────────────────────────────────
# Each entry: (ats_platform, slug, company_display_name)
# DEPRECATED: the canonical source of truth is backend/data/ats_companies.json,
# loaded via company_registry.load_companies(). This list is kept only as an
# emergency fallback if the registry file cannot be read at runtime.
_LEGACY_ATS_COMPANIES: list[tuple[str, str, str]] = [
    # === Greenhouse companies (69) ===
    ("greenhouse", "affirm", "Affirm"),
    ("greenhouse", "airbnb", "Airbnb"),
    ("greenhouse", "airtable", "Airtable"),
    ("greenhouse", "amplitude", "Amplitude"),
    ("greenhouse", "anthropic", "Anthropic"),
    ("greenhouse", "applovin", "AppLovin"),
    ("greenhouse", "asana", "Asana"),
    ("greenhouse", "astranis", "Astranis"),
    ("greenhouse", "block", "Block"),
    ("greenhouse", "boxinc", "Box"),
    ("greenhouse", "brex", "Brex"),
    ("greenhouse", "chime", "Chime"),
    ("greenhouse", "cloudflare", "Cloudflare"),
    ("greenhouse", "cockroachlabs", "CockroachDB"),
    ("greenhouse", "contentful", "Contentful"),
    ("greenhouse", "databricks", "Databricks"),
    ("greenhouse", "datadog", "Datadog"),
    ("greenhouse", "discord", "Discord"),
    ("greenhouse", "doximity", "Doximity"),
    ("greenhouse", "dropbox", "Dropbox"),
    ("greenhouse", "duolingo", "Duolingo"),
    ("greenhouse", "elastic", "Elastic"),
    ("greenhouse", "epicgames", "Epic Games"),
    ("greenhouse", "faire", "Faire"),
    ("greenhouse", "figma", "Figma"),
    ("greenhouse", "flexport", "Flexport"),
    ("greenhouse", "gitlab", "GitLab"),
    ("greenhouse", "gusto", "Gusto"),
    ("greenhouse", "instacart", "Instacart"),
    ("greenhouse", "janestreet", "Jane Street"),
    ("greenhouse", "jetbrains", "JetBrains"),
    ("greenhouse", "labelbox", "Labelbox"),
    ("greenhouse", "lattice", "Lattice"),
    ("greenhouse", "lucidmotors", "Lucid Motors"),
    ("greenhouse", "lyft", "Lyft"),
    ("greenhouse", "marqeta", "Marqeta"),
    ("greenhouse", "mixpanel", "Mixpanel"),
    ("greenhouse", "mongodb", "MongoDB"),
    ("greenhouse", "netlify", "Netlify"),
    ("greenhouse", "newrelic", "New Relic"),
    ("greenhouse", "nuro", "Nuro"),
    ("greenhouse", "okta", "Okta"),
    ("greenhouse", "oscar", "Oscar Health"),
    ("greenhouse", "pagerduty", "PagerDuty"),
    ("greenhouse", "peloton", "Peloton"),
    ("greenhouse", "pinterest", "Pinterest"),
    ("greenhouse", "reddit", "Reddit"),
    ("greenhouse", "relativity", "Relativity"),
    ("greenhouse", "riotgames", "Riot Games"),
    ("greenhouse", "robinhood", "Robinhood"),
    ("greenhouse", "roblox", "Roblox"),
    ("greenhouse", "roku", "Roku"),
    ("greenhouse", "samsara", "Samsara"),
    ("greenhouse", "scaleai", "Scale AI"),
    ("greenhouse", "sofi", "SoFi"),
    ("greenhouse", "spacex", "SpaceX"),
    ("greenhouse", "squarespace", "Squarespace"),
    ("greenhouse", "stripe", "Stripe"),
    ("greenhouse", "toast", "Toast"),
    ("greenhouse", "twilio", "Twilio"),
    ("greenhouse", "twitch", "Twitch"),
    ("greenhouse", "unity3d", "Unity"),
    ("greenhouse", "vercel", "Vercel"),
    ("greenhouse", "verkada", "Verkada"),
    ("greenhouse", "waymo", "Waymo"),
    ("greenhouse", "webflow", "Webflow"),
    ("greenhouse", "zscaler", "Zscaler"),
    ("greenhouse", "coinbase", "Coinbase"),
    ("greenhouse", "doordash", "DoorDash"),
    ("greenhouse", "snap", "Snap"),
    ("greenhouse", "openai", "OpenAI"),
    # === Lever companies ===
    ("lever", "anyscale", "Anyscale"),
    ("lever", "gopuff", "GoPuff"),
    ("lever", "neon", "Neon"),
    ("lever", "palantir", "Palantir"),
    ("lever", "shieldai", "Shield AI"),
    ("lever", "spotify", "Spotify"),
    ("lever", "veeva", "Veeva Systems"),
    ("lever", "zoox", "Zoox"),
    ("lever", "netflix", "Netflix"),
    ("lever", "wattpad", "Wattpad"),
    ("lever", "fullscript", "Fullscript"),
    # === Ashby companies ===
    ("ashby", "vanta", "Vanta"),
    ("ashby", "notion", "Notion"),
    ("ashby", "ramp", "Ramp"),
    ("ashby", "linear", "Linear"),
    ("ashby", "mercury", "Mercury"),
    ("ashby", "retool", "Retool"),
    ("ashby", "watershed", "Watershed"),
    ("ashby", "anduril", "Anduril"),
    ("ashby", "plaid", "Plaid"),
    ("ashby", "airtable", "Airtable"),
    ("ashby", "deel", "Deel"),
    ("ashby", "rippling", "Rippling"),
    ("ashby", "openphone", "OpenPhone"),
    ("ashby", "loom", "Loom"),
    # === Canadian tech (verified to contain CA jobs: Ottawa/Toronto/Waterloo/Montreal/Vancouver) ===
    ("greenhouse", "geotab", "Geotab"),
    ("greenhouse", "workleap", "Workleap"),
    ("greenhouse", "alayacare", "AlayaCare"),
    ("greenhouse", "flipp", "Flipp"),
    ("greenhouse", "later", "Later"),
    ("greenhouse", "hootsuite", "Hootsuite"),
    ("greenhouse", "thinkific", "Thinkific"),
    ("greenhouse", "canonical", "Canonical"),
    ("greenhouse", "mojio", "Mojio"),
    ("lever", "pointclickcare", "PointClickCare"),
    ("lever", "achievers", "Achievers"),
    ("ashby", "neofinancial", "Neo Financial"),
    ("ashby", "cohere", "Cohere"),
    ("ashby", "wealthsimple", "Wealthsimple"),
    ("ashby", "1password", "1Password"),
    ("ashby", "jobber", "Jobber"),
    ("ashby", "benevity", "Benevity"),
    ("ashby", "jane", "Jane Software"),
    ("ashby", "trulioo", "Trulioo"),
    ("ashby", "hopper", "Hopper"),
    ("ashby", "float", "Float"),
    ("ashby", "klue", "Klue"),
    ("ashby", "loopio", "Loopio"),
    ("ashby", "rewind", "Rewind"),
    ("ashby", "top-hat", "Top Hat"),
    # === SmartRecruiters companies ===
    ("smartrecruiters", "Visa", "Visa"),
    ("smartrecruiters", "BoschGroup", "Bosch"),
    ("smartrecruiters", "Accenture1", "Accenture"),
    ("smartrecruiters", "DHL", "DHL"),
    ("smartrecruiters", "Adidas", "Adidas"),
    ("smartrecruiters", "Sanofi", "Sanofi"),
    ("smartrecruiters", "Ubisoft", "Ubisoft"),
    ("smartrecruiters", "Deloitte4", "Deloitte"),
]


# Canonical company list — loaded from backend/data/ats_companies.json.
# Falls back to the legacy hardcoded list if the registry can't be read.
try:
    from backend.data.company_registry import load_companies

    ATS_COMPANIES: list[tuple[str, str, str]] = load_companies() or _LEGACY_ATS_COMPANIES
    if ATS_COMPANIES is _LEGACY_ATS_COMPANIES:
        logger.warning("Company registry empty; using legacy fallback list")
except Exception as e:  # pragma: no cover - defensive
    logger.error("Failed to load company registry, using legacy list: %s", e)
    ATS_COMPANIES = _LEGACY_ATS_COMPANIES


# Keywords that indicate intern/new-grad level roles
ENTRY_LEVEL_KEYWORDS = [
    r"\bintern\b",
    r"\binternship\b",
    r"\bco-?op\b",
    r"\bnew grad\b",
    r"\bnew graduate\b",
    r"\bentry level\b",
    r"\bentry-level\b",
    r"\bjunior\b",
    r"\bassociate\b",
    r"\b(i|1|I)\b",  # Level I/1
    r"\bearly career\b",
    r"\brecent grad\b",
    r"\bgraduate\b",
    r"\brotational\b",
    r"\buniversity\b",
    r"\bcampus\b",
    r"\bfresh\b",
    r"\b0-2 years\b",
    r"\b0-1 years\b",
    r"\b1-2 years\b",
    r"\bnew college\b",
    r"\bstarter\b",
    r"\bapprentice\b",
    r"\btrainee\b",
    r"\banalyst\b",
]

ENTRY_LEVEL_PATTERN = re.compile("|".join(ENTRY_LEVEL_KEYWORDS), re.IGNORECASE)

# Title patterns that indicate senior roles (to EXCLUDE)
SENIOR_KEYWORDS = re.compile(
    r"\bsenior\b|\bsr\.?\b|\bstaff\b|\bprincipal\b|\blead\b|\bmanager\b"
    r"|\bdirector\b|\bvp\b|\bhead of\b|\barchitect\b|\bfellow\b"
    r"|\biii\b|\biv\b|\b[3-9]\+?\s*years\b|\b[5-9]\b|\b10\+\b",
    re.IGNORECASE
)


# Location keywords for US/Canada filtering
US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
}

CA_PROVINCES = {
    "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE",
    "NT", "YT", "NU",
}

US_CITIES = [
    "new york", "san francisco", "los angeles", "chicago", "seattle",
    "austin", "boston", "denver", "atlanta", "dallas", "houston",
    "miami", "philadelphia", "phoenix", "san diego", "san jose",
    "portland", "minneapolis", "detroit", "pittsburgh", "raleigh",
    "charlotte", "nashville", "salt lake city", "washington",
    "mountain view", "palo alto", "sunnyvale", "cupertino",
    "menlo park", "redmond", "bellevue", "irvine", "santa monica",
    "brooklyn", "manhattan",
]

CA_CITIES = [
    "toronto", "vancouver", "montreal", "ottawa", "calgary",
    "edmonton", "winnipeg", "quebec", "hamilton", "kitchener",
    "waterloo", "mississauga", "brampton", "markham",
    "london", "victoria", "halifax", "burnaby", "richmond",
    "gatineau", "kanata", "scarborough", "north york", "etobicoke",
    "vaughan", "richmond hill", "oakville", "burlington", "guelph",
    "saskatoon", "regina", "fredericton", "moncton", "kelowna",
    "windsor", "laval", "longueuil", "sherbrooke", "barrie",
]


# ─── Per-host pacing (ToS hygiene) ───────────────────────────────────────────
# Greenhouse/Lever/Ashby boards all share one API host each, so a registry of
# 100+ boards means 100+ back-to-back requests to the same host. Space them.

_HOST_MIN_INTERVAL = float(os.getenv("ATS_PER_HOST_INTERVAL", "0.35"))
_host_last_request: dict[str, float] = {}
_pace_lock: Optional[asyncio.Lock] = None


async def _pace(host: str) -> None:
    """Enforce a minimum interval between requests to the same host."""
    global _pace_lock
    if _HOST_MIN_INTERVAL <= 0 or not host:
        return
    if _pace_lock is None:
        _pace_lock = asyncio.Lock()
    async with _pace_lock:
        now = time.monotonic()
        wait = _host_last_request.get(host, 0.0) + _HOST_MIN_INTERVAL - now
        if wait > 0:
            await asyncio.sleep(wait)
            now = time.monotonic()
        _host_last_request[host] = now


def _host_of(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "")
    return m.group(1).lower() if m else ""


# ─── Workday helpers ─────────────────────────────────────────────────────────

_WORKDAY_MAX_PAGES = max(1, int(os.getenv("WORKDAY_MAX_PAGES", "8")))
_WORKDAY_PAGE_SIZE = 20  # CxS caps at 20
_POSTED_AGO_RE = re.compile(r"posted\s+(today|yesterday|(\d+)\+?\s+days?\s+ago)", re.IGNORECASE)


def _parse_workday_posted(posted_on: str) -> Optional[datetime.datetime]:
    """"Posted Today" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → datetime."""
    m = _POSTED_AGO_RE.search(posted_on or "")
    if not m:
        return None
    now = datetime.datetime.now(datetime.timezone.utc)
    token = m.group(1).lower()
    if token == "today":
        return now
    if token == "yesterday":
        return now - datetime.timedelta(days=1)
    try:
        return now - datetime.timedelta(days=int(m.group(2)))
    except (TypeError, ValueError):
        return None


def workday_public_base(cxs_base: str) -> str:
    """CxS API base → public posting base.

    "https://bmo.wd3.myworkdayjobs.com/wday/cxs/bmo/external"
      → "https://bmo.wd3.myworkdayjobs.com/external"
    """
    m = re.match(r"(https?://[^/]+)/wday/cxs/[^/]+/([^/?#]+)", (cxs_base or "").rstrip("/"))
    if not m:
        return (cxs_base or "").rstrip("/")
    return f"{m.group(1)}/{m.group(2)}"


def _workday_external_id(external_path: str, bullet_fields: list) -> str:
    """Prefer the req id Workday appends to the path ("…_R-12345"); fall back
    to the first bulletField (usually the same req id)."""
    tail = (external_path or "").rsplit("/", 1)[-1]
    if "_" in tail:
        candidate = tail.rsplit("_", 1)[-1]
        if candidate and len(candidate) <= 40:
            return candidate
    for item in bullet_fields or []:
        if isinstance(item, str) and item.strip():
            return item.strip()
    return tail[:80]


class ATSScraper:
    """Scrapes job listings from public ATS APIs."""

    def __init__(self, filter_entry_level: bool = True, filter_north_america: bool = True):
        self.filter_entry_level = filter_entry_level
        self.filter_north_america = filter_north_america

    # ── Batch interfaces ────────────────────────────────────────────────────

    async def scrape_all(
        self, companies: Optional[list[tuple[str, str, str]]] = None
    ) -> list[ATSJob]:
        """Scrape the given (platform, slug, name) companies — the full
        registry when omitted. Returns filtered job list."""
        all_jobs: list[ATSJob] = []
        if companies is None:
            companies = ATS_COMPANIES

        async with httpx.AsyncClient(timeout=30) as client:
            for platform, slug, company_name in companies:
                try:
                    snapshot = await self.scrape_board(client, platform, slug, company_name)
                    all_jobs.extend(snapshot.jobs)
                    logger.info(f"Scraped {len(snapshot.jobs)} jobs from {platform}/{slug}")
                except httpx.HTTPStatusError as e:
                    logger.warning(f"HTTP error scraping {platform}/{slug}: {e.response.status_code}")
                except httpx.TimeoutException:
                    logger.warning(f"Timeout scraping {platform}/{slug}")
                except Exception as e:
                    logger.warning(f"Error scraping {platform}/{slug}: {e}")

        return all_jobs

    async def scrape_company(self, platform: str, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape a single company. Returns filtered job list."""
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                snapshot = await self.scrape_board(client, platform, slug, company_name)
            except Exception:
                return []
            return snapshot.jobs

    async def scrape_board(
        self, client: httpx.AsyncClient, platform: str, slug: str, company_name: str
    ) -> BoardSnapshot:
        """Fetch one board completely: filtered jobs + the full live-URL set.

        Raises on fetch failure (callers isolate per-board errors) — a failed
        board must never produce an empty snapshot that reads as "everything
        was taken down"."""
        if platform == "greenhouse":
            listings = await self._fetch_greenhouse(client, slug, company_name)
            complete, total = True, len(listings)
        elif platform == "lever":
            listings = await self._fetch_lever(client, slug, company_name)
            complete, total = True, len(listings)
        elif platform == "ashby":
            listings = await self._fetch_ashby(client, slug, company_name)
            complete, total = True, len(listings)
        elif platform == "smartrecruiters":
            listings, complete, total = await self._fetch_smartrecruiters(client, slug, company_name)
        elif platform == "workday":
            listings, complete, total = await self._fetch_workday(client, slug, company_name)
        else:
            return BoardSnapshot(platform=platform, slug=slug, company=company_name,
                                 complete=False)

        snapshot = BoardSnapshot(
            platform=platform,
            slug=slug,
            company=company_name,
            jobs=[job for job in listings if self._passes_filters(job)],
            all_urls={job.url for job in listings if job.url},
            complete=complete,
            total_listed=total,
        )
        return snapshot

    # ── Back-compat filtered single-platform methods ────────────────────────

    async def _scrape_greenhouse(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        return [j for j in await self._fetch_greenhouse(client, slug, company_name)
                if self._passes_filters(j)]

    async def _scrape_lever(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        return [j for j in await self._fetch_lever(client, slug, company_name)
                if self._passes_filters(j)]

    async def _scrape_ashby(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        return [j for j in await self._fetch_ashby(client, slug, company_name)
                if self._passes_filters(j)]

    async def _scrape_smartrecruiters(self, client: httpx.AsyncClient, identifier: str, company_name: str) -> list[ATSJob]:
        listings, _complete, _total = await self._fetch_smartrecruiters(client, identifier, company_name)
        return [j for j in listings if self._passes_filters(j)]

    # ── Platform fetchers (unfiltered) ──────────────────────────────────────

    async def _fetch_greenhouse(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Fetch jobs from Greenhouse boards API.

        API docs: https://developers.greenhouse.io/job-board.html
        """
        url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
        params = {"content": "true"}  # Same single request, but with descriptions

        await _pace(_host_of(url))
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

        jobs: list[ATSJob] = []
        for job_data in data.get("jobs", []):
            title = job_data.get("title", "")
            location = job_data.get("location", {}).get("name", "")
            job_url = job_data.get("absolute_url", "")
            updated_at = job_data.get("updated_at", "")

            # Parse date
            posted_date = None
            if updated_at:
                try:
                    posted_date = datetime.datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            # Determine department
            departments = job_data.get("departments", [])
            department = departments[0].get("name", "") if departments else ""

            # Pay transparency ranges, when the employer publishes them.
            salary_text = ""
            for pay_range in job_data.get("pay_input_ranges") or []:
                min_cents = pay_range.get("min_cents")
                max_cents = pay_range.get("max_cents")
                if min_cents and max_cents:
                    currency = pay_range.get("currency_type", "USD")
                    salary_text = f"{min_cents / 100:.0f}-{max_cents / 100:.0f} {currency}"
                    break

            job = ATSJob(
                title=title,
                company=company_name,
                location=location,
                url=job_url,
                posted_date=posted_date,
                department=department,
                work_type=self._detect_work_type(location, title),
                description=clean_html(job_data.get("content", "") or ""),
                external_id=str(job_data.get("id") or ""),
                salary_text=salary_text,
            )
            jobs.append(job)

        return jobs

    async def _fetch_lever(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Fetch jobs from Lever postings API.

        API docs: https://github.com/lever/postings-api
        """
        url = f"https://api.lever.co/v0/postings/{slug}"
        params = {"mode": "json"}

        await _pace(_host_of(url))
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

        if not isinstance(data, list):
            return []

        jobs: list[ATSJob] = []
        for posting in data:
            title = posting.get("text", "")
            categories = posting.get("categories", {})
            location = categories.get("location", "")
            job_url = posting.get("hostedUrl", "")
            created_at = posting.get("createdAt")

            # Lever uses millisecond timestamps
            posted_date = None
            if created_at:
                try:
                    posted_date = datetime.datetime.fromtimestamp(created_at / 1000)
                except (ValueError, TypeError, OSError):
                    pass

            department = categories.get("department", "")
            commitment = categories.get("commitment", "")  # e.g., "Full-time", "Intern"

            description = posting.get("descriptionPlain") or ""
            for lst in posting.get("lists", []) or []:
                content = clean_html(lst.get("content", ""))
                if content:
                    description += f"\n\n{lst.get('text', '')}\n{content}"
            description = description.strip()[:10000]

            salary_text = ""
            salary_range = posting.get("salaryRange") or {}
            if salary_range.get("min") and salary_range.get("max"):
                currency = salary_range.get("currency", "USD")
                interval = salary_range.get("interval", "")
                salary_text = f"{salary_range['min']}-{salary_range['max']} {currency} {interval}".strip()

            job = ATSJob(
                title=title,
                company=company_name,
                location=location,
                url=job_url,
                posted_date=posted_date,
                department=department,
                work_type=self._detect_work_type(location, title),
                description=description,
                external_id=str(posting.get("id") or ""),
                employment_type=commitment,
                salary_text=salary_text,
            )
            jobs.append(job)

        return jobs

    async def _fetch_ashby(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Fetch jobs from Ashby posting API.

        API: https://api.ashbyhq.com/posting-api/job-board/{slug}
        """
        url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"

        await _pace(_host_of(url))
        response = await client.get(url)
        response.raise_for_status()
        data = response.json()

        jobs: list[ATSJob] = []
        for job_data in data.get("jobs", []):
            title = job_data.get("title", "")
            location = job_data.get("location", "")
            job_url = job_data.get("jobUrl", "")
            published_at = job_data.get("publishedAt", "")
            department = job_data.get("departmentName", "")

            # Parse date
            posted_date = None
            if published_at:
                try:
                    posted_date = datetime.datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

            job = ATSJob(
                title=title,
                company=company_name,
                location=location,
                url=job_url,
                posted_date=posted_date,
                department=department,
                work_type=self._detect_work_type(location, title),
                description=clean_html(
                    job_data.get("descriptionHtml") or job_data.get("descriptionPlain") or ""
                ),
                external_id=str(job_data.get("id") or ""),
                employment_type=job_data.get("employmentType", "") or "",
                salary_text=job_data.get("compensationTierSummary", "") or "",
            )
            jobs.append(job)

        return jobs

    async def _fetch_smartrecruiters(
        self, client: httpx.AsyncClient, identifier: str, company_name: str
    ) -> tuple[list[ATSJob], bool, int]:
        """Fetch jobs from SmartRecruiters postings API, following pagination.

        API: https://api.smartrecruiters.com/v1/companies/{identifier}/postings
        Returns (listings, complete, total_on_board).
        """
        base_url = f"https://api.smartrecruiters.com/v1/companies/{identifier}/postings"
        page_size = 100
        max_pages = 5

        jobs: list[ATSJob] = []
        total_found = 0
        offset = 0
        for _page in range(max_pages):
            await _pace(_host_of(base_url))
            response = await client.get(
                base_url, params={"limit": str(page_size), "offset": str(offset)}
            )
            response.raise_for_status()
            data = response.json()
            content = data.get("content", [])
            total_found = int(data.get("totalFound") or len(content))

            for job_data in content:
                title = job_data.get("name", "")

                # Build location from city, region, country
                loc_info = job_data.get("location", {})
                loc_parts = [
                    loc_info.get("city", ""),
                    loc_info.get("region", ""),
                    loc_info.get("country", ""),
                ]
                location = ", ".join(part for part in loc_parts if part)

                # Use ref_url or construct from identifier + id
                job_id = job_data.get("id", "")
                job_url = job_data.get("ref_url", "")
                if not job_url:
                    job_url = f"https://careers.smartrecruiters.com/{identifier}/{job_id}"

                released_date = job_data.get("releasedDate", "")
                department_info = job_data.get("department", {})
                department = department_info.get("label", "") if department_info else ""

                # Parse date
                posted_date = None
                if released_date:
                    try:
                        posted_date = datetime.datetime.fromisoformat(released_date.replace("Z", "+00:00"))
                    except (ValueError, TypeError):
                        pass

                employment_info = job_data.get("typeOfEmployment") or {}

                job = ATSJob(
                    title=title,
                    company=company_name,
                    location=location,
                    url=job_url,
                    posted_date=posted_date,
                    department=department,
                    work_type=self._detect_work_type(location, title),
                    external_id=str(job_id or ""),
                    employment_type=(employment_info.get("label") or "") if isinstance(employment_info, dict) else "",
                )
                jobs.append(job)

            offset += len(content)
            if not content or offset >= total_found:
                break

        return jobs, offset >= total_found, total_found

    async def _fetch_workday(
        self, client: httpx.AsyncClient, slug: str, company_name: str
    ) -> tuple[list[ATSJob], bool, int]:
        """Fetch jobs from a Workday tenant's CxS job board API.

        The endpoint base comes from the registry's ``workday_url_template``
        ("https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}").
        POST {base}/jobs pages 20 at a time, newest first. Descriptions are NOT
        in the list payload — fetch_workday_detail() fills them per new job.

        Returns (listings, complete, total_on_board). Big boards (Amazon-sized)
        exceed the page cap; complete=False tells reconciliation to stand down.
        """
        from backend.data.company_registry import load_workday_bases

        cxs_base = load_workday_bases().get(slug, "")
        if not cxs_base:
            logger.warning("workday/%s has no workday_url_template; skipping", slug)
            return [], False, 0

        cxs_base = cxs_base.rstrip("/")
        public_base = workday_public_base(cxs_base)
        list_url = f"{cxs_base}/jobs"
        host = _host_of(list_url)

        jobs: list[ATSJob] = []
        total = 0
        fetched = 0
        for page in range(_WORKDAY_MAX_PAGES):
            await _pace(host)
            response = await client.post(
                list_url,
                json={
                    "appliedFacets": {},
                    "limit": _WORKDAY_PAGE_SIZE,
                    "offset": page * _WORKDAY_PAGE_SIZE,
                    "searchText": "",
                },
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            postings = data.get("jobPostings", []) or []
            # Some tenants only report "total" on the first page (BMO returns
            # 0 afterwards) — keep the largest figure seen, never regress.
            total = max(total, int(data.get("total") or 0))

            for posting in postings:
                external_path = posting.get("externalPath", "") or ""
                title = posting.get("title", "") or ""
                location = posting.get("locationsText", "") or ""
                if not title or not external_path:
                    continue
                job = ATSJob(
                    title=title,
                    company=company_name,
                    location=location,
                    url=f"{public_base}{external_path}",
                    posted_date=_parse_workday_posted(posting.get("postedOn", "") or ""),
                    department="",
                    work_type=self._detect_work_type(location, title),
                    external_id=_workday_external_id(external_path, posting.get("bulletFields")),
                    detail_ref=external_path,
                )
                jobs.append(job)

            fetched += len(postings)
            if not postings or fetched >= total:
                break

        return jobs, fetched >= total, total


    def _passes_filters(self, job: ATSJob) -> bool:
        """Check if a job passes the configured filters."""
        if self.filter_entry_level and not self._is_entry_level(job):
            return False
        if self.filter_north_america and not self._is_north_america(job.location):
            return False
        return True

    def _is_entry_level(self, job: ATSJob) -> bool:
        """Check if a job is intern/new-grad/entry-level.

        Matches entry-level keywords AND excludes senior-level titles.
        """
        text = f"{job.title} {job.department}".lower()
        # Must match entry-level keywords
        if not ENTRY_LEVEL_PATTERN.search(text):
            return False
        # Must NOT match senior keywords
        if SENIOR_KEYWORDS.search(job.title):
            return False
        return True

    def _is_north_america(self, location: str) -> bool:
        """Check if location is in US or Canada."""
        if not location:
            return False

        loc_lower = location.lower()

        # Check explicit country mentions
        if "united states" in loc_lower or "usa" in loc_lower or "u.s." in loc_lower:
            return True
        if "canada" in loc_lower:
            return True

        # Check US cities
        for city in US_CITIES:
            if city in loc_lower:
                return True

        # Check Canadian cities
        for city in CA_CITIES:
            if city in loc_lower:
                return True

        # Check state/province abbreviations
        tokens = re.findall(r'\b([A-Z]{2})\b', location)
        for token in tokens:
            if token in US_STATES or token in CA_PROVINCES:
                return True

        # "Remote" without specific non-NA country = include
        if "remote" in loc_lower:
            # Exclude if explicitly another country
            non_na = ["uk", "united kingdom", "germany", "india", "japan",
                      "australia", "france", "brazil", "singapore", "ireland",
                      "netherlands", "spain", "italy", "korea", "china"]
            if not any(c in loc_lower for c in non_na):
                return True

        return False

    def _detect_work_type(self, location: str, title: str) -> str:
        """Detect Remote/Hybrid/On Site from location and title text."""
        combined = f"{location} {title}".lower()
        if "remote" in combined:
            if "hybrid" in combined:
                return "Hybrid"
            return "Remote"
        if "hybrid" in combined:
            return "Hybrid"
        return "On Site"


async def fetch_workday_detail(
    client: httpx.AsyncClient, slug: str, detail_ref: str
) -> dict:
    """Fetch one Workday posting's detail (description + timeType).

    GET {cxs_base}{externalPath} → jobPostingInfo. Called for NEW jobs only —
    one request per job, same budget shape as the SmartRecruiters detail fetch.
    Returns {"description": str, "employment_type": str}; empty dict on miss.
    """
    from backend.data.company_registry import load_workday_bases

    cxs_base = (load_workday_bases().get(slug, "") or "").rstrip("/")
    if not cxs_base or not detail_ref:
        return {}

    url = f"{cxs_base}{detail_ref}"
    await _pace(_host_of(url))
    response = await client.get(url, headers={"Accept": "application/json"})
    response.raise_for_status()
    info = (response.json() or {}).get("jobPostingInfo") or {}

    return {
        "description": clean_html(info.get("jobDescription", "") or "")[:10000],
        "employment_type": info.get("timeType", "") or "",
    }
