"""
Property-based tests for Jobs API filtering.
Feature: job-scraper-aggregator, Property 8: API Filter AND Composition
Validates: Requirements 9.5
"""

import datetime
from hypothesis import given, settings
from hypothesis import strategies as st

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from backend.db.database import Base, get_db
from backend.db.models import ScrapedJob
from backend.main import app


# Strategies for job field values
country_values = ["US", "CA"]
work_type_values = ["remote", "hybrid", "onsite"]
role_category_values = ["Software Engineering", "Data Analysis", "Consultant", "Product Management"]
experience_level_values = ["new_grad", "internship"]


@st.composite
def job_database(draw):
    """Generate a list of ScrapedJob-like dicts to seed the database."""
    num_jobs = draw(st.integers(min_value=5, max_value=30))
    jobs = []
    for i in range(num_jobs):
        job = {
            "title": f"Job {i}",
            "company": f"Company {i}",
            "location": draw(st.sampled_from(["Remote", "New York, NY", "Toronto, ON", "Austin, TX"])),
            "url": f"https://jobright.ai/jobs/info/{draw(st.uuids())}",
            "country": draw(st.sampled_from(country_values)),
            "work_type": draw(st.sampled_from(work_type_values)),
            "role_category": draw(st.sampled_from(role_category_values)),
            "experience_level": draw(st.sampled_from(experience_level_values)),
            "posted_date": datetime.datetime(2024, 1, 1) + datetime.timedelta(days=draw(st.integers(min_value=0, max_value=365))),
            "source_platform": "github",
        }
        jobs.append(job)
    return jobs


def _setup_test_db_and_client(jobs_data):
    """Create an in-memory DB, seed it with jobs, and return a test client.
    
    Uses StaticPool to ensure all connections share the same in-memory database.
    """
    from sqlalchemy.pool import StaticPool

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


@settings(max_examples=50)
@given(
    jobs_data=job_database(),
    filter_country=st.one_of(st.none(), st.sampled_from(country_values)),
    filter_work_type=st.one_of(st.none(), st.sampled_from(work_type_values)),
    filter_role_category=st.one_of(st.none(), st.sampled_from(role_category_values)),
    filter_experience=st.one_of(st.none(), st.sampled_from(experience_level_values)),
)
def test_api_filter_and_composition(jobs_data, filter_country, filter_work_type, filter_role_category, filter_experience):
    """
    Property 8: API Filter AND Composition

    Every returned job SHALL satisfy ALL specified filter conditions simultaneously.

    **Validates: Requirements 9.5**
    """
    client, session, engine = _setup_test_db_and_client(jobs_data)

    try:
        # Build query params
        params = {}
        if filter_country:
            params["country"] = filter_country
        if filter_work_type:
            params["work_type"] = filter_work_type
        if filter_role_category:
            params["role_category"] = filter_role_category
        if filter_experience:
            params["experience_level"] = filter_experience

        response = client.get("/jobs", params=params)
        assert response.status_code == 200

        results = response.json()

        # Verify every returned job satisfies ALL filter conditions
        for job in results:
            if filter_country:
                assert job["country"] == filter_country, (
                    f"Job country '{job['country']}' doesn't match filter '{filter_country}'"
                )
            if filter_work_type:
                assert job["work_type"] == filter_work_type, (
                    f"Job work_type '{job['work_type']}' doesn't match filter '{filter_work_type}'"
                )
            if filter_role_category:
                assert job["role_category"] == filter_role_category, (
                    f"Job role_category '{job['role_category']}' doesn't match filter '{filter_role_category}'"
                )
            if filter_experience:
                assert job["experience_level"] == filter_experience, (
                    f"Job experience_level '{job['experience_level']}' doesn't match filter '{filter_experience}'"
                )
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()


@settings(max_examples=50)
@given(jobs_data=job_database())
def test_api_sort_order_invariant(jobs_data):
    """
    Property 9: API Sort Order Invariant

    Jobs returned by the API SHALL be sorted by posted_date descending (newest first).

    **Validates: Requirements 9.7**
    """
    client, session, engine = _setup_test_db_and_client(jobs_data)

    try:
        response = client.get("/jobs")
        assert response.status_code == 200

        results = response.json()

        # Verify descending order by posted_date
        for i in range(len(results) - 1):
            current_date = results[i].get("posted_date")
            next_date = results[i + 1].get("posted_date")

            # Skip comparison if either date is None
            if current_date is None or next_date is None:
                continue

            assert current_date >= next_date, (
                f"Sort order violated: job[{i}].posted_date={current_date} < job[{i+1}].posted_date={next_date}"
            )
    finally:
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()
