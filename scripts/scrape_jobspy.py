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
import html
import json
import os
import re
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

# What ingest-batch counts per request. Twins are included in duplicates;
# senior_skipped is a plainly senior title the API refused to store.
INGEST_COUNTERS = ("created", "duplicates", "cross_source_twins_skipped", "skipped", "senior_skipped")

# JobSpy 1.1.82 blanks a LinkedIn card's location when the card shows one
# part: "Canada", "United States" and "Greater Vancouver Metropolitan Area"
# all come back "" (its Location(country=WORLDWIDE) displays as nothing), and
# with no text the API can't tell the country. The posting's guest page still
# shows it, so those rows (2 of 95 LinkedIn rows in a 4-search run, 2026-09,
# both Canadian) are looked up one at a time, at most this many per run.
MAX_LOCATION_LOOKUPS = 25
LOOKUP_DELAY_S = 1.0
LINKEDIN_POSTING = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{}"
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}
_LINKEDIN_JOB_ID = re.compile(r"/jobs/view/(\d+)")
_POSTING_LOCATION = re.compile(r'topcard__flavor--bullet[^>]*>\s*([^<]{1,120}?)\s*<')

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


def _text(value) -> str:
    """A JobSpy cell as text. pandas fills an empty cell with NaN (a float),
    None or NaT, and NaN is truthy, so ``value or ""`` let it through: one
    NaN company made httpx refuse the whole chunk of 100 jobs."""
    text = str(value).strip()
    return "" if text in ("nan", "NaN", "NaT", "None", "<NA>") else text


def _is_true(value) -> bool:
    """A JobSpy flag cell: an empty cell (NaN is truthy) reads as False."""
    return bool(_text(value)) and bool(value)


def _blank_linkedin_location(job_data: dict) -> bool:
    return _text(job_data.get("site")) == "linkedin" and not (
        _text(job_data.get("location")) or _text(job_data.get("city")) or _text(job_data.get("state"))
    )


def to_payload(job_data: dict) -> dict | None:
    """Map a JobSpy row to an ingest-batch job payload. None if unusable
    (no URL, title or company). Every value is a plain string."""
    job_url = _text(job_data.get("job_url"))
    title = _text(job_data.get("title"))
    company = _text(job_data.get("company"))
    if not job_url or not title or not company:
        return None

    # Determine experience level
    title_lower = title.lower()
    if "intern" in title_lower or "co-op" in title_lower or "coop" in title_lower:
        exp_level = "internship"
    else:
        exp_level = "new_grad"

    # Determine work type
    if _is_true(job_data.get("is_remote")):
        work_type = "remote"
    else:
        loc = _text(job_data.get("location")).lower()
        if "remote" in loc:
            work_type = "remote"
        elif "hybrid" in loc:
            work_type = "hybrid"
        else:
            work_type = "onsite"

    # Build location string
    city = _text(job_data.get("city"))
    state = _text(job_data.get("state"))
    location = f"{city}, {state}" if city and state else city or state or _text(job_data.get("location"))
    site = _text(job_data.get("site")) or "indeed"

    # Determine country. JobSpy's frame carries no city/state columns, only
    # "location" ("Toronto, ON, CA", "Austin, TX, US": the last part is the
    # ISO country), so the state test alone left every row "CA". The API
    # re-derives the country from the location (na_location.job_country);
    # this is only the fallback it keeps when the location says nothing.
    # A LinkedIn row with no location at all (JobSpy blanked a one-part one
    # and recover_linkedin_locations couldn't read it back) keeps the search's
    # country: every SEARCHES entry is a Canadian search, and a row sent with
    # no country would drop out of every country-filtered feed. Indeed rows
    # come from ca.indeed.com (country_indeed="Canada"), so "CA" stands for
    # them too.
    country = "CA"
    if state:
        if len(state) == 2 and state.upper() not in (
            "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "NT", "YT", "NU"
        ):
            country = "US"
    elif location.rsplit(",", 1)[-1].strip() in ("US", "USA") or "united states" in location.lower():
        country = "US"

    payload = {
        "title": title,
        "company": company,
        "location": location,
        "url": job_url,
        "source_platform": site,
        "experience_level": exp_level,
        "work_type": work_type,
        "country": country,
    }
    posted = _text(job_data.get("date_posted"))
    if posted:
        payload["posted_date"] = posted
    # JobSpy returns the employer's real logo for LinkedIn/Indeed rows, keep it
    # instead of letting the API fall back to a name-guessed favicon.
    logo = _text(job_data.get("company_logo")) or _text(job_data.get("logo_photo_url"))
    if logo.startswith("http"):
        payload["company_logo"] = logo
    # The employer's own website (Indeed's corporateWebsite). The API derives
    # company_domain from it instead of guessing "<name>.com".
    website = _text(job_data.get("company_url_direct"))
    if website.startswith("http"):
        payload["company_url"] = website
    return payload


