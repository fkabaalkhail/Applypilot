"""Run the full ATS scraper locally."""
import sys, asyncio, os
sys.path.insert(0, "resumate-scraper")
os.environ["DATABASE_URL"] = "postgresql://neondb_owner:npg_U6g3MnZmGuHD@ep-rapid-wave-aqno7pt9-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require"

from scraper.main import ATSScraper

async def main():
    scraper = ATSScraper(
        db_url=os.environ["DATABASE_URL"],
        companies_path="resumate-scraper/scraper/companies.json",
    )
    stats = await scraper.run()
    print(f"\n{'='*60}")
    print(f"FINAL RESULTS:")
    print(f"  Companies: {stats.companies_succeeded}/{stats.total_companies} succeeded")
    print(f"  Jobs found: {stats.total_jobs_found}")
    print(f"  New stored: {stats.new_jobs_stored}")
    print(f"  Duplicates: {stats.duplicates_skipped}")
    print(f"{'='*60}")

asyncio.run(main())
