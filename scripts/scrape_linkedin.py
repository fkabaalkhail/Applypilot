"""
Local LinkedIn scraper — run this from your machine to scrape LinkedIn
and push jobs to your deployed Tailrd API.

Usage:
    python scripts/scrape_linkedin.py
    python scripts/scrape_linkedin.py --city Ottawa
    python scripts/scrape_linkedin.py --city Toronto --query "new grad"

This script:
1. Searches LinkedIn's guest jobs API for intern/new-grad positions
2. Parses job cards from the HTML response
3. Posts each new job to your Tailrd API (deduplicates by URL)
"""

import asyncio
import argparse
import re
import sys
from dataclasses import dataclass
from urllib.parse import quote

import httpx

# Your deployed API base URL
API_BASE = "https://resumate-smoky.vercel.app"

# Canadian cities to search — major metros plus neighbouring / satellite hubs and
# regional centres (kept in sync with backend/services/linkedin_scraper.py).
CITIES = [
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
    ("Kanata", "Ontario"),
    ("Gatineau", "Quebec"),
    ("Hamilton", "Ontario"),
    ("Quebec City", "Quebec"),
    ("Winnipeg", "Manitoba"),
    ("Halifax", "Nova Scotia"),
    ("Victoria", "British Columbia"),
    ("London", "Ontario"),
    ("Guelph", "Ontario"),
    ("Windsor", "Ontario"),
    ("Saskatoon", "Saskatchewan"),
    ("Regina", "Saskatchewan"),
    ("Kelowna", "British Columbia"),
    ("St. John's", "Newfoundland and Labrador"),
    ("Fredericton", "New Brunswick"),
]

