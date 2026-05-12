"""
Property-based tests for city multi-tag OR-logic filtering.
Feature: city-multi-tag-filter, Property 6: Backend OR-logic filter returns exactly matching jobs
Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
"""

import datetime
from hypothesis import given, settings
from hypothesis import strategies as st

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob
from backend.main import app


# Strategies for generating realistic location strings
location_strings = st.sampled_from([
    "New York, NY",
    "San Francisco, CA",
    "Austin, TX",
    "Toronto, ON",
    "Ottawa, Ontario, Canada",
    "Vancouver, BC",
    "Remote",
    "Chicago, IL",
    "Boston, MA",
    "Seattle, WA",
    "Denver, CO",
    "Montreal, QC",
    "Calgary, AB",
    "Los Angeles, CA",
    "Portland, OR",
])

# City filter values that may or may not match locations above
city_filter_values = st.sampled_from([
    "New York",
    "San Francisco",
    "Austin",
    "Toronto",
    "Ottawa",
    "Vancouver",
    "Remote",
    "Chicago",
    "Boston",
    "Seattle",
    "Denver",
    "Montreal",
    "Calgary",
    "Los Angeles",
    "Portland",
])


@st.composite
def jobs_with_locations(draw):
    """Generate a list of jobs with random location strings."""
    num_jobs = draw(st.integers(min_value=3, max_value=25))
    jobs = []
    for i in range(num_jobs):
        job = {
            "title": f"Job {i}",
            "company": f"Company {i}",
            "location": draw(location_strings),
            "url": f"https://example.com/jobs/{draw(st.uuids())}",
            "posted_date": datetime.datetime(2024, 1, 1) + datetime.timedelta(
                days=draw(st.integers(min_value=0, max_value=365))
            ),
            "source_platform": "github",
        }
        jobs.append(job)
    return jobs


@st.composite
def city_filter_list(draw):
    """Generate a non-empty list of city filter values (1-4 cities)."""
    num_cities = draw(st.integers(min_value=1, max_value=4))
    cities = draw(
        st.lists(city_filter_values, min_size=num_cities, max_size=num_cities, unique=True)
    )
    # Optionally add whitespace padding to test trimming
    padded_cities = []
    for city in cities:
        add_padding = draw(st.booleans())
        if add_padding:
            padded_cities.append(f"  {city}  ")
        else:
            padded_cities.append(city)
    return padded_cities


def _setup_test_db_and_client(jobs_data):
    """Create an in-memory DB, seed it with jobs, and return a test client."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestSession()

    # Seed jobs
    for job_data in jobs_data:
        job = ScrapedJob(**job_data)
        session.add(job)
    session.commit()

    # Override dependency
    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    return client, session, engine


def _job_matches_any_city(job_location: str, city_values: list[str]) -> bool:
    """Check if a job location matches any of the city filter values.

    Uses the same logic as the backend: case-insensitive substring match
    after trimming each filter value.
    """
    location_lower = job_location.lower()
    for city in city_values:
        trimmed = city.strip()
        if trimmed and trimmed.lower() in location_lower:
            return True
    return False


@settings(max_examples=100)
@given(
    jobs_data=jobs_with_locations(),
    filter_cities=city_filter_list(),
)
def test_or_logic_filter_returns_exactly_matching_jobs(jobs_data, filter_cities):
    """
    Property 6: Backend OR-logic filter returns exactly matching jobs

    For any set of jobs with various location strings and any non-empty list
    of city filter values, the filtered result shall contain exactly those jobs
    whose location field contains at least one of the filter values as a
    case-insensitive substring (after trimming each filter value).

    **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
    """
    client, session, engine = _setup_test_db_and_client(jobs_data)

    try:
        # Build the comma-separated location parameter
        location_param = ",".join(filter_cities)

        response = client.get("/jobs", params={"location": location_param})
        assert response.status_code == 200

        results = response.json()

        # Compute expected results using the same OR-logic
        trimmed_cities = [c.strip() for c in filter_cities if c.strip()]
        expected_matching = [
            job for job in jobs_data
            if _job_matches_any_city(job["location"], trimmed_cities)
        ]

        # Verify the count matches
        assert len(results) == len(expected_matching), (
            f"Expected {len(expected_matching)} matching jobs, got {len(results)}. "
            f"Filter cities: {filter_cities}, "
            f"Job locations: {[j['location'] for j in jobs_data]}"
        )

        # Verify every returned job actually matches at least one filter city
        for job in results:
            assert _job_matches_any_city(job["location"], trimmed_cities), (
                f"Job with location '{job['location']}' should not match "
                f"filter cities {trimmed_cities}"
            )

        # Verify no matching job was missed (completeness)
        returned_urls = {job["url"] for job in results}
        for job in expected_matching:
            assert job["url"] in returned_urls, (
                f"Job with location '{job['location']}' and url '{job['url']}' "
                f"should have been returned for filter cities {trimmed_cities}"
            )
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()
