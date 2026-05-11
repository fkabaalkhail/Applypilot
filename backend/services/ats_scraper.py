"""
ATS Scraper — directly polls public ATS (Applicant Tracking System) APIs
for job listings with direct company apply links.

Supported platforms:
- Greenhouse (boards-api.greenhouse.io)
- Lever (api.lever.co)

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
    work_type: Optional[str] = None  # Remote, On Site, Hybrid


# ─── Company → ATS mapping ───────────────────────────────────────────────────
# Each entry: (ats_platform, slug, company_display_name)
# Built from jobright-ai repos + manual verification

ATS_COMPANIES: list[tuple[str, str, str]] = [
    # === Greenhouse companies ===
    ("greenhouse", "affirm", "Affirm"),
    ("greenhouse", "airbnb", "Airbnb"),
    ("greenhouse", "airtable", "Airtable"),
    ("greenhouse", "anthropic", "Anthropic"),
    ("greenhouse", "applovin", "AppLovin"),
    ("greenhouse", "asana", "Asana"),
    ("greenhouse", "astranis", "Astranis"),
    ("greenhouse", "boxinc", "Box"),
    ("greenhouse", "brex", "Brex"),
    ("greenhouse", "chime", "Chime"),
    ("greenhouse", "cloudflare", "Cloudflare"),
    ("greenhouse", "cockroachlabs", "CockroachDB"),
    ("greenhouse", "databricks", "Databricks"),
    ("greenhouse", "datadog", "Datadog"),
    ("greenhouse", "discord", "Discord"),
    ("greenhouse", "dropbox", "Dropbox"),
    ("greenhouse", "duolingo", "Duolingo"),
    ("greenhouse", "elastic", "Elastic"),
    ("greenhouse", "epicgames", "Epic Games"),
    ("greenhouse", "faire", "Faire"),
    ("greenhouse", "figma", "Figma"),
    ("greenhouse", "flexport", "Flexport"),
    ("greenhouse", "gusto", "Gusto"),
    ("greenhouse", "instacart", "Instacart"),
    ("greenhouse", "labelbox", "Labelbox"),
    ("greenhouse", "lattice", "Lattice"),
    ("greenhouse", "lucidmotors", "Lucid Motors"),
    ("greenhouse", "lyft", "Lyft"),
    ("greenhouse", "marqeta", "Marqeta"),
    ("greenhouse", "mongodb", "MongoDB"),
    ("greenhouse", "pinterest", "Pinterest"),
    ("greenhouse", "reddit", "Reddit"),
    ("greenhouse", "robinhood", "Robinhood"),
    ("greenhouse", "roblox", "Roblox"),
    ("greenhouse", "samsara", "Samsara"),
    ("greenhouse", "sofi", "SoFi"),
    ("greenhouse", "spacex", "SpaceX"),
    ("greenhouse", "squarespace", "Squarespace"),
    ("greenhouse", "stripe", "Stripe"),
    ("greenhouse", "toast", "Toast"),
    ("greenhouse", "twilio", "Twilio"),
    ("greenhouse", "vercel", "Vercel"),
    ("greenhouse", "verkada", "Verkada"),
    ("greenhouse", "waymo", "Waymo"),
    ("greenhouse", "webflow", "Webflow"),
    # === Lever companies ===
    ("lever", "anyscale", "Anyscale"),
    ("lever", "gopuff", "GoPuff"),
    ("lever", "neon", "Neon"),
    ("lever", "spotify", "Spotify"),
]


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
    r"\b(i|1)\b",  # Level I/1
    r"\bearly career\b",
    r"\brecent grad\b",
    r"\bgraduate\b",
    r"\brotational\b",
    r"\buniversity\b",
    r"\bcampus\b",
]

ENTRY_LEVEL_PATTERN = re.compile("|".join(ENTRY_LEVEL_KEYWORDS), re.IGNORECASE)


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
]


class ATSScraper:
    """Scrapes job listings from public ATS APIs."""

    def __init__(self, filter_entry_level: bool = True, filter_north_america: bool = True):
        self.filter_entry_level = filter_entry_level
        self.filter_north_america = filter_north_america

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

        return all_jobs

    async def scrape_company(self, platform: str, slug: str, company_name: str) -> list[ATSJob]:
        """Scrape a single company. Returns filtered job list."""
        async with httpx.AsyncClient(timeout=30) as client:
            if platform == "greenhouse":
                return await self._scrape_greenhouse(client, slug, company_name)
            elif platform == "lever":
                return await self._scrape_lever(client, slug, company_name)
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

    def _passes_filters(self, job: ATSJob) -> bool:
        """Check if a job passes the configured filters."""
        if self.filter_entry_level and not self._is_entry_level(job):
            return False
        if self.filter_north_america and not self._is_north_america(job.location):
            return False
        return True

    def _is_entry_level(self, job: ATSJob) -> bool:
        """Check if a job is intern/new-grad/entry-level."""
        text = f"{job.title} {job.department}".lower()
        return bool(ENTRY_LEVEL_PATTERN.search(text))

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
