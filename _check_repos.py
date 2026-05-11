"""Check GitHub job repos for direct apply URLs."""
import httpx
import asyncio
import re

async def check_repo(owner, repo, file_path="README.md"):
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{file_path}"
    headers = {"Accept": "application/vnd.github.v3.raw"}
    async with httpx.AsyncClient(follow_redirects=True) as client:
        r = await client.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            lines = r.text.split("\n")
            # Find table rows with URLs
            table_lines = [l for l in lines if "|" in l and "http" in l][:5]
            print(f"\n=== {owner}/{repo} ({file_path}) ===")
            print(f"Total table rows with URLs: {len([l for l in lines if '|' in l and 'http' in l])}")
            for l in table_lines:
                # Extract URLs from the line
                urls = re.findall(r'https?://[^\s\)\"]+', l)
                non_github = [u for u in urls if "github.com" not in u and "simplify.jobs" not in u]
                print(f"  URLs: {non_github[:3]}")
        else:
            print(f"{owner}/{repo}: HTTP {r.status_code}")

async def main():
    await check_repo("SimplifyJobs", "New-Grad-Positions")
    await check_repo("SimplifyJobs", "Summer2026-Internships")
    await check_repo("pittcsc", "Summer2025-Internships")
    await check_repo("Ouckah", "Summer2025-Internships")
    await check_repo("cvrve", "Summer2025-Internships")

asyncio.run(main())
