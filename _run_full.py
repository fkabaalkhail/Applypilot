"""Run the full ATS scraper locally."""
import sys, asyncio, os
sys.path.insert(0, "resumate-scraper")
if not os.environ.get("DATABASE_URL"):
    raise SystemExit("Set the DATABASE_URL environment variable before running this script.")

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
