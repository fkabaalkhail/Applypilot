"""Check jobright's intern-list API for direct apply URLs."""
import httpx
import asyncio
import json

async def main():
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        # Try the minisites-jobs API
        r = await client.get("https://jobright.ai/minisites-jobs/intern")
        print(f"minisites-jobs/intern: status={r.status_code}")
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list):
                print(f"  Got {len(data)} jobs")
                if data:
                    print(f"  First job keys: {list(data[0].keys())}")
                    print(f"  First job: {json.dumps(data[0], indent=2)[:1000]}")
            elif isinstance(data, dict):
                print(f"  Keys: {list(data.keys())}")
                # Look for jobs array
                for k, v in data.items():
                    if isinstance(v, list) and len(v) > 0:
                        print(f"  {k}: {len(v)} items")
                        if isinstance(v[0], dict):
                            print(f"    First item keys: {list(v[0].keys())[:15]}")
                            # Print URL-like fields
                            for fk, fv in v[0].items():
                                if isinstance(fv, str) and ("http" in fv or "url" in fk.lower() or "link" in fk.lower() or "apply" in fk.lower()):
                                    print(f"    {fk}: {fv[:150]}")
                            print(f"    Full first item: {json.dumps(v[0], indent=2)[:800]}")
                            break
        
        # Try conf endpoint
        r2 = await client.get("https://jobright.ai/api/intern-list/conf")
        print(f"\napi/intern-list/conf: status={r2.status_code}")
        if r2.status_code == 200:
            print(f"  Response: {r2.text[:500]}")

asyncio.run(main())
