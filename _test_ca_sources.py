"""Test alternative sources for Canadian tech jobs."""
import asyncio
import httpx
import re

async def main():
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        # 1. Check if we can get jobs from the Canadian internship GitHub repo
        print("=== GitHub: negarprh/Canadian-Tech-Internships-2026 ===")
        r = await client.get("https://api.github.com/repos/negarprh/Canadian-Tech-Internships-2026/contents/README.md",
                            headers={"Accept": "application/vnd.github.v3.raw"})
        if r.status_code == 200:
            lines = r.text.split("\n")
            table_rows = [l for l in lines if "|" in l and "http" in l]
            print(f"  {len(table_rows)} job rows found")
        
        # 2. Try Greenhouse boards with Canadian companies we know work
        print("\n=== Greenhouse: hootsuite (26 CA jobs) ===")
        r = await client.get("https://boards-api.greenhouse.io/v1/boards/hootsuite/jobs")
        if r.status_code == 200:
            jobs = r.json().get("jobs", [])
            for j in jobs[:3]:
                loc = j.get("location", {}).get("name", "")
                print(f"  {j['title'][:50]} | {loc}")
        
        # 3. Try Ashby for Canadian companies
        print("\n=== Ashby: Canadian companies ===")
        for slug in ["wealthsimple", "koho", "neo-financial", "clearco"]:
            r = await client.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
            if r.status_code == 200:
                data = r.json()
                jobs = data.get("jobs", [])
                if jobs:
                    print(f"  FOUND: {slug} -> {len(jobs)} jobs")
                    for j in jobs[:2]:
                        print(f"    {j.get('title', '')[:40]} | {j.get('location', '')}")

asyncio.run(main())
