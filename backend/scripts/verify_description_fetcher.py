"""Live verification for description_extractor against public ATS URLs."""

import asyncio
import sys

import httpx

from backend.services.description_extractor import BROWSER_HEADERS, extract_description_from_url

MIN_LEN = 120


async def _first_lever_posting(client: httpx.AsyncClient) -> str:
    for slug in ("spotify", "palantir", "netflix"):
        r = await client.get(f"https://api.lever.co/v0/postings/{slug}?mode=json")
        if r.status_code == 200 and isinstance(r.json(), list) and r.json():
            return r.json()[0].get("hostedUrl") or ""
    return ""


async def _first_ashby_posting(client: httpx.AsyncClient) -> str:
    for slug in ("notion", "linear", "ramp"):
        r = await client.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
        if r.status_code == 200:
            jobs = r.json().get("jobs") or []
            if jobs:
                return jobs[0].get("jobUrl") or ""
    return ""


async def _first_greenhouse_posting(client: httpx.AsyncClient) -> str:
    for slug in ("stripe", "figma", "datadog"):
        r = await client.get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
        )
        if r.status_code == 200:
            jobs = r.json().get("jobs") or []
            if jobs:
                return jobs[0].get("absolute_url") or ""
    return ""


async def main() -> int:
    failures = 0
    async with httpx.AsyncClient(follow_redirects=True, timeout=25, headers=BROWSER_HEADERS) as client:
        tests: list[tuple[str, str]] = [
            (
                "greenhouse-embedded",
                "https://stripe.com/jobs/search?gh_jid=7954688",
            ),
        ]

        gh = await _first_greenhouse_posting(client)
        if gh:
            tests.append(("greenhouse-direct", gh))
        lever = await _first_lever_posting(client)
        if lever:
            tests.append(("lever", lever))
        ashby = await _first_ashby_posting(client)
        if ashby:
            tests.append(("ashby", ashby))

        print(f"Running {len(tests)} live description fetch tests...\n")
        for name, url in tests:
            desc = await extract_description_from_url(client, url)
            ok = len(desc) >= MIN_LEN
            status = "PASS" if ok else "FAIL"
            print(f"[{status}] {name}")
            print(f"  URL: {url}")
            print(f"  Length: {len(desc)}")
            if desc:
                preview = desc.replace("\n", " ")[:160]
                print(f"  Preview: {preview}...")
            else:
                failures += 1
            print()

    if failures:
        print(f"{failures} live test(s) failed.")
    else:
        print("All live tests passed.")
    return failures


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
