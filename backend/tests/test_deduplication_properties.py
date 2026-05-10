"""
Property-based tests for job deduplication logic.

Uses Hypothesis to verify correctness properties across many random inputs.
"""

# Feature: job-dashboard-apply, Property 1: Job Deduplication Preserves URL Uniqueness

import datetime
from hypothesis import given, settings, strategies as st

from backend.services.github_scraper import ParsedJob
from backend.services.job_deduplication import deduplicate_jobs_by_url


# --- Strategies ---

# Characters safe for text fields (no pipe, brackets which break parsing)
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

# Optional datetimes for posted_date
reasonable_datetimes = st.datetimes(
    min_value=datetime.datetime(2020, 1, 1),
    max_value=datetime.datetime(2030, 12, 31),
)

# Strategy for generating a ParsedJob
parsed_job_strategy = st.builds(
    ParsedJob,
    title=safe_text,
    company=safe_text,
    location=safe_text,
    url=url_strategy,
    posted_date=st.one_of(st.none(), reasonable_datetimes),
)

# A small pool of URLs to create duplicates from
url_pool_strategy = st.lists(url_strategy, min_size=1, max_size=5)


def parsed_job_with_url(url):
    """Strategy for a ParsedJob with a specific URL."""
    return st.builds(
        ParsedJob,
        title=safe_text,
        company=safe_text,
        location=safe_text,
        url=st.just(url),
        posted_date=st.one_of(st.none(), reasonable_datetimes),
    )


# Strategy that generates lists of ParsedJob objects where some may share the same URL
@st.composite
def job_list_with_duplicates(draw):
    """Generate a list of ParsedJob objects where some may share the same URL."""
    # Draw a pool of URLs (some jobs will share these)
    url_pool = draw(st.lists(url_strategy, min_size=1, max_size=5))
    # Generate between 1 and 20 jobs, each picking a URL from the pool
    num_jobs = draw(st.integers(min_value=1, max_value=20))
    jobs = []
    for _ in range(num_jobs):
        url = draw(st.sampled_from(url_pool))
        job = draw(parsed_job_with_url(url))
        jobs.append(job)
    return jobs


# --- Property Test ---


@given(jobs=job_list_with_duplicates())
@settings(max_examples=100)
def test_deduplication_preserves_url_uniqueness(jobs):
    """
    Property 1: Job Deduplication Preserves URL Uniqueness

    For any list of scraped jobs (possibly containing duplicate URLs),
    after deduplication, no two jobs in the output shall share the same URL,
    and every unique URL from the input shall appear exactly once in the output.

    **Validates: Requirements 1.3**
    """
    result = deduplicate_jobs_by_url(jobs)

    # Collect unique URLs from input
    input_urls = [job.url for job in jobs]
    unique_input_urls = set(input_urls)

    # 1. No two jobs in the output share the same URL
    output_urls = [job.url for job in result]
    assert len(output_urls) == len(set(output_urls)), (
        f"Output contains duplicate URLs: {output_urls}"
    )

    # 2. Every unique URL from the input appears exactly once in the output
    assert set(output_urls) == unique_input_urls, (
        f"Output URLs {set(output_urls)} != unique input URLs {unique_input_urls}"
    )
    assert len(result) == len(unique_input_urls), (
        f"Expected {len(unique_input_urls)} unique jobs, got {len(result)}"
    )

    # 3. The output preserves first-occurrence order
    first_occurrence_order = []
    seen = set()
    for job in jobs:
        if job.url not in seen:
            seen.add(job.url)
            first_occurrence_order.append(job)

    for i, job in enumerate(result):
        assert job is first_occurrence_order[i], (
            f"Job at index {i} does not match first occurrence. "
            f"Expected URL {first_occurrence_order[i].url}, got {job.url}"
        )


# Feature: job-scraper-aggregator, Property 7: URL Uniqueness Invariant
# Validates: Requirements 6.1, 6.2, 6.4

from backend.services.aggregator import AggregatorService
from backend.services.markdown_parser import ParsedJob as AggParsedJob
from backend.db.models import GitHubSource, ScrapedJob as ScrapedJobModel

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from backend.db.database import Base


@st.composite
def agg_job_list_with_duplicates(draw):
    """Generate ParsedJob objects (from markdown_parser) with overlapping URLs."""
    url_pool = draw(st.lists(
        st.builds(
            lambda path: f"https://jobright.ai/jobs/info/{path}",
            st.from_regex(r'[a-z0-9]{8,16}', fullmatch=True)
        ),
        min_size=1, max_size=5
    ))
    num_jobs = draw(st.integers(min_value=1, max_value=15))
    jobs = []
    for _ in range(num_jobs):
        url = draw(st.sampled_from(url_pool))
        job = AggParsedJob(
            title=draw(st.from_regex(r'[A-Za-z][A-Za-z ]{2,20}', fullmatch=True).map(str.strip)),
            company=draw(st.from_regex(r'[A-Za-z][A-Za-z ]{2,15}', fullmatch=True).map(str.strip)),
            location=draw(st.sampled_from(["Remote", "New York, NY", "San Francisco, CA", "Toronto, ON", "Austin, TX"])),
            url=url,
            posted_date=None,
        )
        jobs.append(job)
    return jobs


@given(jobs=agg_job_list_with_duplicates())
@settings(max_examples=50)
def test_aggregator_url_uniqueness_in_database(jobs):
    """
    Property 7: URL Uniqueness Invariant (Database Level)

    For any sequence of parsed jobs submitted to the aggregator's storage layer,
    the database SHALL contain at most one ScrapedJob record per unique URL.

    **Validates: Requirements 6.1, 6.2, 6.4**
    """
    # Create fresh in-memory database for each test
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        # Create a source to associate jobs with
        source = GitHubSource(
            repo_url="https://github.com/jobright-ai/2026-Software-Engineer-New-Grad",
            repo_owner="jobright-ai",
            repo_name="2026-Software-Engineer-New-Grad",
            file_path="README.md",
            poll_interval_minutes=60,
            role_category="Software Engineering",
            experience_level="new_grad",
            status="active",
        )
        session.add(source)
        session.commit()

        # Use the aggregator to store jobs
        aggregator = AggregatorService(session)

        for job in jobs:
            aggregator._classify_and_store(job, source)

        # Verify: at most one record per unique URL
        all_stored = session.query(ScrapedJobModel).all()
        stored_urls = [j.url for j in all_stored]

        assert len(stored_urls) == len(set(stored_urls)), (
            f"Database contains duplicate URLs: {[u for u in stored_urls if stored_urls.count(u) > 1]}"
        )

        # Verify: number of stored jobs equals number of unique URLs from input
        # (minus any that were excluded by country filter)
        unique_input_urls = set(j.url for j in jobs)
        assert len(stored_urls) <= len(unique_input_urls), (
            f"Stored more jobs ({len(stored_urls)}) than unique input URLs ({len(unique_input_urls)})"
        )
    finally:
        session.close()
