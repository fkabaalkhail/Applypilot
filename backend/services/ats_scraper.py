"""
ATS Scraper — directly polls public ATS (Applicant Tracking System) APIs
for job listings with direct company apply links.

Supported platforms:
- Greenhouse (boards-api.greenhouse.io)
- Lever (api.lever.co)
- Ashby (api.ashbyhq.com)
- SmartRecruiters (api.smartrecruiters.com)

These APIs are public and intended for job board consumption.
No authentication required.
"""

import logging
import datetime
import re
from dataclasses import dataclass
from typing import Optional

import httpx

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
    work_type: Optional[str] = None  # canonical: remote, hybrid, onsite
    salary: Optional[str] = None  # e.g. "$95K – $112K" when the ATS exposes it
    description: Optional[str] = None  # plain-text description when the ATS exposes it


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

# Workday boards carry a per-tenant CXS URL, so they're loaded separately as
# (slug, name, cxs_base). Kept in its own try so a Workday-loader failure can't
# discard the already-loaded ATS_COMPANIES.
try:
    from backend.data.company_registry import load_workday_boards

    WORKDAY_BOARDS: list[tuple[str, str, str]] = load_workday_boards()
except Exception as e:  # pragma: no cover - defensive
    logger.error("Failed to load Workday boards: %s", e)
    WORKDAY_BOARDS = []


# Workday's CXS API rejects a `limit` above 20 (returns an empty page), so the
# scraper must page in 20s. Ordering is newest-first, so a bounded page walk
# still surfaces the freshest postings; URL dedup accretes the rest over runs.
WORKDAY_PAGE_SIZE = 20
WORKDAY_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}
# Early-career searchText terms used to target entry-level roles on big Workday
# boards. Each also appears in ENTRY_LEVEL_KEYWORDS, so Workday's relevance-ranked
# matches survive the entry-level filter instead of being discarded as senior.
WORKDAY_ENTRY_SEARCHES = (
    "intern",
    "new grad",
    "co-op",
    "associate",
    "analyst",
    "junior",
)

# SmartRecruiters returns 100 postings per page; large employers (Bosch: 4600+)
# need pagination. Cap the walk so a single huge board can't dominate a run.
SMARTRECRUITERS_PAGE_SIZE = 100
SMARTRECRUITERS_MAX_PAGES = 10


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


