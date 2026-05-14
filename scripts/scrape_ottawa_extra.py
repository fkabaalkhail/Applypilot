"""Extra Ottawa-specific scraping with more search queries."""
import asyncio
import sys
sys.path.insert(0, ".")
from scripts.scrape_linkedin import search_linkedin, push_job_to_api, HEADERS, Job
import httpx

API_BASE = "https://www.tailrd.ca"

EXTRA_QUERIES = [
    "software developer co-op",
    "data analyst intern",
    "QA intern",
    "hardware engineer intern",
    "network engineer co-op",
    "cybersecurity intern",
    "machine learning intern",
    "DevOps intern",
    "full stack developer entry",
    "cloud engineer intern",
    "embedded software intern",
    "systems engineer co-op",
    "IT support intern",
    "product manager intern",
    "UX designer intern",
]

async def main():
    all_jobs: list[Job] = []
    seen: set[str] = set()
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=HEADERS) as client:
        for q in EXTRA_QUERIES:
            print(f'Searching "{q}" in Ottawa...', end=" ")
            jobs = await search_linkedin(client, q, "Ottawa", "Ontario")
            new = 0
            for j in jobs:
                if j.url not in seen:
                    seen.add(j.url)
                    all_jobs.append(j)
                    new += 1
            print(f"found {len(jobs)} ({new} new)")
            await asyncio.sleep(2)

    print(f"\nTotal: {len(all_jobs)} unique jobs")

    # Push to API
    created = dupes = errors = 0
    async with httpx.AsyncClient(timeout=30) as api:
        for job in all_jobs:
            result = await push_job_to_api(api, job)
            if result == "created":
                created += 1
            elif result == "duplicate":
                dupes += 1
            else:
                errors += 1
    print(f"Results: {created} created, {dupes} duplicates, {errors} errors")

if __name__ == "__main__":
    asyncio.run(main())
