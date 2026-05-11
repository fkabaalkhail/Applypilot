"""Search for GitHub repos with direct job posting links."""
import httpx
import asyncio
import re
import json

async def main():
    async with httpx.AsyncClient(timeout=15) as client:
        # Search for 2026 new grad repos
        r = await client.get(
            "https://api.github.com/search/repositories?q=2026+new+grad+jobs&sort=stars&order=desc"
        )
        data = r.json()
        print("Top 2026 job repos:")
        for item in data.get("items", [])[:15]:
            name = item["full_name"]
            stars = item["stargazers_count"]
            desc = (item.get("description") or "")[:60]
            print(f"  {name} ({stars}*) - {desc}")

        # Check SimplifyJobs repos
        print("\n\nSimplifyJobs repos:")
        r2 = await client.get("https://api.github.com/users/SimplifyJobs/repos?sort=updated&per_page=10")
        for repo in r2.json():
            print(f"  {repo['name']} ({repo['stargazers_count']}*)")

        # Check the most popular one - SimplifyJobs New-Grad-Positions
        print("\n\nChecking SimplifyJobs/New-Grad-Positions README...")
        headers = {"Accept": "application/vnd.github.v3.raw"}
        try:
            r3 = await client.get(
                "https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/contents/README.md",
                headers=headers
            )
            text = r3.text[:3000]
            print(text[:2000])
        except Exception as e:
            print(f"  Error: {e}")

        # Check if there's a .simplify JSON data file
        print("\n\nChecking for data files...")
        try:
            r4 = await client.get(
                "https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/contents/"
            )
            files = r4.json()
            for f in files:
                print(f"  {f['name']} ({f['type']})")
        except Exception as e:
            print(f"  Error: {e}")

asyncio.run(main())
