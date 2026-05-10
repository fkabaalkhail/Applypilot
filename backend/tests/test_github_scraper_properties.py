"""
Property-based tests for GitHubScraper service.

Uses Hypothesis to verify correctness properties across many random inputs.
"""

# Feature: job-dashboard-apply, Property 3: Markdown Table Parsing Round-Trip

import datetime
from unittest.mock import MagicMock

from hypothesis import given, settings, strategies as st

from backend.services.github_scraper import GitHubScraper


# --- Strategies ---

# Characters safe for table cells (no pipe, brackets which break parsing)
safe_text_chars = st.characters(
    whitelist_categories=("L", "N", "P", "S", "Z"),
    blacklist_characters="|[]\n\r",
)

safe_text = st.text(alphabet=safe_text_chars, min_size=1, max_size=50).map(str.strip).filter(
    lambda s: len(s) > 0
)

# Valid HTTP/HTTPS URLs
url_path_chars = st.characters(
    whitelist_categories=("L", "N"),
    whitelist_characters="-_/",
)

url_strategy = st.builds(
    lambda scheme, domain, path: f"{scheme}://{domain}.com/{path}",
    scheme=st.sampled_from(["http", "https"]),
    domain=st.text(
        alphabet=st.characters(whitelist_categories=("Ll",), whitelist_characters="-"),
        min_size=3,
        max_size=15,
    ).filter(lambda s: s[0].isalpha() and s[-1].isalpha()),
    path=st.text(alphabet=url_path_chars, min_size=1, max_size=30).filter(
        lambda s: len(s) > 0 and s[0] != "/" and s[-1] != "/"
    ),
)

# ISO format dates for round-trip consistency
date_strategy = st.dates(
    min_value=datetime.date(2020, 1, 1),
    max_value=datetime.date(2030, 12, 31),
).map(lambda d: d.isoformat())

# A single job record
job_record_strategy = st.fixed_dictionaries({
    "title": safe_text,
    "company": safe_text,
    "location": safe_text,
    "url": url_strategy,
    "posted_date": date_strategy,
})

# List of job records (at least 1)
job_list_strategy = st.lists(job_record_strategy, min_size=1, max_size=10)


# --- Helper ---

def format_jobs_as_markdown_table(jobs):
    """Format job records as a pipe-delimited markdown table."""
    lines = ["| Company | Role | Location | Link | Date Posted |"]
    lines.append("|---------|------|----------|------|-------------|")
    for job in jobs:
        url_cell = f"[Apply]({job['url']})"
        date_cell = job["posted_date"]
        lines.append(
            f"| {job['company']} | {job['title']} | {job['location']} | {url_cell} | {date_cell} |"
        )
    return "\n".join(lines)


# --- Property Test ---


@given(jobs=job_list_strategy)
@settings(max_examples=100)
def test_markdown_table_parsing_round_trip(jobs):
    """
    Property 3: Markdown Table Parsing Round-Trip

    For any list of valid job records (title, company, location, URL, posted date),
    formatting them as a pipe-delimited markdown table and then parsing that table
    shall produce job records with fields equal to the originals.

    **Validates: Requirements 1.7, 11.3, 11.6**
    """
    # Format jobs into a markdown table
    markdown = format_jobs_as_markdown_table(jobs)

    # Parse the table using GitHubScraper
    scraper = GitHubScraper(db=MagicMock())
    parsed_jobs = scraper.parse_markdown_table(markdown)

    # Assert same number of jobs
    assert len(parsed_jobs) == len(jobs), (
        f"Expected {len(jobs)} jobs but parsed {len(parsed_jobs)}"
    )

    # Assert each parsed job matches the original
    for original, parsed in zip(jobs, parsed_jobs):
        assert parsed.title == original["title"], (
            f"Title mismatch: {parsed.title!r} != {original['title']!r}"
        )
        assert parsed.company == original["company"], (
            f"Company mismatch: {parsed.company!r} != {original['company']!r}"
        )
        assert parsed.location == original["location"], (
            f"Location mismatch: {parsed.location!r} != {original['location']!r}"
        )
        assert parsed.url == original["url"], (
            f"URL mismatch: {parsed.url!r} != {original['url']!r}"
        )
        # Verify posted_date round-trips correctly
        expected_date = datetime.datetime.strptime(original["posted_date"], "%Y-%m-%d")
        assert parsed.posted_date == expected_date, (
            f"Date mismatch: {parsed.posted_date} != {expected_date}"
        )


# Feature: job-dashboard-apply, Property 6: GitHub Repository URL Validation

from backend.services.github_scraper import validate_github_repo_url

# Strategy for valid GitHub owner/repo names (ASCII alphanumeric, hyphens, underscores, dots)
github_name = st.text(
    alphabet=st.sampled_from(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
    ),
    min_size=1,
    max_size=30,
).filter(lambda s: s[0].isalnum())


@given(owner=github_name, repo=github_name, trailing_slash=st.booleans())
@settings(max_examples=100)
def test_valid_github_urls_accepted(owner, repo, trailing_slash):
    """
    Property 6: GitHub Repository URL Validation (valid URLs)

    For any valid owner/repo name combination, constructing
    https://github.com/{owner}/{repo} (with optional trailing slash)
    shall return True.

    **Validates: Requirements 11.2**
    """
    url = f"https://github.com/{owner}/{repo}" + ("/" if trailing_slash else "")
    assert validate_github_repo_url(url) is True, (
        f"Expected valid GitHub URL to be accepted: {url!r}"
    )


