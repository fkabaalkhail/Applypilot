"""Run the scraper locally for a few companies to populate the DB."""
import sys
import asyncio
import os

sys.path.insert(0, "resumate-scraper")
from dotenv import load_dotenv
load_dotenv()
# DATABASE_URL is read from .env

from scraper.main import ATSScraper

async def main():
    scraper = ATSScraper(
        db_url=os.environ["DATABASE_URL"],
        companies_path="resumate-scraper/scraper/companies.json",
    )
    # Run just 10 Greenhouse companies to test
    companies = scraper.entry_filter  # just to init
    from scraper.registry import load_registry
    all_companies = load_registry("resumate-scraper/scraper/companies.json")
    greenhouse = [c for c in all_companies if c["ats_platform"] == "greenhouse"][:10]
    
    # Manually run just these 10
    from scraper.db import get_session, store_job
    from scraper.clients.greenhouse import GreenhouseClient
    from scraper.services.entry_level_filter import EntryLevelFilter
    from scraper.services.location_filter import LocationFilter
    from scraper.services.category_classifier import CategoryClassifier
    import httpx
    
    ef = EntryLevelFilter()
    lf = LocationFilter()
    cc = CategoryClassifier()
    session = get_session(os.environ["DATABASE_URL"])
    
    total_stored = 0
    async with httpx.AsyncClient(timeout=30) as client:
        gh = GreenhouseClient(client)
        for company in greenhouse:
            try:
                jobs = await gh.scrape_company(company)
                for job in jobs:
                    er = ef.filter(job.title)
                    if not er.is_entry_level:
                        continue
                    lr = lf.filter(job.location)
                    if not lr.is_included:
                        continue
                    cat = cc.classify(job.title, job.department or "")
                    job_data = {
                        "platform": "greenhouse",
                        "title": job.title,
                        "company": job.company,
                        "location": job.location,
                        "url": job.url,
                        "posted_date": job.posted_date.replace(tzinfo=None) if job.posted_date else None,
                        "salary_range": job.salary_range,
                        "company_logo": job.company_logo,
                        "ats_type": "greenhouse",
                        "work_type": lr.work_type,
                        "role_category": cat,
                        "country": lr.country,
                        "experience_level": er.experience_level or "new_grad",
                    }
                    if store_job(session, job_data):
                        total_stored += 1
                print(f"  {company['company_name']}: {len(jobs)} jobs, {total_stored} total stored so far")
            except Exception as e:
                print(f"  {company['company_name']}: ERROR {e}")
            await asyncio.sleep(1)
    
    session.close()
    print(f"\nDone! Total new jobs stored: {total_stored}")

asyncio.run(main())
