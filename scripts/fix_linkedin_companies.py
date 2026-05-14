"""
Batch update LinkedIn jobs that have empty company names.
Extracts company name from og:title on the LinkedIn page.
"""
import os
import re
import httpx
import asyncio
from sqlalchemy import create_engine, text

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://neondb_owner:npg_U6g3MnZmGuHD@ep-rapid-wave-aqno7pt9-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require")

engine = create_engine(DATABASE_URL)


async def fix_linkedin_jobs():
    with engine.connect() as conn:
        # Find LinkedIn jobs with missing company names
        result = conn.execute(text("""
            SELECT id, url, company, company_logo FROM scraped_jobs 
            WHERE url LIKE '%linkedin.com/jobs%' 
            AND (company IS NULL OR company = '' OR company = 'Unknown')
            LIMIT 100
        """))
        jobs = result.fetchall()
        print(f"Found {len(jobs)} LinkedIn jobs with missing company names")

        if not jobs:
            print("Nothing to fix!")
            return

        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            for job in jobs:
                job_id, url, company, logo = job
                try:
                    resp = await client.get(url)
                    html = resp.text

                    new_company = None
                    new_logo = None

                    # Extract company from og:title
                    og_match = re.search(
                        r'<meta\s+property="og:title"\s+content="([^"]*)"',
                        html, re.IGNORECASE
                    )
                    if og_match:
                        og_title = og_match.group(1)
                        at_match = re.search(r'\s+at\s+(.+?)(?:\s*\||\s*-|\s*$)', og_title)
                        hiring_match = re.search(r'^(.+?)\s+hiring\s+', og_title)
                        if at_match:
                            new_company = at_match.group(1).strip()
                        elif hiring_match:
                            new_company = hiring_match.group(1).strip()

                    # Generate logo URL from company name
                    if new_company and not logo:
                        cleaned = re.sub(r'[^a-z0-9]', '', new_company.lower())
                        if len(cleaned) >= 2:
                            new_logo = f"https://logos-api.apistemic.com/domain:{cleaned}.com?fallback=404"

                    if new_company:
                        update_sql = "UPDATE scraped_jobs SET company = :company"
                        params = {"company": new_company, "id": job_id}
                        if new_logo:
                            update_sql += ", company_logo = :logo"
                            params["logo"] = new_logo
                        update_sql += " WHERE id = :id"
                        conn.execute(text(update_sql), params)
                        conn.commit()
                        print(f"  ✓ Job {job_id}: {new_company}")
                    else:
                        print(f"  ✗ Job {job_id}: Could not extract company from {url[:60]}")

                except Exception as e:
                    print(f"  ✗ Job {job_id}: Error - {e}")

                await asyncio.sleep(0.5)  # Rate limit

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(fix_linkedin_jobs())
