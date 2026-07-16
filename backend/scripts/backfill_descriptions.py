"""
One-time exhaustive description backfill for DIRECT-URL rows (the hourly cron
then maintains the trickle). LinkedIn/Indeed rows are skipped here — they are
login-walled and only waste attempts; the dedup pass is their real fix.

Usage:
    DATABASE_URL=postgres://... python backend/scripts/backfill_descriptions.py
"""

import asyncio
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import urllib.request  # noqa: E402

import httpx  # noqa: E402
from sqlalchemy import bindparam, text  # noqa: E402

from backend.db.database import engine  # noqa: E402
from backend.services.description_extractor import (  # noqa: E402
    BROWSER_HEADERS,
    extract_description_from_html,
    extract_description_from_url,
    sanitize_description,
)


def _fetch_indeed_urllib(url: str) -> str:
    """Indeed 403s httpx's TLS fingerprint but serves urllib from residential
    IPs — fetch the raw page the boring way."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": BROWSER_HEADERS["User-Agent"], "Accept-Language": "en"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", "replace")

BATCH = 150
CONCURRENCY = 6

def select_sql(include_indeed: bool):
    # --include-indeed: Indeed walls datacenter IPs but serves residential
    # ones — meaningful only when running this script from a home machine.
    indeed_clause = "" if include_indeed else "AND url NOT ILIKE '%indeed.com%' "
    return text(
        "SELECT id, url FROM scraped_jobs "
        "WHERE (description IS NULL OR length(btrim(description)) < 50) "
        "AND coalesce(desc_fetch_attempts, 0) < 3 AND duplicate_of IS NULL "
        "AND url NOT ILIKE '%linkedin.com%' "
        + indeed_clause +
        "ORDER BY id DESC LIMIT :batch"
    )


async def main(include_indeed: bool = False) -> None:
    total_fixed = total_tried = 0
    semaphore = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=12, headers=BROWSER_HEADERS
    ) as client:

        async def fetch(job_id: int, url: str) -> tuple[int, str]:
            async with semaphore:
                try:
                    if "indeed.com" in url:
                        html = await asyncio.to_thread(_fetch_indeed_urllib, url)
                        return job_id, await extract_description_from_html(
                            client, url, html, url
                        )
                    return job_id, await extract_description_from_url(client, url)
                except Exception:
                    return job_id, ""

        query = select_sql(include_indeed)
        while True:
            with engine.connect() as conn:
                rows = conn.execute(query, {"batch": BATCH}).fetchall()
            if not rows:
                break
            results = await asyncio.gather(*[fetch(r.id, r.url) for r in rows])
            fixed_params = []
            failed_ids = []
            for job_id, description in results:
                if description:
                    fixed_params.append({
                        "id": job_id,
                        "d": sanitize_description(description),
                    })
                else:
                    failed_ids.append(job_id)
            with engine.begin() as conn:
                if fixed_params:
                    conn.execute(text(
                        "UPDATE scraped_jobs SET description = :d, "
                        "description_sections = NULL, "
                        "desc_fetch_attempts = coalesce(desc_fetch_attempts,0) + 1 "
                        "WHERE id = :id"
                    ), fixed_params)
                if failed_ids:
                    conn.execute(
                        text(
                            "UPDATE scraped_jobs "
                            "SET desc_fetch_attempts = coalesce(desc_fetch_attempts,0) + 1 "
                            "WHERE id IN :ids"
                        ).bindparams(bindparam("ids", expanding=True)),
                        {"ids": failed_ids},
                    )
            total_fixed += len(fixed_params)
            total_tried += len(rows)
            print(f"batch: {len(fixed_params)}/{len(rows)} fixed "
                  f"(cumulative {total_fixed}/{total_tried}, through id {rows[-1].id})")
    print(f"done: {total_fixed}/{total_tried} descriptions recovered")


if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL", ""):
        sys.exit("DATABASE_URL is required")
    asyncio.run(main(include_indeed="--include-indeed" in sys.argv))
