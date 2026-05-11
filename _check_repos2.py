"""Check Ouckah repo format and find 2026 versions."""
import httpx
import asyncio
import re

async def main():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        # Check Ouckah format
        url = "https://api.github.com/repos/Ouckah/Summer2025-Internships/contents/README.md"
        headers = {"Accept": "application/vnd.github.v3.raw"}
        r = await client.get(url, headers=headers, timeout=15)
        lines = r.text.split("\n")
        
        # Find header row
        for i, line in enumerate(lines):
            if "|" in line and ("company" in line.lower() or "role" in line.lower()):
                print(f"Header: {line}")
                # Print next 5 data rows
                for j in range(i+2, min(i+7, len(lines))):
                    if "|" in lines[j]:
                        print(f"  Row: {lines[j][:250]}")
                break
        
        # Check for 2026 versions
        print("\n\nChecking for 2026 repos...")
        for repo in ["Summer2026-Internships", "New-Grad-2026", "2026-New-Grad"]:
            for owner in ["Ouckah", "cvrve", "SimplifyJobs"]:
                url = f"https://api.github.com/repos/{owner}/{repo}"
                r = await client.get(url, timeout=10)
                if r.status_code == 200:
                    data = r.json()
                    print(f"  FOUND: {owner}/{repo} - {data.get('description', '')[:100]}")
                    print(f"    Stars: {data.get('stargazers_count')}, Updated: {data.get('pushed_at')}")

asyncio.run(main())
