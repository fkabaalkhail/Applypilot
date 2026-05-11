"""Check how intern-list.com sources their jobs."""
import httpx
import asyncio
import re
import json

async def main():
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get("https://www.intern-list.com/")
        text = r.text
        
        # Check for API calls, data sources
        print(f"Page size: {len(text)} chars")
        
        # Look for API endpoints or data URLs
        api_urls = re.findall(r'(https?://[^"\']+(?:api|jobs|listings)[^"\']*)', text[:50000])
        print(f"\nAPI/job URLs found: {len(api_urls)}")
        for u in api_urls[:10]:
            print(f"  {u}")
        
        # Look for job links to see where they point
        job_links = re.findall(r'href="(https?://[^"]+)"', text)
        external = [u for u in job_links if "intern-list" not in u][:20]
        print(f"\nExternal links ({len(external)}):")
        for u in external[:15]:
            print(f"  {u[:120]}")
        
        # Check for __NEXT_DATA__ or similar
        next_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', text, re.DOTALL)
        if next_match:
            data = json.loads(next_match.group(1))
            print(f"\n__NEXT_DATA__ found, keys: {list(data.keys())}")
            props = data.get("props", {}).get("pageProps", {})
            print(f"pageProps keys: {list(props.keys())[:10]}")
            # Look for jobs data
            if "jobs" in props:
                jobs = props["jobs"]
                if isinstance(jobs, list) and jobs:
                    print(f"\nFound {len(jobs)} jobs in pageProps")
                    print(f"First job keys: {list(jobs[0].keys())}")
                    print(f"First job: {json.dumps(jobs[0], indent=2)[:500]}")
            # Check all keys for job-like data
            for k, v in props.items():
                if isinstance(v, list) and len(v) > 5:
                    print(f"\n  List field '{k}': {len(v)} items")
                    if v and isinstance(v[0], dict):
                        print(f"    First item keys: {list(v[0].keys())[:10]}")
                        # Show URL fields
                        for fk, fv in v[0].items():
                            if isinstance(fv, str) and ("http" in fv or "url" in fk.lower() or "link" in fk.lower()):
                                print(f"    {fk}: {fv[:100]}")

asyncio.run(main())
