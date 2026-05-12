"""Debug LinkedIn response."""
import asyncio, httpx
from urllib.parse import quote_plus

async def test():
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={quote_plus('intern software')}&location={quote_plus('Ottawa, Ontario, Canada')}&geoId=100913886&f_TPR=r86400&f_E=1%2C2&start=0"
    
    print(f"URL: {url}")
    
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        r = await client.get(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        })
        print(f"Status: {r.status_code}")
        print(f"Content length: {len(r.text)}")
        print(f"First 500 chars: {r.text[:500]}")
        
        # Check for job-related content
        if "base-card" in r.text:
            print("\nFound base-card elements!")
        if "base-search-card__title" in r.text:
            print("Found job titles!")
        if "linkedin.com/jobs/view" in r.text:
            import re
            links = re.findall(r'href="(https://www\.linkedin\.com/jobs/view/[^"?]+)', r.text)
            print(f"Found {len(links)} job links")
            for l in links[:3]:
                print(f"  {l}")

asyncio.run(test())
