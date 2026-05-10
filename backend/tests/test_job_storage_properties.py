"""
Property-based tests for job storage round-trip.

Uses Hypothesis to verify that storing a job in the database and retrieving it
preserves all field values.
"""

# Feature: job-dashboard-apply, Property 2: Job Storage Round-Trip Preserves All Fields

import datetime
from hypothesis import given, settings, strategies as st, HealthCheck

from backend.db.models import ScrapedJob


# --- Strategies ---

# Characters safe for text fields (printable, no null bytes)
safe_text_chars = st.characters(
    whitelist_categories=("L", "N", "P", "S", "Z"),
    blacklist_characters="\x00",
)

safe_text = st.text(alphabet=safe_text_chars, min_size=1, max_size=100).map(str.strip).filter(
    lambda s: len(s) > 0
)

# Valid HTTP/HTTPS URLs (unique enough to avoid constraint violations)
url_path_chars = st.characters(
    whitelist_categories=("L", "N"),
    whitelist_characters="-_/",
)

url_strategy = st.builds(
    lambda scheme, domain, path, unique: f"{scheme}://{domain}.com/{path}/{unique}",
    scheme=st.sampled_from(["http", "https"]),
    domain=st.text(
        alphabet=st.characters(whitelist_categories=("Ll",), whitelist_characters="-"),
        min_size=3,
        max_size=15,
    ).filter(lambda s: len(s) > 0 and s[0].isalpha() and s[-1].isalpha()),
    path=st.text(alphabet=url_path_chars, min_size=1, max_size=30).filter(
        lambda s: len(s) > 0 and s[0] != "/" and s[-1] != "/"
    ),
    unique=st.uuids().map(str),
)

# Optional datetimes for posted_date
reasonable_datetimes = st.datetimes(
    min_value=datetime.datetime(2020, 1, 1),
    max_value=datetime.datetime(2030, 12, 31),
)

# Salary range strings (e.g., "$80k-$120k", "100000-150000", "")
salary_range_strategy = st.one_of(
    st.just(""),
    st.builds(
        lambda low, high: f"${low}k-${high}k",
        low=st.integers(min_value=30, max_value=200),
        high=st.integers(min_value=201, max_value=500),
    ),
)

# Source platform values
source_platform_strategy = st.sampled_from(["linkedin", "github", "other"])

# Description text (can be longer)
description_strategy = st.text(
    alphabet=safe_text_chars, min_size=0, max_size=500
)


# --- Property Test ---


@given(
    title=safe_text,
    company=safe_text,
    location=safe_text,
    url=url_strategy,
    description=description_strategy,
    posted_date=st.one_of(st.none(), reasonable_datetimes),
    salary_range=salary_range_strategy,
    source_platform=source_platform_strategy,
)
@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_job_storage_round_trip_preserves_all_fields(
    setup_db, db_session, title, company, location, url, description,
    posted_date, salary_range, source_platform
):
    """
    Property 2: Job Storage Round-Trip Preserves All Fields

    For any valid job record with title, company, location, URL, description,
    posted date, salary range, and source platform, storing it in the database
    and retrieving it shall produce a record with all fields equal to the
    original values.

    **Validates: Requirements 1.4**
    """
    # Create a ScrapedJob model instance
    job = ScrapedJob(
        title=title,
        company=company,
        location=location,
        url=url,
        description=description,
        posted_date=posted_date,
        salary_range=salary_range,
        source_platform=source_platform,
    )

    # Store in the database
    db_session.add(job)
    db_session.commit()

    # Retrieve by ID
    job_id = job.id
    retrieved = db_session.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()

    # Assert all fields match the original values
    assert retrieved is not None, "Job should be retrievable after storage"
    assert retrieved.title == title, (
        f"Title mismatch: stored '{title}', retrieved '{retrieved.title}'"
    )
    assert retrieved.company == company, (
        f"Company mismatch: stored '{company}', retrieved '{retrieved.company}'"
    )
    assert retrieved.location == location, (
        f"Location mismatch: stored '{location}', retrieved '{retrieved.location}'"
    )
    assert retrieved.url == url, (
        f"URL mismatch: stored '{url}', retrieved '{retrieved.url}'"
    )
    assert retrieved.description == description, (
        f"Description mismatch: stored '{description}', retrieved '{retrieved.description}'"
    )
    assert retrieved.posted_date == posted_date, (
        f"Posted date mismatch: stored '{posted_date}', retrieved '{retrieved.posted_date}'"
    )
    assert retrieved.salary_range == salary_range, (
        f"Salary range mismatch: stored '{salary_range}', retrieved '{retrieved.salary_range}'"
    )
    assert retrieved.source_platform == source_platform, (
        f"Source platform mismatch: stored '{source_platform}', retrieved '{retrieved.source_platform}'"
    )

    # Clean up to avoid unique constraint violations across examples
    db_session.delete(retrieved)
    db_session.commit()