# Search queries — one per major job function so non-software roles (finance,
# marketing, HR, sales, data, ops, product, design, consulting) each get their
# own un-truncated LinkedIn search (kept in sync with the backend scraper).
QUERIES = [
    "intern",
    "new grad",
    "co-op",
    "software developer",
    "data analyst",
    "financial analyst",
    "accountant",
    "business analyst",
    "junior consultant",
    "associate product manager",
    "operations analyst",
    "supply chain analyst",
    "marketing coordinator",
    "communications specialist",
    "human resources",
    "sales development representative",
    "ux designer",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass
class Job:
    title: str
    company: str
    location: str
    url: str


def parse_job_cards(html: str) -> list[Job]:
    """Parse job cards from LinkedIn guest API HTML."""
    jobs = []
    cards = html.split('data-entity-urn="urn:li:jobPosting:')

    for card in cards[1:]:
        try:
            title = company = location = url = ""

            # URL
            href_idx = card.find('base-card__full-link')
            if href_idx != -1:
                href_start = card.find('href="', href_idx)
                if href_start != -1:
                    href_start += 6
                    href_end = card.find('"', href_start)
                    raw_url = card[href_start:href_end].replace("&amp;", "&")
                    url = raw_url.split("?")[0]

            # Title
            title_idx = card.find('base-search-card__title')
            if title_idx != -1:
                gt_idx = card.find('>', title_idx)
                if gt_idx != -1:
                    close_idx = card.find('</h3>', gt_idx)
                    if close_idx != -1:
                        raw = card[gt_idx + 1:close_idx]
                        title = re.sub(r'<[^>]+>', '', raw).strip()
                        title = re.sub(r'\s+', ' ', title)

            # Company
            sub_idx = card.find('base-search-card__subtitle')
            if sub_idx != -1:
                a_idx = card.find('<a', sub_idx)
                if a_idx != -1:
                    a_gt = card.find('>', a_idx)
                    if a_gt != -1:
                        a_close = card.find('</a>', a_gt)
                        if a_close != -1:
                            raw = card[a_gt + 1:a_close]
                            company = re.sub(r'<[^>]+>', '', raw).strip()
                            company = re.sub(r'\s+', ' ', company)

            # Location
            loc_idx = card.find('job-search-card__location')
            if loc_idx != -1:
                loc_gt = card.find('>', loc_idx)
                if loc_gt != -1:
                    loc_close = card.find('</span>', loc_gt)
                    if loc_close != -1:
                        raw = card[loc_gt + 1:loc_close]
                        location = re.sub(r'<[^>]+>', '', raw).strip()
                        location = re.sub(r'\s+', ' ', location)

            # Clean entities
            title = title.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')
            company = company.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')

            if title and company and url and "/jobs/view/" in url:
                jobs.append(Job(title=title, company=company, location=location, url=url))
        except Exception:
            continue

    return jobs


async def search_linkedin(client: httpx.AsyncClient, query: str, city: str, province: str) -> list[Job]:
    """Search LinkedIn guest API for a query in a city."""
    location = f"{city}, {province}, Canada"
    url = (
        f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
        f"?keywords={quote(query)}&location={quote(location)}"
        f"&f_E=1%2C2&f_TPR=r604800&start=0"
    )
    try:
        resp = await client.get(url)
        if resp.status_code == 200:
            return parse_job_cards(resp.text)
    except Exception as e:
        print(f"  Error: {e}")
    return []


async def push_job_to_api(client: httpx.AsyncClient, job: Job) -> str:
    """Push a job to the Tailrd API. Returns 'created', 'duplicate', or 'error'."""
    # Determine experience level
    title_lower = job.title.lower()
    if "intern" in title_lower or "co-op" in title_lower or "coop" in title_lower:
        exp_level = "internship"
    else:
        exp_level = "new_grad"

    # Determine work type
    loc_lower = job.location.lower()
    if "remote" in loc_lower:
        work_type = "remote"
    elif "hybrid" in loc_lower:
        work_type = "hybrid"
    else:
        work_type = "onsite"

    # Determine country
    country = "CA"  # Default for Canadian cities
    if any(x in loc_lower for x in ["united states", "usa", ", ca", ", ny", ", tx"]):
        country = "US"

    try:
        resp = await client.post(
            f"{API_BASE}/jobs/create",
            params={
                "title": job.title,
                "company": job.company,
                "location": job.location,
                "url": job.url,
                "source_platform": "linkedin",
                "experience_level": exp_level,
                "work_type": work_type,
                "country": country,
            },
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("status", "error")
        return "error"
    except Exception:
        return "error"


async def main():
    parser = argparse.ArgumentParser(description="Scrape LinkedIn for intern/new-grad jobs")
    parser.add_argument("--city", help="Specific city to scrape (e.g., Ottawa)")
    parser.add_argument("--query", help="Specific search query (e.g., 'intern')")
    args = parser.parse_args()

    cities = CITIES
    queries = QUERIES

    if args.city:
        cities = [(c, p) for c, p in CITIES if c.lower() == args.city.lower()]
        if not cities:
            print(f"City '{args.city}' not found. Available: {[c for c, _ in CITIES]}")
            sys.exit(1)

    if args.query:
        queries = [args.query]

    all_jobs: list[Job] = []
    seen_urls: set[str] = set()

    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=HEADERS) as client:
        for city, province in cities:
            for query in queries:
                print(f"Searching '{query}' in {city}...", end=" ")
                jobs = await search_linkedin(client, query, city, province)
                new = 0
                for job in jobs:
                    if job.url not in seen_urls:
                        seen_urls.add(job.url)
                        all_jobs.append(job)
                        new += 1
                print(f"found {len(jobs)} ({new} new)")
                await asyncio.sleep(2)  # Rate limiting

    print(f"\n{'='*60}")
    print(f"Total unique jobs found: {len(all_jobs)}")
    print(f"{'='*60}")

    # Push jobs to the API
    print(f"\nPushing jobs to {API_BASE}...")
    created = 0
    duplicates = 0
    errors = 0

    async with httpx.AsyncClient(timeout=30) as api_client:
        for job in all_jobs:
            result = await push_job_to_api(api_client, job)
            if result == "created":
                created += 1
            elif result == "duplicate":
                duplicates += 1
            else:
                errors += 1

    print(f"\nResults: {created} created, {duplicates} duplicates, {errors} errors")
    print(f"Total in DB: check {API_BASE}/jobs/stats")


if __name__ == "__main__":
    asyncio.run(main())