def json_compliant(payload: dict) -> bool:
    """True when httpx can send the payload. Since 0.28 its JSON encoder runs
    with allow_nan=False, so a single NaN fails the whole request before it
    leaves the machine."""
    try:
        json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError):
        return False
    return True


async def recover_linkedin_locations(jobs: list[dict], client: httpx.AsyncClient) -> int:
    """Put back the location JobSpy blanked on LinkedIn rows, read from each
    posting's guest page (at most MAX_LOCATION_LOOKUPS). Best effort: a row
    whose page fails or shows no location keeps "", and to_payload then sends
    no country for it. Returns how many rows got their location back."""
    recovered = 0
    blank = [job for job in jobs if _blank_linkedin_location(job)]
    for i, job in enumerate(blank[:MAX_LOCATION_LOOKUPS]):
        match = _LINKEDIN_JOB_ID.search(_text(job.get("job_url")))
        if not match:
            continue
        if i:
            await asyncio.sleep(LOOKUP_DELAY_S)
        try:
            resp = await client.get(LINKEDIN_POSTING.format(match.group(1)))
        except httpx.HTTPError:
            continue
        found = _POSTING_LOCATION.search(resp.text) if resp.status_code == 200 else None
        location = re.sub(r"\s+", " ", html.unescape(found.group(1))).strip() if found else ""
        if location:
            job["location"] = location
            recovered += 1
    return recovered


async def push_batches(jobs: list[dict]) -> dict[str, int]:
    """POST jobs to /jobs/ingest-batch in chunks. One request dedupes and
    inserts a whole chunk, the old per-job /jobs/create loop cost one
    (unauthenticated, always-401) request per job.

    Returns the API's INGEST_COUNTERS summed over the chunks, plus "errors":
    jobs that never reached the API or sat in a chunk it refused. A job httpx
    can't encode is dropped on its own instead of failing its chunk.
    """
    totals = dict.fromkeys(INGEST_COUNTERS + ("errors",), 0)
    sendable = [job for job in jobs if json_compliant(job)]
    if len(sendable) < len(jobs):
        print(f"  dropped {len(jobs) - len(sendable)} job(s) that are not valid JSON")
        totals["errors"] += len(jobs) - len(sendable)
    headers = {"x-cron-secret": CRON_SECRET} if CRON_SECRET else {}
    async with httpx.AsyncClient(timeout=60) as client:
        for start in range(0, len(sendable), BATCH_SIZE):
            chunk = sendable[start:start + BATCH_SIZE]
            try:
                resp = await client.post(
                    f"{API_BASE}/jobs/ingest-batch",
                    json={"jobs": chunk},
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for key in INGEST_COUNTERS:
                        totals[key] += data.get(key, 0)
                else:
                    print(f"  batch {start // BATCH_SIZE + 1}: HTTP {resp.status_code} {resp.text[:200]}")
                    totals["errors"] += len(chunk)
            except Exception as e:
                print(f"  batch {start // BATCH_SIZE + 1}: {e}")
                totals["errors"] += len(chunk)
    return totals


def results_line(totals: dict[str, int]) -> str:
    """The run's closing log line, every ingest-batch counter included."""
    return (
        f"Results: {totals['created']} created, {totals['duplicates']} duplicates "
        f"({totals['cross_source_twins_skipped']} cross-source twins), "
        f"{totals['senior_skipped']} senior titles skipped, "
        f"{totals['skipped']} skipped (no URL), {totals['errors']} errors"
    )


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

    blank = sum(1 for job in all_jobs if _blank_linkedin_location(job))
    if blank:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=BROWSER_HEADERS) as client:
            recovered = await recover_linkedin_locations(all_jobs, client)
        print(f"LinkedIn rows with no location: {blank} ({recovered} read back from the posting page)")

    # Push to API in batches
    if not CRON_SECRET:
        print("WARNING: CRON_SECRET is not set; the API will reject the batches.")
    payloads = [p for p in (to_payload(j) for j in all_jobs) if p]
    if len(payloads) < len(all_jobs):
        print(f"Skipped {len(all_jobs) - len(payloads)} rows with no URL, title or company")
    print(f"\nPushing {len(payloads)} jobs to {API_BASE} in batches of {BATCH_SIZE}...")

    totals = await push_batches(payloads)

    print(f"\n{results_line(totals)}")


if __name__ == "__main__":
    asyncio.run(main())