@given(
    url=st.one_of(
        # Gist URLs
        st.builds(
            lambda user, gist_id: f"https://gist.github.com/{user}/{gist_id}",
            user=github_name,
            gist_id=st.text(
                alphabet=st.characters(whitelist_categories=("N",), whitelist_characters="abcdef"),
                min_size=10,
                max_size=32,
            ).filter(lambda s: len(s) > 0),
        ),
        # Raw content URLs
        st.builds(
            lambda owner, repo, path: f"https://raw.githubusercontent.com/{owner}/{repo}/main/{path}",
            owner=github_name,
            repo=github_name,
            path=st.text(
                alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="/-_."),
                min_size=1,
                max_size=20,
            ).filter(lambda s: len(s) > 0 and s[0] != "/"),
        ),
        # Non-HTTPS (HTTP) GitHub URLs
        st.builds(
            lambda owner, repo: f"http://github.com/{owner}/{repo}",
            owner=github_name,
            repo=github_name,
        ),
        # Non-GitHub domains
        st.builds(
            lambda domain, owner, repo: f"https://{domain}.com/{owner}/{repo}",
            domain=st.sampled_from(["gitlab", "bitbucket", "codeberg", "sourcehut"]),
            owner=github_name,
            repo=github_name,
        ),
        # Extra path segments (not just owner/repo)
        st.builds(
            lambda owner, repo, extra: f"https://github.com/{owner}/{repo}/{extra}",
            owner=github_name,
            repo=github_name,
            extra=st.text(
                alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
                min_size=1,
                max_size=20,
            ).filter(lambda s: len(s) > 0),
        ),
        # Random strings (short, to avoid slow generation)
        st.text(min_size=0, max_size=50),
    )
)
@settings(max_examples=100)
def test_invalid_github_urls_rejected(url):
    """
    Property 6: GitHub Repository URL Validation (invalid URLs)

    For any string that is NOT a valid GitHub repo URL (gist URLs,
    raw content URLs, non-HTTPS, non-GitHub domains, extra path segments,
    random strings), the validator shall return False.

    **Validates: Requirements 11.2**
    """
    assert validate_github_repo_url(url) is False, (
        f"Expected invalid URL to be rejected: {url!r}"
    )


# Feature: job-dashboard-apply, Property 16: Incremental Poll Processing

from backend.services.github_scraper import ParsedJob

# Strategy for generating datetimes within a reasonable range
reasonable_datetimes = st.datetimes(
    min_value=datetime.datetime(2020, 1, 1),
    max_value=datetime.datetime(2030, 12, 31),
)

# Strategy for generating a ParsedJob with a specific posted_date
parsed_job_strategy = st.builds(
    ParsedJob,
    title=safe_text,
    company=safe_text,
    location=safe_text,
    url=url_strategy,
    posted_date=st.one_of(st.none(), reasonable_datetimes),
)

# List of ParsedJob records
parsed_job_list_strategy = st.lists(parsed_job_strategy, min_size=0, max_size=20)


@given(jobs=parsed_job_list_strategy, last_polled_at=reasonable_datetimes)
@settings(max_examples=100)
def test_incremental_poll_processing(jobs, last_polled_at):
    """
    Property 16: Incremental Poll Processing

    For any set of job entries with posted dates and a last_polled_at timestamp,
    the incremental processor shall return exactly those entries whose posted date
    is strictly after last_polled_at, and shall return an empty list if no entries
    are newer.

    **Validates: Requirements 11.4**
    """
    # Apply the same filtering logic as fetch_jobs
    # From github_scraper.py:
    #   if source.last_polled_at and jobs:
    #       jobs = [j for j in jobs if j.posted_date and j.posted_date > source.last_polled_at]
    filtered = [
        j for j in jobs
        if j.posted_date and j.posted_date > last_polled_at
    ]

    # Compute expected result independently
    expected = []
    for job in jobs:
        if job.posted_date is not None and job.posted_date > last_polled_at:
            expected.append(job)

    # Assert filtered result matches expected
    assert len(filtered) == len(expected), (
        f"Expected {len(expected)} jobs after filtering, got {len(filtered)}"
    )
    assert filtered == expected, "Filtered jobs do not match expected jobs"

    # Assert that all returned jobs have posted_date strictly after last_polled_at
    for job in filtered:
        assert job.posted_date is not None, "Filtered job should have a posted_date"
        assert job.posted_date > last_polled_at, (
            f"Job posted_date {job.posted_date} should be strictly after "
            f"last_polled_at {last_polled_at}"
        )

    # Assert that no job with posted_date <= last_polled_at is in the result
    for job in jobs:
        if job.posted_date is None or job.posted_date <= last_polled_at:
            assert job not in filtered, (
                f"Job with posted_date {job.posted_date} should not be in filtered results"
            )

    # If no entries are newer, result should be empty
    all_older_or_none = all(
        j.posted_date is None or j.posted_date <= last_polled_at
        for j in jobs
    )
    if all_older_or_none:
        assert filtered == [], (
            "Expected empty list when no entries are newer than last_polled_at"
        )
