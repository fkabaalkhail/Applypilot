"""Test LinkedIn public job search scraper."""
import sys, asyncio, httpx
sys.path.insert(0, "resumate-scraper")
from scraper.clients.linkedin import LinkedInClient

async def test():
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        li = LinkedInClient(client)
        # Test one search
        jobs = await li._scrape_search(
            keywords="intern software",
            location="Ottawa, Ontario, Canada",
            geo_id="100913886",
            max_pages=1,
        )
        print(f"Ottawa intern software: {len(jobs)} jobs found")
        for j in jobs[:5]:
            print(f"  {j.title} | {j.company} | {j.location} | {j.url[:60]}")

asyncio.run(test())
