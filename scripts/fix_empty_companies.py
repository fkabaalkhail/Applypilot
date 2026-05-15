"""Fix all jobs with empty/null company names by fetching from LinkedIn."""
import os
import re
import asyncio
import httpx
from sqlalchemy import create_engine, text

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://neondb_owner:npg_U6g3MnZmGuHD@ep-rapid-wave-aqno7pt9-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require")
engine = create_engine(DATABASE_URL)


async def fix():
    with engine.connect() as conn:
        # Find jobs with empty company names
        result = conn.execute(text("""
            SELECT id, url, company FROM scraped_jobs 
            WHERE (company IS NULL OR company = '' OR company = 'Unknown')
            ORDER BY id DESC
            LIMIT 200
        """))
        jobs = result.fetchall()
        print(f"Found {len(jobs)} jobs with empty company names")

        if not jobs:
            print("Nothing to fix!")
            return

        fixed = 0
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            for job in jobs:
                job_id, url, company = job
                if not url or "linkedin.com" not in url:
                    # For non-LinkedIn jobs, try to extract from URL
                    if url and "greenhouse.io" in url:
                        match = re.search(r'boards\.greenhouse\.io/([^/]+)', url)
                        if match:
                            name = match.group(1).replace("-", " ").title()
                            conn.execute(text("UPDATE scraped_jobs SET company = :name WHERE id = :id"), {"name": name, "id": job_id})
                            conn.commit()
                            fixed += 1
                            print(f"  ✓ {job_id}: {name} (from greenhouse URL)")
                    continue

                try:
                    resp = await client.get(url)
                    html = resp.text

                    new_company = None

                    # Try og:title
                    og_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]*)"', html, re.IGNORECASE)
                    if og_match:
                        og_title = og_match.group(1)
                        at_match = re.search(r'\s+at\s+(.+?)(?:\s*\||\s*-|\s*$)', og_title)
                        hiring_match = re.search(r'^(.+?)\s+hiring\s+', og_title)
                        if at_match:
                            new_company = at_match.group(1).strip()
                        elif hiring_match:
                            new_company = hiring_match.group(1).strip()

                    # Try topcard company name
                    if not new_company:
                        company_match = re.search(r'class="[^"]*topcard[^"]*org-name[^"]*"[^>]*>([^<]+)<', html, re.IGNORECASE)
                        if company_match:
                            new_company = company_match.group(1).strip()

                    if new_company and len(new_company) > 1:
                        # Also set logo
                        cleaned = re.sub(r'[^a-z0-9]', '', new_company.lower())
                        logo = f"https://logos-api.apistemic.com/domain:{cleaned}.com?fallback=404" if len(cleaned) >= 2 else None
                        
                        params = {"name": new_company, "id": job_id}
                        sql = "UPDATE scraped_jobs SET company = :name"
                        if logo:
                            sql += ", company_logo = :logo"
                            params["logo"] = logo
                        sql += " WHERE id = :id"
                        conn.execute(text(sql), params)
                        conn.commit()
                        fixed += 1
                        print(f"  ✓ {job_id}: {new_company}")
                    else:
                        print(f"  ✗ {job_id}: Could not extract from {url[:50]}")

                except Exception as e:
                    print(f"  ✗ {job_id}: Error - {str(e)[:50]}")

                await asyncio.sleep(0.3)

    print(f"\nDone! Fixed {fixed} jobs.")


if __name__ == "__main__":
    asyncio.run(fix())
