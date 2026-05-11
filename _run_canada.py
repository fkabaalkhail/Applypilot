"""Run scraper for verified Canadian companies."""
import sys, asyncio, os, httpx
sys.path.insert(0, "resumate-scraper")
os.environ["DATABASE_URL"] = "postgresql://neondb_owner:npg_U6g3MnZmGuHD@ep-rapid-wave-aqno7pt9-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require"

from scraper.clients.ashby import AshbyClient
from scraper.clients.greenhouse import GreenhouseClient
from scraper.services.entry_level_filter import EntryLevelFilter
from scraper.services.location_filter import LocationFilter
from scraper.services.category_classifier import CategoryClassifier
from scraper.db import get_session, store_job

ef = EntryLevelFilter()
lf = LocationFilter()
cc = CategoryClassifier()
session = get_session(os.environ["DATABASE_URL"])
total = 0

async def run():
    global total
    async with httpx.AsyncClient(timeout=15) as client:
        ab = AshbyClient(client)
        gh = GreenhouseClient(client)
        
        companies = [
            ("ashby", ab, {"company_name": "Wealthsimple", "board_slug": "wealthsimple", "company_logo_url": "https://www.google.com/s2/favicons?domain=wealthsimple.com&sz=128"}),
            ("ashby", ab, {"company_name": "KOHO", "board_slug": "koho", "company_logo_url": "https://www.google.com/s2/favicons?domain=koho.ca&sz=128"}),
            ("ashby", ab, {"company_name": "Clearco", "board_slug": "clearco", "company_logo_url": "https://www.google.com/s2/favicons?domain=clear.co&sz=128"}),
            ("greenhouse", gh, {"company_name": "Hootsuite", "board_slug": "hootsuite", "company_logo_url": "https://www.google.com/s2/favicons?domain=hootsuite.com&sz=128"}),
            ("greenhouse", gh, {"company_name": "Flipp", "board_slug": "flipp", "company_logo_url": "https://www.google.com/s2/favicons?domain=flipp.com&sz=128"}),
        ]
        
        for platform, scraper_client, company in companies:
            jobs = await scraper_client.scrape_company(company)
            stored = 0
            for j in jobs:
                er = ef.filter(j.title)
                if not er.is_entry_level:
                    continue
                lr = lf.filter(j.location)
                if not lr.is_included:
                    continue
                cat = cc.classify(j.title, j.department or "")
                job_data = {
                    "platform": platform,
                    "title": j.title,
                    "company": j.company,
                    "location": j.location,
                    "url": j.url,
                    "posted_date": j.posted_date.replace(tzinfo=None) if j.posted_date else None,
                    "salary_range": j.salary_range,
                    "company_logo": j.company_logo,
                    "ats_type": platform,
                    "work_type": lr.work_type,
                    "role_category": cat,
                    "country": lr.country,
                    "experience_level": er.experience_level or "new_grad",
                }
                if store_job(session, job_data):
                    stored += 1
                    total += 1
            print(f"  {company['company_name']}: {len(jobs)} found, {stored} new stored (total: {total})")

asyncio.run(run())
session.close()
print(f"\nDone! {total} new jobs stored")
