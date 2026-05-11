"""Check jobright's intern-list API."""
import httpx
import asyncio
import json

async def main():
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        # Try the minisites-jobs API
        r = await client.get("https://jobright.ai/minisites-jobs/intern")
        print(f"minisites-jobs/intern: status={r.status_code}, content-type={r.headers.get('content-type')}")
        print(f"  Body (first 500): {r.text[:500]}")
        
        # Try with different params
        r2 = await client.get("https://jobright.ai/minisites-jobs/intern?page=1&limit=5")
        print(f"\nWith params: status={r2.status_code}")
        print(f"  Body: {r2.text[:500]}")
        
        # Try POST
        r3 = await client.post("https://jobright.ai/minisites-jobs/intern", json={"page": 1, "limit": 5})
        print(f"\nPOST: status={r3.status_code}")
        print(f"  Body: {r3.text[:500]}")

asyncio.run(main())
