"""Test Canadian job sources."""
import sys, asyncio, httpx
sys.path.insert(0, "resumate-scraper")
from scraper.clients.lever import LeverClient
from scraper.clients.greenhouse import GreenhouseClient
from scraper.services.location_filter import LocationFilter

lf = LocationFilter()

async def test():
    async with httpx.AsyncClient(timeout=15) as client:
        lv = LeverClient(client)
        gh = GreenhouseClient(client)
        
        # Canadian Lever companies
        print("=== LEVER (Canadian companies) ===")
        for slug in ["shopify", "wealthsimple", "1password", "clio", "hootsuite"]:
            jobs = await lv.scrape_company({"company_name": slug.title(), "board_slug": slug, "company_logo_url": ""})
            ca = [j for j in jobs if lf.filter(j.location).country == "CA"]
            us = [j for j in jobs if lf.filter(j.location).country == "US"]
            exc = [j for j in jobs if not lf.filter(j.location).is_included]
            print(f"  {slug}: {len(jobs)} total | CA:{len(ca)} US:{len(us)} Excluded:{len(exc)}")
            if exc:
                samples = [j.location for j in exc[:3]]
                print(f"    Excluded samples: {samples}")
        
        # Try some Greenhouse Canadian companies
        print("\n=== GREENHOUSE (companies with CA offices) ===")
        for slug in ["shopify", "wealthsimple"]:
            jobs = await gh.scrape_company({"company_name": slug.title(), "board_slug": slug, "company_logo_url": ""})
            ca = [j for j in jobs if lf.filter(j.location).country == "CA"]
            print(f"  {slug}: {len(jobs)} total | CA:{len(ca)}")
            if ca:
                print(f"    Sample CA: {ca[0].title} @ {ca[0].location}")

asyncio.run(test())
