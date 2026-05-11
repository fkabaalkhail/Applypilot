import httpx, asyncio

async def main():
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get("https://api.github.com/users/zapplyjobs/repos?sort=stars&per_page=20")
        for repo in r.json():
            print(f"  {repo['name']} ({repo['stargazers_count']}*) - {(repo.get('description') or '')[:50]}")

asyncio.run(main())
