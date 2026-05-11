"""Find correct ATS slugs for Canadian tech companies."""
import asyncio
import httpx

# Known Canadian tech companies - try different slug variations
COMPANIES_TO_CHECK = {
    "greenhouse": [
        "shopify", "shopify-careers", "shopifyinc",
        "wealthsimple", "wealthsimpleinc",
        "hootsuite", "hootsuiteinc",
        "clio", "clio-legal", "themis-solutions",
        "1password", "onepassword", "agilebits",
        "freshbooks", "freshbooksinc",
        "ecobee", "ecobeeinc",
        "tophat", "top-hat", "tophatmonocle",
        "tulipretail", "tulip",
        "flipp", "flippcorp",
        "rbc", "royalbank",
        "td", "tdbank",
        "scotiabank",
        "telus", "telusdigital",
        "rogers", "rogerscomm",
        "bell", "bellcanada", "bce",
        "opentext",
        "blackberry",
        "ceridian", "dayforce",
    ],
    "lever": [
        "shopify", "Shopify",
        "wealthsimple", "Wealthsimple",
        "1password", "onepassword", "agilebits",
        "clio", "themissolutions",
        "hootsuite",
        "freshbooks",
        "vidyard",
        "koho", "kohofinancial",
        "ritual", "ritual-co",
        "ada-support", "ada",
        "ecobee",
        "tophat",
        "tulip", "tulipretail",
        "flipp",
        "borrowell",
        "benevity",
        "jobber", "getjobber",
        "procurify",
        "unbounce",
        "thinkific",
        "bench", "benchaccounting",
    ],
}

async def main():
    async with httpx.AsyncClient(timeout=10) as client:
        print("=== GREENHOUSE - Working Canadian slugs ===")
        for slug in COMPANIES_TO_CHECK["greenhouse"]:
            url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
            try:
                r = await client.get(url)
                if r.status_code == 200:
                    data = r.json()
                    count = len(data.get("jobs", []))
                    if count > 0:
                        # Check if any are in Canada
                        ca_jobs = [j for j in data["jobs"] if "canada" in str(j.get("location", {})).lower() or any(p in str(j.get("location", {})) for p in ["ON", "BC", "AB", "QC", "Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary"])]
                        print(f"  FOUND: {slug} -> {count} jobs ({len(ca_jobs)} likely CA)")
            except:
                pass
        
        print("\n=== LEVER - Working Canadian slugs ===")
        for slug in COMPANIES_TO_CHECK["lever"]:
            url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
            try:
                r = await client.get(url)
                if r.status_code == 200:
                    data = r.json()
                    if isinstance(data, list) and len(data) > 0:
                        ca_jobs = [j for j in data if "canada" in str(j.get("categories", {}).get("location", "")).lower() or any(p in str(j.get("categories", {}).get("location", "")) for p in ["ON", "BC", "AB", "QC", "Toronto", "Vancouver", "Montreal", "Ottawa"])]
                        print(f"  FOUND: {slug} -> {len(data)} jobs ({len(ca_jobs)} likely CA)")
            except:
                pass

asyncio.run(main())
