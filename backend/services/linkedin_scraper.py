"""
LinkedIn Public Job Scraper — uses LinkedIn's guest jobs API to find
intern/new-grad/co-op positions in major Canadian cities.

The guest API at /jobs-guest/jobs/api/seeMoreJobPostings/search returns
server-rendered HTML with job cards that can be parsed without JavaScript.

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
}


class LinkedInScraper:
    """Scrapes job listings from LinkedIn's guest jobs API."""

    def __init__(self, request_delay: float = 2.0):
        self.request_delay = request_delay

    async def scrape_all(self) -> list[LinkedInJob]:
        """Search all city/query combinations and return deduplicated jobs."""
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
                        jobs = await self._search(client, query, city, province)
                        for job in jobs:
                            if job.url not in seen_urls:
                                seen_urls.add(job.url)
                                all_jobs.append(job)
                        logger.info(f"LinkedIn '{query}' in {city}: {len(jobs)} jobs")
                    except Exception as e:
                        logger.warning(f"Error '{query}' in {city}: {e}")

                    await asyncio.sleep(self.request_delay)

        logger.info(f"LinkedIn scraper total: {len(all_jobs)} unique jobs")
        return all_jobs

    async def scrape_city(self, city: str, province: str) -> list[LinkedInJob]:
        """Search a single city across all queries."""
        all_jobs: list[LinkedInJob] = []
        seen_urls: set[str] = set()

        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers=HEADERS,
        ) as client:
            for query in QUERIES:
                try:
                    jobs = await self._search(client, query, city, province)
                    for job in jobs:
                        if job.url not in seen_urls:
                            seen_urls.add(job.url)
                            all_jobs.append(job)
                except Exception as e:
                    logger.warning(f"Error '{query}' in {city}: {e}")
                await asyncio.sleep(self.request_delay)

        return all_jobs

    async def scrape_single(self, query: str, city: str, province: str) -> list[LinkedInJob]:
        """Run a single search query for a single city (fast, fits serverless timeout)."""
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers=HEADERS,
        ) as client:
            return await self._search(client, query, city, province)

    async def _search(
        self,
        client: httpx.AsyncClient,
        query: str,
        city: str,
        province: str,
    ) -> list[LinkedInJob]:
        """Search LinkedIn guest API for jobs in a city."""
        location = f"{city}, {province}, Canada"
        url = (
            f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
            f"?keywords={quote(query)}"
            f"&location={quote(location)}"
            f"&f_E=1%2C2"
            f"&f_TPR=r604800"
            f"&start=0"
        )

        response = await client.get(url)
        if response.status_code != 200:
            return []

        html = response.text
        return self._parse_job_cards(html)

    def _parse_job_cards(self, html: str) -> list[LinkedInJob]:
        """Parse job cards from LinkedIn guest API HTML response."""
        jobs: list[LinkedInJob] = []

        # Split into individual job card blocks using the unique job posting URN
        cards = html.split('data-entity-urn="urn:li:jobPosting:')

        for card in cards[1:]:  # Skip first empty split
            try:
                title = ""
                company = ""
                location = ""
                url = ""

                # Extract URL - find href with /jobs/view/
                href_idx = card.find('base-card__full-link')
                if href_idx != -1:
                    href_start = card.find('href="', href_idx)
                    if href_start != -1:
                        href_start += 6
                        href_end = card.find('"', href_start)
                        raw_url = card[href_start:href_end].replace("&amp;", "&")
                        url = raw_url.split("?")[0]

                # Extract title - find base-search-card__title
                title_idx = card.find('base-search-card__title')
                if title_idx != -1:
                    # Find the > after the class attribute
                    gt_idx = card.find('>', title_idx)
                    if gt_idx != -1:
                        # Find closing </h3>
                        close_idx = card.find('</h3>', gt_idx)
                        if close_idx != -1:
                            raw_title = card[gt_idx + 1:close_idx]
                            # Strip HTML tags and whitespace
                            title = re.sub(r'<[^>]+>', '', raw_title).strip()
                            title = re.sub(r'\s+', ' ', title)

                # Extract company - find base-search-card__subtitle then the <a> inside
                sub_idx = card.find('base-search-card__subtitle')
                if sub_idx != -1:
                    a_idx = card.find('<a', sub_idx)
                    if a_idx != -1:
                        a_gt = card.find('>', a_idx)
                        if a_gt != -1:
                            a_close = card.find('</a>', a_gt)
                            if a_close != -1:
                                raw_company = card[a_gt + 1:a_close]
                                company = re.sub(r'<[^>]+>', '', raw_company).strip()
                                company = re.sub(r'\s+', ' ', company)

                # Extract location - find job-search-card__location
                loc_idx = card.find('job-search-card__location')
                if loc_idx != -1:
                    loc_gt = card.find('>', loc_idx)
                    if loc_gt != -1:
                        loc_close = card.find('</span>', loc_gt)
                        if loc_close != -1:
                            raw_loc = card[loc_gt + 1:loc_close]
                            location = re.sub(r'<[^>]+>', '', raw_loc).strip()
                            location = re.sub(r'\s+', ' ', location)

                # Clean HTML entities
                title = title.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
                company = company.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')

                if title and company and url and "/jobs/view/" in url:
                    jobs.append(LinkedInJob(
                        title=title,
                        company=company,
                        location=location,
                        url=url,
                    ))
            except Exception:
                continue

        return jobs