class ATSScraper:
    """Scrapes job listings from public ATS APIs."""

    def __init__(
        self,
        filter_entry_level: bool = True,
        filter_north_america: bool = True,
        workday_max_pages: int = 10,
        workday_search_pages: int = 2,
    ):
        self.filter_entry_level = filter_entry_level
        self.filter_north_america = filter_north_america
        # Workday boards are large (banks/consulting post thousands of roles), so
        # bound the crawl. ``workday_max_pages`` caps the default page walk (used
        # when not filtering to entry-level); ``workday_search_pages`` caps pages
        # per early-career search term when the entry-level filter is on.
        self.workday_max_pages = workday_max_pages
        self.workday_search_pages = workday_search_pages

    async def scrape_all(self) -> list[ATSJob]:
        """Scrape all configured ATS companies. Returns filtered job list."""
        all_jobs: list[ATSJob] = []

        async with httpx.AsyncClient(timeout=30) as client:
            for platform, slug, company_name in ATS_COMPANIES:
                try:
                    if platform == "greenhouse":
                        jobs = await self._scrape_greenhouse(client, slug, company_name)
                    elif platform == "lever":
                        jobs = await self._scrape_lever(client, slug, company_name)
                    elif platform == "ashby":
                        jobs = await self._scrape_ashby(client, slug, company_name)
                    elif platform == "smartrecruiters":
                        jobs = await self._scrape_smartrecruiters(client, slug, company_name)
                    else:
                        continue

                    all_jobs.extend(jobs)
                    logger.info(f"Scraped {len(jobs)} jobs from {platform}/{slug}")

                except httpx.HTTPStatusError as e:
                    logger.warning(f"HTTP error scraping {platform}/{slug}: {e.response.status_code}")
                except httpx.TimeoutException:
                    logger.warning(f"Timeout scraping {platform}/{slug}")
                except Exception as e:
                    logger.warning(f"Error scraping {platform}/{slug}: {e}")

            # Workday boards (banks, consulting, telecom, big tech) are scraped
            # separately because each needs a per-tenant CXS URL. This is where
            # most finance / marketing / HR / operations roles live.
            for slug, company_name, cxs_base in WORKDAY_BOARDS:
                try:
                    jobs = await self._scrape_workday(client, cxs_base, company_name)
                    all_jobs.extend(jobs)
                    logger.info(f"Scraped {len(jobs)} jobs from workday/{slug}")
                except httpx.HTTPStatusError as e:
                    logger.warning(f"HTTP error scraping workday/{slug}: {e.response.status_code}")
                except httpx.TimeoutException:
                    logger.warning(f"Timeout scraping workday/{slug}")
                except Exception as e:
                    logger.warning(f"Error scraping workday/{slug}: {e}")

        return all_jobs

    async def scrape_company(self, platform: str, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape a single company. Returns filtered job list."""
        async with httpx.AsyncClient(timeout=30) as client:
            if platform == "greenhouse":
                return await self._scrape_greenhouse(client, slug, company_name)
            elif platform == "lever":
                return await self._scrape_lever(client, slug, company_name)
            elif platform == "ashby":
                return await self._scrape_ashby(client, slug, company_name)
            elif platform == "smartrecruiters":
                return await self._scrape_smartrecruiters(client, slug, company_name)
            elif platform == "workday":
                cxs_base = next(
                    (base for s, _, base in WORKDAY_BOARDS if s == slug), None
                )
                if not cxs_base:
                    return []
                return await self._scrape_workday(client, cxs_base, company_name)
            return []

    async def _scrape_greenhouse(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape jobs from Greenhouse boards API.

        API docs: https://developers.greenhouse.io/job-board.html
        """
        url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
        params = {"content": "false"}  # Skip full HTML descriptions for speed

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

            job = ATSJob(
                title=title,
                company=company_name,
                location=location,
                url=job_url,
                posted_date=posted_date,
                department=department,
                work_type=self._detect_work_type(location, title),
            )

            if self._passes_filters(job):
                jobs.append(job)

        return jobs

    async def _scrape_lever(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape jobs from Lever postings API.

        API docs: https://github.com/lever/postings-api
        """
        url = f"https://api.lever.co/v0/postings/{slug}"
        params = {"mode": "json"}

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

            job = ATSJob(
                title=title,
                company=company_name,
                location=location,
                url=job_url,
                posted_date=posted_date,
                department=department,
                work_type=self._detect_work_type(location, title),
            )

            if self._passes_filters(job):
                jobs.append(job)

        return jobs

    async def _scrape_ashby(self, client: httpx.AsyncClient, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape jobs from Ashby posting API.

        API: https://api.ashbyhq.com/posting-api/job-board/{slug}

        Ashby's public API is unusually rich: with ``includeCompensation=true`` it
        returns a salary summary, plus a plain-text description, remote flag and a
        direct apply URL — so we populate salary/description/work_type at scrape
        time instead of leaving them for the (slower, lossy) enrichment pass.
        """
        url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"

        response = await client.get(url, params={"includeCompensation": "true"})
        response.raise_for_status()
        data = response.json()

        jobs: list[ATSJob] = []
        for job_data in data.get("jobs", []):
            title = job_data.get("title", "")
            location = job_data.get("location", "")
            # jobUrl is the public posting page; fall back to applyUrl.
            job_url = job_data.get("jobUrl") or job_data.get("applyUrl") or ""
            published_at = job_data.get("publishedAt", "")
            department = job_data.get("departmentName") or job_data.get("department", "")

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
                work_type=self._ashby_work_type(job_data, location, title),
                salary=self._ashby_salary(job_data),
                # descriptionHtml (not …Plain): the write path sanitizes HTML the
                # same way as every other description source, so plain text isn't
                # mangled by an HTML sanitizer.
                description=(job_data.get("descriptionHtml") or "").strip() or None,
            )

            if self._passes_filters(job):
                jobs.append(job)

        return jobs

    def _ashby_work_type(self, job_data: dict, location: str, title: str) -> str:
        """Prefer Ashby's explicit workplaceType/isRemote, else infer from text."""
        wt = (job_data.get("workplaceType") or "").lower()
        if "remote" in wt:
            return "remote"
        if "hybrid" in wt:
            return "hybrid"
        if "onsite" in wt or "on-site" in wt or "on site" in wt:
            return "onsite"
        if job_data.get("isRemote"):
            return "remote"
        return self._detect_work_type(location, title)

    @staticmethod
    def _ashby_salary(job_data: dict) -> Optional[str]:
        """Extract a salary summary from Ashby, honouring the employer's display flag."""
        if not job_data.get("shouldDisplayCompensationOnJobPostings", False):
            return None
        comp = job_data.get("compensation") or {}
        summary = (
            comp.get("scrapeableCompensationSalarySummary")
            or comp.get("compensationTierSummary")
            or ""
        ).strip()
        return summary[:255] or None

    async def _scrape_smartrecruiters(self, client: httpx.AsyncClient, identifier: str, company_name: str) -> list[ATSJob]:
        """Scrape jobs from SmartRecruiters postings API.

        API: https://api.smartrecruiters.com/v1/companies/{identifier}/postings
        """
        url = f"https://api.smartrecruiters.com/v1/companies/{identifier}/postings"
        # Large employers (e.g. Bosch has 4600+ postings) far exceed one page, so
        # walk the offset instead of only fetching the first 100.
        page_size = SMARTRECRUITERS_PAGE_SIZE
        jobs: list[ATSJob] = []
        offset = 0

        for _ in range(SMARTRECRUITERS_MAX_PAGES):
            try:
                response = await client.get(
                    url, params={"limit": str(page_size), "offset": str(offset)}
                )
                response.raise_for_status()
                data = response.json()
            except (httpx.HTTPError, ValueError) as e:
                # Keep the pages already parsed rather than discarding a whole
                # board because a later page returned an error.
                logger.warning(f"SmartRecruiters page error ({identifier}): {e}")
                break

            content = data.get("content", []) or []
            if not content:
                break

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
                job_url = job_data.get("ref_url", "")
                if not job_url:
                    job_id = job_data.get("id", "")
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

                job = ATSJob(
                    title=title,
                    company=company_name,
                    location=location,
                    url=job_url,
                    posted_date=posted_date,
                    department=department,
                    work_type=self._detect_work_type(location, title),
                )

                if self._passes_filters(job):
                    jobs.append(job)

            offset += page_size
            total = data.get("totalFound")
            if isinstance(total, int) and offset >= total:
                break
            if len(content) < page_size:
                break

        return jobs

    async def _scrape_workday(
        self, client: httpx.AsyncClient, cxs_base: str, company_name: str
    ) -> list[ATSJob]:
        """Scrape jobs from a Workday CXS job board.

        Workday exposes a public JSON search API at ``{cxs_base}/jobs`` where
        ``cxs_base`` is ``https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}``.
        The API caps ``limit`` at 20, so we page in 20s.

        Big-company boards (banks, consulting) are senior-heavy in their default
        listing, so when filtering to entry-level we query Workday's ``searchText``
        with early-career terms (Workday relevance-ranks matches first) and keep
        only titles that pass the strict entry-level filter — far higher yield
        per request than a blind page walk. Without the entry-level filter we
        page the default listing instead. Each posting yields a direct apply link
        built from the site's public front-end host + ``externalPath``.
        """
        apply_base = self._workday_apply_base(cxs_base)
        jobs: list[ATSJob] = []
        seen_paths: set[str] = set()

        if self.filter_entry_level:
            searches, pages_per_search = WORKDAY_ENTRY_SEARCHES, self.workday_search_pages
        else:
            searches, pages_per_search = ("",), self.workday_max_pages

        for search_text in searches:
            for page in range(pages_per_search):
                payload = {
                    "appliedFacets": {},
                    "limit": WORKDAY_PAGE_SIZE,
                    "offset": page * WORKDAY_PAGE_SIZE,
                    "searchText": search_text,
                }
                try:
                    response = await client.post(
                        f"{cxs_base}/jobs", json=payload, headers=WORKDAY_HEADERS
                    )
                    response.raise_for_status()
                    data = response.json()
                except (httpx.HTTPError, ValueError) as e:
                    # Keep whatever we've parsed for this board rather than
                    # discarding it because a later page/search term errored.
                    logger.warning(f"Workday page error ({cxs_base}): {e}")
                    break

                postings = data.get("jobPostings", []) or []
                if not postings:
                    break

                for posting in postings:
                    external_path = (posting.get("externalPath") or "").strip()
                    # A posting can match several search terms / repeat near the
                    # tail; skip ones already seen so we don't double-count.
                    if external_path and external_path in seen_paths:
                        continue
                    if external_path:
                        seen_paths.add(external_path)

                    title = posting.get("title", "")
                    location = posting.get("locationsText", "")
                    job_url = f"{apply_base}{external_path}" if external_path else apply_base

                    job = ATSJob(
                        title=title,
                        company=company_name,
                        location=location,
                        url=job_url,
                        posted_date=self._parse_workday_posted(posting.get("postedOn", "")),
                        department="",
                        work_type=self._detect_work_type(location, title),
                    )
                    if self._passes_filters(job):
                        jobs.append(job)

                # Detect end of THIS search's results from the page itself — a
                # short/last page or reaching `total` — not from dedup. Stopping
                # on an all-duplicates page would abort later search terms early
                # (seen_paths is shared), skipping their deeper, still-new pages.
                total = data.get("total")
                if len(postings) < WORKDAY_PAGE_SIZE:
                    break
                if isinstance(total, int) and (page + 1) * WORKDAY_PAGE_SIZE >= total:
                    break

        return jobs

    @staticmethod
    def _workday_apply_base(cxs_base: str) -> str:
        """Derive the public apply-URL base from a Workday CXS base.

        ``https://host/wday/cxs/{tenant}/{site}`` → ``https://host/{site}``.
        Apply links are then ``{base}{externalPath}`` (Workday redirects to add
        the locale, so no ``/en-US`` prefix is needed).
        """
        marker = "/wday/cxs/"
        idx = cxs_base.find(marker)
        if idx == -1:
            return cxs_base.rstrip("/")
        host = cxs_base[:idx]  # https://{tenant}.{wdN}.myworkdayjobs.com
        tail = cxs_base[idx + len(marker):].strip("/")  # {tenant}/{site}[/...]
        parts = tail.split("/", 1)
        site = parts[1] if len(parts) > 1 else parts[0]
        return f"{host}/{site}"

    @staticmethod
    def _parse_workday_posted(posted_on: str) -> Optional[datetime.datetime]:
        """Convert Workday's relative ``postedOn`` text to an approximate date.

        Handles "Posted Today", "Posted Yesterday", "Posted N Days Ago" and
        "Posted 30+ Days Ago". Returns None when it can't be parsed.
        """
        if not posted_on:
            return None
        text = posted_on.lower()
        # UTC to match scraped_at / the other scrapers (avoid local-clock skew).
        now = datetime.datetime.utcnow()
        if "today" in text:
            return now
        if "yesterday" in text:
            return now - datetime.timedelta(days=1)
        match = re.search(r"(\d+)\+?\s*day", text)
        if match:
            try:
                return now - datetime.timedelta(days=int(match.group(1)))
            except (ValueError, OverflowError):
                return None
        return None

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
        """Detect work arrangement from location/title text.

        Returns the canonical lowercase tokens ("remote"/"hybrid"/"onsite") that
        the listing filter, stats breakdown and the LinkedIn/aggregator path all
        use — NOT "On Site"/"Remote", which wouldn't match the work_type filter.
        """
        combined = f"{location} {title}".lower()
        if "remote" in combined:
            if "hybrid" in combined:
                return "hybrid"
            return "remote"
        if "hybrid" in combined:
            return "hybrid"
        return "onsite"
