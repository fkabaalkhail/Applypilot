import sys, asyncio, httpx
sys.path.insert(0, 'resumate-scraper')
from scraper.clients.lever import LeverClient
from scraper.services.entry_level_filter import EntryLevelFilter

async def test():
    f = EntryLevelFilter()
    async with httpx.AsyncClient(timeout=15) as client:
        lv = LeverClient(client)
        jobs = await lv.scrape_company({'company_name': 'Netflix', 'board_slug': 'netflix', 'company_logo_url': ''})
        print(f"Netflix total: {len(jobs)}")
        entry = [j for j in jobs if f.filter(j.title).is_entry_level]
        print(f"Entry-level: {len(entry)}")
        for j in entry:
            print(f"  {j.title} | {j.location}")
        if not entry:
            print("\nSample titles (first 10):")
            for j in jobs[:10]:
                print(f"  {j.title}")

asyncio.run(test())
