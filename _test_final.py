"""Check the new repos AND do a deep dive on jobright apply URLs."""
import httpx
import asyncio
import re
import json

async def check_repo(owner, repo, file_path="README.md"):
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{file_path}"
    headers = {"Accept": "application/vnd.github.v3.raw"}
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get(url, headers=headers, timeout=15)
        if r.status_code != 200:
            # Try .md files in subdirectories
            print(f"  {owner}/{repo}: HTTP {r.status_code} for {file_path}")
            return
        
        text = r.text
        lines = text.split("\n")
        table_rows = [l for l in lines if "|" in l and "http" in l]
        
        all_urls = re.findall(r'https?://[^\s\)\"<>]+', "\n".join(table_rows[:30]))
        direct = [u for u in all_urls if not any(x in u for x in ["jobright.ai", "simplify.jobs", "github.com", "imgur.com"])]
        jobright = [u for u in all_urls if "jobright.ai" in u]
        simplify = [u for u in all_urls if "simplify.jobs" in u]
        
        print(f"\n=== {owner}/{repo} ===")
        print(f"  Total rows: {len(table_rows)}")
        print(f"  Direct URLs: {len(direct)}")
        print(f"  Jobright URLs: {len(jobright)}")
        print(f"  Simplify URLs: {len(simplify)}")
        if direct:
            print(f"  Sample direct: {direct[0][:120]}")
        if table_rows:
            print(f"  Sample row: {table_rows[0][:200]}")

async def test_jobright_apply():
    """Try to find the actual apply URL from jobright by checking their apply endpoint."""
    print("\n\n=== JOBRIGHT DEEP DIVE ===")
    
    job_id = "6a00d94da0eddc08c239d631"
    
    async with httpx.AsyncClient(follow_redirects=False, timeout=15) as client:
        # Try clicking "apply" - check if there's a redirect
        apply_urls = [
            f"https://jobright.ai/jobs/apply/{job_id}",
            f"https://jobright.ai/api/job/{job_id}/apply",
            f"https://jobright.ai/api/v1/jobs/{job_id}/apply-redirect",
            f"https://jobright.ai/jobs/{job_id}/apply",
        ]
        
        for url in apply_urls:
            try:
                r = await client.get(url)
                print(f"  {url}")
                print(f"    Status: {r.status_code}")
                if r.status_code in (301, 302, 307, 308):
                    print(f"    REDIRECT TO: {r.headers.get('location', 'none')}")
                elif r.status_code == 200:
                    # Check for redirect in body
                    body = r.text[:500]
                    if "redirect" in body.lower() or "location" in body.lower():
                        print(f"    Body has redirect: {body[:200]}")
            except Exception as e:
                print(f"  {url}: {e}")
    
    # Also try the full page and look for any hidden apply link
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get(f"https://jobright.ai/jobs/info/{job_id}")
        text = r.text
        
        # Search for any "apply" related URLs in the full page
        apply_patterns = re.findall(r'"(https?://[^"]+)"', text)
        external_apply = [u for u in apply_patterns 
                         if not any(x in u for x in ["jobright.ai", "linkedin.com", "google", "facebook", "schema.org", "w3.org", "licdn"])
                         and any(x in u for x in ["apply", "career", "jobs", "greenhouse", "lever", "workday", "icims", "taleo"])]
        
        if external_apply:
            print(f"\n  FOUND EXTERNAL APPLY URLS:")
            for u in external_apply[:5]:
                print(f"    {u}")
        else:
            print(f"\n  No external apply URLs found in page")
            # Show all external URLs
            external = [u for u in apply_patterns if not any(x in u for x in ["jobright.ai", "linkedin.com", "google", "facebook", "schema.org", "w3.org", "licdn", "cdn"])]
            print(f"  All external URLs ({len(external)}):")
            for u in external[:10]:
                print(f"    {u}")

async def main():
    await check_repo("speedyapply", "2026-SWE-College-Jobs")
    await check_repo("SimplifyJobs", "New-Grad-Positions")
    await check_repo("negarprh", "Canadian-Tech-Internships-2026")
    await test_jobright_apply()

asyncio.run(main())
