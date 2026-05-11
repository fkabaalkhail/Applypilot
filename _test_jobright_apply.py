"""Test extracting the actual apply URL from a jobright page."""
import httpx
import asyncio
import re
import json

async def main():
    # Use a known jobright job URL
    job_url = "https://jobright.ai/jobs/info/6a00d94da0eddc08c239d631"
    
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get(job_url)
        text = r.text
    
    # Extract __NEXT_DATA__
    next_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', text, re.DOTALL)
    if next_match:
        data = json.loads(next_match.group(1))
        job_result = data.get("props", {}).get("pageProps", {}).get("dataSource", {}).get("jobResult", {})
        
        print("All job fields:")
        for k, v in job_result.items():
            if isinstance(v, str) and len(v) < 200:
                print(f"  {k}: {v}")
            elif isinstance(v, (bool, int, float)):
                print(f"  {k}: {v}")
        
        # Check for any URL-like fields
        print("\n\nLooking for apply/source URLs...")
        for k, v in job_result.items():
            if isinstance(v, str) and ("http" in v or "url" in k.lower() or "link" in k.lower() or "apply" in k.lower()):
                print(f"  {k}: {v}")
    
    # Also check if there's an API endpoint for getting the apply URL
    # Try the jobright API directly
    job_id = "6a00d94da0eddc08c239d631"
    api_urls = [
        f"https://jobright.ai/api/job/{job_id}",
        f"https://jobright.ai/api/jobs/{job_id}",
        f"https://jobright.ai/api/v1/job/{job_id}",
    ]
    
    async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
        for api_url in api_urls:
            try:
                r = await client.get(api_url)
                if r.status_code == 200:
                    print(f"\n\nAPI HIT: {api_url}")
                    data = r.json()
                    print(json.dumps(data, indent=2)[:2000])
            except Exception as e:
                print(f"  {api_url}: {e}")

asyncio.run(main())
