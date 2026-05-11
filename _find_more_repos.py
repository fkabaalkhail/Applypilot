"""Find more GitHub repos with direct job apply links."""
import httpx
import asyncio
import re

async def check_repo(owner, repo, file_path="README.md"):
    """Check if a repo has direct company apply URLs (not jobright/simplify redirects)."""
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{file_path}"
    headers = {"Accept": "application/vnd.github.v3.raw"}
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get(url, headers=headers, timeout=15)
        if r.status_code != 200:
            print(f"  {owner}/{repo}: HTTP {r.status_code}")
            return
        
        text = r.text
        lines = text.split("\n")
        table_rows = [l for l in lines if "|" in l and "http" in l]
        
        if not table_rows:
            print(f"  {owner}/{repo}: No table rows with URLs")
            return
        
        # Check what kind of URLs are in the table
        all_urls = re.findall(r'https?://[^\s\)\"<>]+', "\n".join(table_rows[:20]))
        direct = [u for u in all_urls if not any(x in u for x in ["jobright.ai", "simplify.jobs", "github.com", "imgur.com"])]
        jobright = [u for u in all_urls if "jobright.ai" in u]
        
        print(f"  {owner}/{repo}: {len(table_rows)} rows, {len(direct)} direct URLs, {len(jobright)} jobright URLs")
        if direct:
            print(f"    Sample: {direct[0][:100]}")

async def main():
    repos_to_check = [
        ("Ouckah", "Summer2025-Internships"),
        ("vanshb03", "New-Grad-2027"),
        ("ReaVNaiL", "New-Grad-2024"),
        ("owini", "New-Grad-Positions-2025"),
        ("SimplifyJobs", "New-Grad-Positions"),
        ("bsovs", "Fall2025-Internships"),
        ("arunike", "Summer-2025-SWE-Internships"),
        ("speedyapply", "2025-New-Grad-Jobs"),
        ("Sathvik-Rao", "New-Grad-2025"),
    ]
    
    for owner, repo in repos_to_check:
        await check_repo(owner, repo)

asyncio.run(main())
