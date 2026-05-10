"""Quick test to find the actual apply URL from a jobright page."""
import httpx
import asyncio
import re
import json

async def main():
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        r = await client.get("https://jobright.ai/jobs/info/6a00d94da0eddc08c239d631")
    text = r.text
    
    # Find schema.org JobPosting
    match = re.search(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', text, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(1))
            print("Schema.org data:")
            print(json.dumps(data, indent=2)[:2000])
        except Exception as e:
            print(f"Parse error: {e}")
    
    # Find __NEXT_DATA__ or similar
    next_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', text, re.DOTALL)
    if next_match:
        try:
            data = json.loads(next_match.group(1))
            job_result = data.get("props", {}).get("pageProps", {}).get("dataSource", {}).get("jobResult", {})
            print("\n\nJob Result keys:", list(job_result.keys())[:30])
            # Print any field with 'url' or 'link' or 'apply' in the name
            for k, v in job_result.items():
                if any(x in k.lower() for x in ["url", "link", "apply", "source", "redirect"]):
                    print(f"  {k}: {v}")
        except Exception as e:
            print(f"Next data parse error: {e}")

asyncio.run(main())
