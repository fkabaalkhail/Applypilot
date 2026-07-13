"""
JobSpy-powered job scraper for Tailrd.

Uses python-jobspy to scrape LinkedIn, Indeed, and Google Jobs for
intern/new-grad/co-op positions in Canadian cities, then pushes
results to the Tailrd API.

Usage:
    pip install python-jobspy httpx
    python scripts/scrape_jobspy.py
    python scripts/scrape_jobspy.py --location "Ottawa, ON"
    python scripts/scrape_jobspy.py --search "new grad software"
"""

import asyncio
import argparse
import os
import sys

import httpx

# Tailrd API
API_BASE = "https://www.tailrd.ca"

# Auth for POST /jobs/ingest-batch (verify_cron_secret). In CI this comes from
# the CRON_SECRET repository secret; without it the API rejects the batch.
CRON_SECRET = os.getenv("CRON_SECRET", "")

# Jobs per request. The endpoint caps a batch at 500; 100 keeps each request
# small while still turning ~thousands of per-job calls into a handful.
BATCH_SIZE = 100

# Search configurations for Canadian intern/new-grad jobs
SEARCHES = [
    {"search_term": "intern software", "location": "Ottawa, ON", "country_indeed": "Canada"},
    {"search_term": "co-op software", "location": "Ottawa, ON", "country_indeed": "Canada"},
    {"search_term": "new grad software", "location": "Ottawa, ON", "country_indeed": "Canada"},
    {"search_term": "intern software", "location": "Toronto, ON", "country_indeed": "Canada"},
    {"search_term": "co-op software", "location": "Toronto, ON", "country_indeed": "Canada"},
    {"search_term": "new grad software", "location": "Toronto, ON", "country_indeed": "Canada"},
    {"search_term": "intern software", "location": "Vancouver, BC", "country_indeed": "Canada"},
    {"search_term": "intern software", "location": "Montreal, QC", "country_indeed": "Canada"},
    {"search_term": "intern software", "location": "Calgary, AB", "country_indeed": "Canada"},
    {"search_term": "intern software", "location": "Waterloo, ON", "country_indeed": "Canada"},
    {"search_term": "intern engineer", "location": "Ottawa, ON", "country_indeed": "Canada"},
    {"search_term": "entry level developer", "location": "Canada", "country_indeed": "Canada"},
]


def to_payload(job_data: dict) -> dict | None:
    """Map a JobSpy row to an ingest-batch job payload. None if unusable."""
    job_url = job_data.get("job_url") or ""
    if not job_url or job_url == "nan":
        return None

    # Determine experience level
    title = (job_data.get("title") or "").lower()
    if "intern" in title or "co-op" in title or "coop" in title:
        exp_level = "internship"
    else:
        exp_level = "new_grad"

    # Determine work type
    if job_data.get("is_remote"):
        work_type = "remote"
    else:
        loc = (job_data.get("location") or "").lower()
        if "remote" in loc:
            work_type = "remote"
        elif "hybrid" in loc:
            work_type = "hybrid"
        else:
            work_type = "onsite"

    # Determine country
    country = "CA"
    state = job_data.get("state") or ""
    if state and len(state) == 2 and state.upper() not in (
        "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "NT", "YT", "NU"
    ):
        country = "US"

    # Build location string
    city = job_data.get("city") or ""
    location = f"{city}, {state}" if city and state else city or state or job_data.get("location") or ""

    payload = {
        "title": job_data.get("title") or "",
        "company": job_data.get("company") or "",
        "location": location,
        "url": job_url,
        "source_platform": job_data.get("site") or "indeed",
        "experience_level": exp_level,
        "work_type": work_type,
        "country": country,
    }
    posted = job_data.get("date_posted")
    if posted is not None and str(posted) not in ("", "nan", "NaT", "None"):
        payload["posted_date"] = str(posted)
    return payload


async def push_batches(jobs: list[dict]) -> tuple[int, int, int, int]:
    """POST jobs to /jobs/ingest-batch in chunks. One request dedupes and
    inserts a whole chunk — the old per-job /jobs/create loop cost one
    (unauthenticated, always-401) request per job.

    Returns (created, duplicates, skipped, errors).
    """
    created = duplicates = skipped = errors = 0
    headers = {"x-cron-secret": CRON_SECRET} if CRON_SECRET else {}
    async with httpx.AsyncClient(timeout=60) as client:
        for start in range(0, len(jobs), BATCH_SIZE):
            chunk = jobs[start:start + BATCH_SIZE]
            try:
                resp = await client.post(
                    f"{API_BASE}/jobs/ingest-batch",
                    json={"jobs": chunk},
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    created += data.get("created", 0)
                    duplicates += data.get("duplicates", 0)
                    skipped += data.get("skipped", 0)
                else:
                    print(f"  batch {start // BATCH_SIZE + 1}: HTTP {resp.status_code} {resp.text[:200]}")
                    errors += len(chunk)
            except Exception as e:
                print(f"  batch {start // BATCH_SIZE + 1}: {e}")
                errors += len(chunk)
    return created, duplicates, skipped, errors


async def main():
    parser = argparse.ArgumentParser(description="Scrape jobs using JobSpy and push to Tailrd")
    parser.add_argument("--location", help="Override location (e.g., 'Ottawa, ON')")
    parser.add_argument("--search", help="Override search term (e.g., 'intern software')")
    parser.add_argument("--results", type=int, default=25, help="Results per search (default 25)")
    args = parser.parse_args()

    try:
        from jobspy import scrape_jobs
    except ImportError:
        print("ERROR: python-jobspy not installed. Run: pip install python-jobspy")
        sys.exit(1)

    searches = SEARCHES
    if args.location or args.search:
        searches = [{
            "search_term": args.search or "intern software",
            "location": args.location or "Ottawa, ON",
            "country_indeed": "Canada",
        }]

    all_jobs = []
    seen_urls = set()

    for search_config in searches:
        search_term = search_config["search_term"]
        location = search_config["location"]
        print(f"Searching '{search_term}' in {location}...", end=" ")

        try:
            jobs_df = scrape_jobs(
                site_name=["indeed", "linkedin"],
                search_term=search_term,
                location=location,
                country_indeed=search_config.get("country_indeed", "Canada"),
                results_wanted=args.results,
                hours_old=168,  # Past week
                job_type="internship",
                verbose=0,
            )

            new_count = 0
            for _, row in jobs_df.iterrows():
                job_url = str(row.get("job_url", ""))
                if job_url and job_url not in seen_urls and job_url != "nan":
                    seen_urls.add(job_url)
                    all_jobs.append(row.to_dict())
                    new_count += 1

            print(f"found {len(jobs_df)} ({new_count} new)")
        except Exception as e:
            print(f"error: {e}")

    print(f"\n{'='*60}")
    print(f"Total unique jobs found: {len(all_jobs)}")
    print(f"{'='*60}")

    if not all_jobs:
        print("No jobs found.")
        return

    # Push to API in batches
    if not CRON_SECRET:
        print("WARNING: CRON_SECRET is not set; the API will reject the batches.")
    payloads = [p for p in (to_payload(j) for j in all_jobs) if p]
    print(f"\nPushing {len(payloads)} jobs to {API_BASE} in batches of {BATCH_SIZE}...")

    created, duplicates, skipped, errors = await push_batches(payloads)

    print(f"\nResults: {created} created, {duplicates} duplicates, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    asyncio.run(main())
