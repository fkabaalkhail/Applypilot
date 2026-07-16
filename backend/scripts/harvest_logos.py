"""
One-time exhaustive logo harvest for every domain still on a tiny favicon.

Same sources and guards as the hourly cron (homepage icons → Wikidata P154,
byte-verified >= 64px); the cron's 8-domains-per-run then only maintains new
companies. Failure writes the sz=256 favicon sentinel = "probed, favicon-only".

Usage:
    DATABASE_URL=postgres://... python backend/scripts/harvest_logos.py [--limit N]
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from backend.db.database import engine  # noqa: E402
from backend.services.logo_harvester import harvest_logo  # noqa: E402

UNPROBED_SQL = (
    "company_logo IS NULL OR company_logo = '' "
    "OR company_logo LIKE '%google.com/s2/favicons%sz=128%' "
    "OR company_logo LIKE '%icon.horse%' OR company_logo LIKE '%apistemic%'"
)

# --sentinels mode: re-probe domains previously marked favicon-only (sz=256).
# Useful after transient Wikidata/Commons rate limiting marked real-logo
# companies as favicon-only.
SENTINEL_SQL = "company_logo LIKE '%google.com/s2/favicons%sz=256%'"


async def main(limit: int, target_sql: str = UNPROBED_SQL) -> None:
    with engine.connect() as conn:
        domains = conn.execute(text(
            f"SELECT company_domain, count(*) AS n, max(company) AS company "
            f"FROM scraped_jobs WHERE ({target_sql}) "
            f"AND company_domain IS NOT NULL AND company_domain <> '' "
            f"GROUP BY company_domain ORDER BY n DESC LIMIT :lim"
        ), {"lim": limit}).fetchall()
    print(f"domains to probe: {len(domains)}")

    harvested = probed = 0
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        for row in domains:
            domain, company = row.company_domain, row.company or ""
            try:
                logo = await harvest_logo(client, domain, company)
            except Exception:
                logo = ""
            new_logo = logo or f"https://www.google.com/s2/favicons?domain={domain}&sz=256"
            with engine.begin() as conn:
                conn.execute(text(
                    f"UPDATE scraped_jobs SET company_logo = :logo "
                    f"WHERE company_domain = :domain AND ({target_sql})"
                ), {"logo": new_logo, "domain": domain})
            probed += 1
            if logo:
                harvested += 1
                print(f"  [{probed}/{len(domains)}] {domain}: {logo[:80]}")
            if probed % 50 == 0:
                print(f"  progress: {probed} probed, {harvested} real logos")
            await asyncio.sleep(0.2)  # be polite to Wikidata/Commons
    print(f"done: {probed} domains probed, {harvested} real logos harvested")


if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL", ""):
        sys.exit("DATABASE_URL is required")
    lim = 4000
    if "--limit" in sys.argv:
        lim = int(sys.argv[sys.argv.index("--limit") + 1])
    sql = SENTINEL_SQL if "--sentinels" in sys.argv else UNPROBED_SQL
    asyncio.run(main(lim, sql))
