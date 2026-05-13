"""
LinkedIn Public Job Scraper — searches LinkedIn's public job search pages
for intern/new-grad/co-op positions in major Canadian cities.

Extracts job listings from public (non-authenticated) LinkedIn search results
and individual job pages. No login required — uses the public job board.

Search parameters:
- f_E=1,2 → Entry level + Internship experience levels
- f_TPR=r604800 → Posted in the past week
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


@dataclass
class LinkedInJob:
    """A job listing extracted from LinkedIn public pages."""
    title: str
    company: str
    location: str
    url: str


# Canadian cities to search (city, province)
CITIES: list[tuple[str, str]] = [
    ("Ottawa", "Ontario"),
    ("Toronto", "Ontario"),
    ("Vancouver", "British Columbia"),
    ("Montreal", "Quebec"),
    ("Calgary", "Alberta"),
    ("Edmonton", "Alberta"),
    ("Waterloo", "Ontario"),
    ("Kitchener", "Ontario"),
    ("Mississauga", "Ontario"),
    ("Markham", "Ontario"),
]

# Search queries targeting entry-level positions
QUERIES: list[str] = [
    "intern",
    "new grad",
    "co-op",
    "entry level software engineer",
    "entry level developer",
]

# Headers to mimic a browser request
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

# Regex to extract job IDs from search results
JOB_ID_PATTERN = re.compile(r"jobs/view/(\d+)")

# Max jobs to process per search query (LinkedIn shows ~25 per page)
MAX_JOBS_PER_QUERY = 25


class LinkedInScraper:
    """Scrapes job listings from LinkedIn's public job search pages."""

    def __init__(self, request_delay: float = 2.5):
        """Initialize scraper.

        Args:
            request_delay: Seconds to wait between requests (avoid rate limiting).
        """
        self.request_delay = request_delay

    async def scrape_all(self) -> list[LinkedInJob]:
        """Search all city/query combinations and return deduplicated jobs.

        Returns:
            List of LinkedInJob objects extracted from public pages.
        """
        all_jobs: list[LinkedInJob] = []
        seen_urls: set[str] = set()

        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers=HEADERS,
        ) as client:
            for city, province in CITIES:
                for query in QUERIES:
                    try:
                        jobs = await self._search_city_query(client, query, city, province)
                        for job in jobs:
                            if job.url not in seen_urls:
                                seen_urls.add(job.url)
                                all_jobs.append(job)

                        logger.info(
                            f"LinkedIn search '{query}' in {city}: "
                            f"found {len(jobs)} jobs"
                        )
                    except httpx.HTTPStatusError as e:
                        logger.warning(
                            f"HTTP {e.response.status_code} searching "
                            f"'{query}' in {city}"
                        )
                    except httpx.TimeoutException:
                        logger.warning(f"Timeout searching '{query}' in {city}")
                    except Exception as e:
                        logger.warning(
                            f"Error searching '{query}' in {city}: {e}"
                        )

                    # Rate limiting delay between searches
                    await asyncio.sleep(self.request_delay)

        logger.info(f"LinkedIn scraper total: {len(all_jobs)} unique jobs")
        return all_jobs

    async def _search_city_query(
        self,
        client: httpx.AsyncClient,
        query: str,
        city: str,
        province: str,
    ) -> list[LinkedInJob]:
        """Search LinkedIn for a specific query in a specific city.

        Args:
            client: HTTP client to use.
            query: Search keywords (e.g., "intern", "new grad").
            city: City name (e.g., "Ottawa").
            province: Province name (e.g., "Ontario").

        Returns:
            List of LinkedInJob objects from this search.
        """
        # Build the public search URL
        encoded_query = quote(query)
        location_str = f"{city}, {province}, Canada"
        encoded_location = quote(location_str)

        search_url = (
            f"https://www.linkedin.com/jobs/search"
            f"?keywords={encoded_query}"
            f"&location={encoded_location}"
            f"&f_E=1%2C2"
            f"&f_TPR=r604800"
        )

        # Fetch search results page
        response = await client.get(search_url)
        response.raise_for_status()

        html = response.text

        # Extract job IDs from the search results
        job_ids = JOB_ID_PATTERN.findall(html)
        # Deduplicate and limit
        unique_ids = list(dict.fromkeys(job_ids))[:MAX_JOBS_PER_QUERY]

        jobs: list[LinkedInJob] = []
        for job_id in unique_ids:
            try:
                job = await self._fetch_job_details(client, job_id)
                if job:
                    jobs.append(job)
            except Exception as e:
                logger.debug(f"Failed to fetch job {job_id}: {e}")

            # Small delay between individual job fetches
            await asyncio.sleep(self.request_delay)

        return jobs

    async def _fetch_job_details(
        self,
        client: httpx.AsyncClient,
        job_id: str,
    ) -> Optional[LinkedInJob]:
        """Fetch a single job's public page and extract details.

        Uses the og:title meta tag which has format:
        "Company hiring Title in Location | LinkedIn"

        Args:
            client: HTTP client to use.
            job_id: LinkedIn job ID.

        Returns:
            LinkedInJob if extraction succeeds, None otherwise.
        """
        job_url = f"https://www.linkedin.com/jobs/view/{job_id}"

        response = await client.get(job_url)
        response.raise_for_status()

        html = response.text

        # Extract og:title meta tag
        og_title_match = re.search(
            r'<meta\s+(?:property="og:title"|content="([^"]+)"\s+property="og:title"|property="og:title"\s+content="([^"]+)")',
            html,
        )
        if not og_title_match:
            # Try alternate pattern
            og_title_match = re.search(
                r'content="([^"]+)"\s*(?:property|name)="og:title"',
                html,
            )
            if not og_title_match:
                og_title_match = re.search(
                    r'(?:property|name)="og:title"\s*content="([^"]+)"',
                    html,
                )

        if not og_title_match:
            logger.debug(f"No og:title found for job {job_id}")
            return None

        # Get the matched content from whichever group matched
        og_title = next(
            (g for g in og_title_match.groups() if g is not None), None
        )
        if not og_title:
            return None

        # Parse og:title format: "Company hiring Title in Location | LinkedIn"
        parsed = self._parse_og_title(og_title)
        if not parsed:
            return None

        company, title, location = parsed

        return LinkedInJob(
            title=title,
            company=company,
            location=location,
            url=job_url,
        )

    def _parse_og_title(self, og_title: str) -> Optional[tuple[str, str, str]]:
        """Parse LinkedIn og:title into (company, title, location).

        Expected format: "Company hiring Title in Location | LinkedIn"

        Args:
            og_title: The og:title meta tag content.

        Returns:
            Tuple of (company, title, location) or None if parsing fails.
        """
        # Remove " | LinkedIn" suffix
        cleaned = re.sub(r"\s*\|\s*LinkedIn\s*$", "", og_title).strip()

        # Split on " hiring "
        if " hiring " not in cleaned:
            return None

        parts = cleaned.split(" hiring ", 1)
        if len(parts) != 2:
            return None

        company = parts[0].strip()
        remainder = parts[1].strip()

        # Split remainder on " in " (last occurrence for location)
        if " in " in remainder:
            # Use last " in " to handle titles containing "in"
            last_in_idx = remainder.rfind(" in ")
            title = remainder[:last_in_idx].strip()
            location = remainder[last_in_idx + 4:].strip()
        else:
            title = remainder
            location = ""

        if not company or not title:
            return None

        return company, title, location
