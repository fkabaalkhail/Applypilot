"""Debug LinkedIn HTML parsing."""
import asyncio, httpx, re
from urllib.parse import quote_plus

async def test():
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={quote_plus('intern software')}&location={quote_plus('Canada')}&geoId=101174742&f_TPR=r86400&f_E=1%2C2&start=0"
    
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        r = await client.get(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html",
        })
        html = r.text
        print(f"Status: {r.status_code}, Length: {len(html)}")
        
        # Find all job URLs (they use different patterns)
        all_urls = re.findall(r'href="([^"]*jobs[^"]*)"', html)
        print(f"\nAll job-related URLs ({len(all_urls)}):")
        for u in all_urls[:5]:
            print(f"  {u}")
        
        # Find titles
        titles = re.findall(r'base-search-card__title[^"]*"[^>]*>\s*([^<]+)', html)
        print(f"\nTitles ({len(titles)}):")
        for t in titles[:5]:
            print(f"  {t.strip()}")
        
        # Find companies
        companies = re.findall(r'base-search-card__subtitle[^"]*"[^>]*>\s*\n\s*([^\n<]+)', html)
        print(f"\nCompanies ({len(companies)}):")
        for c in companies[:5]:
            print(f"  {c.strip()}")
        
        # Find locations
        locations = re.findall(r'job-search-card__location[^"]*"[^>]*>\s*([^<]+)', html)
        print(f"\nLocations ({len(locations)}):")
        for l in locations[:5]:
            print(f"  {l.strip()}")
        
        # Find entity URNs (job IDs)
        urns = re.findall(r'data-entity-urn="urn:li:jobPosting:(\d+)"', html)
        print(f"\nJob IDs ({len(urns)}):")
        for u in urns[:5]:
            print(f"  https://www.linkedin.com/jobs/view/{u}")

asyncio.run(test())
