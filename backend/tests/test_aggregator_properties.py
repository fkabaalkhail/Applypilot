"""
Property-based tests for AggregatorService.
Feature: job-scraper-aggregator, Property 10: Seed Idempotence
Validates: Requirements 11.2
"""

import pytest
import asyncio
from hypothesis import given, settings
from hypothesis import strategies as st

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import GitHubSource
from backend.services.aggregator import AggregatorService


@settings(max_examples=50)
@given(num_calls=st.integers(min_value=1, max_value=10))
def test_seed_idempotence(num_calls):
    """
    Property 10: Seed Idempotence

    For any number of invocations of seed_sources(), the GitHubSource table
    SHALL contain exactly 9 records with no duplicates.

    **Validates: Requirements 11.2**
    """
    # Create fresh in-memory database for each test
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        aggregator = AggregatorService(session)

        # Call seed_sources() num_calls times
        for i in range(num_calls):
            result = asyncio.get_event_loop().run_until_complete(
                aggregator.seed_sources()
            )

            if i == 0:
                # First call should create all 9
                assert result["created"] == 9, f"First call created {result['created']}, expected 9"
                assert result["existing"] == 0
            else:
                # Subsequent calls should find all 9 existing
                assert result["created"] == 0, f"Call {i+1} created {result['created']}, expected 0"
                assert result["existing"] == 9

        # Verify exactly 9 records exist
        sources = session.query(GitHubSource).all()
        assert len(sources) == 9, f"Expected 9 sources, got {len(sources)}"

        # Verify no duplicate URLs
        urls = [s.repo_url for s in sources]
        assert len(urls) == len(set(urls)), f"Duplicate URLs found: {urls}"

        # Verify all expected repos are present
        expected_repos = {repo["url"] for repo in AggregatorService.REPOS}
        actual_repos = {s.repo_url for s in sources}
        assert actual_repos == expected_repos
    finally:
        session.close()
        engine.dispose()


def test_seed_creates_correct_categories():
    """Verify seed assigns correct role_category and experience_level to each source."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        aggregator = AggregatorService(session)
        asyncio.get_event_loop().run_until_complete(aggregator.seed_sources())

        sources = session.query(GitHubSource).all()

        for source in sources:
            # Verify experience_level
            if "Internship" in source.repo_name:
                assert source.experience_level == "internship"
            else:
                assert source.experience_level == "new_grad"

            # Verify role_category matches REPO_CATEGORY_MAP
            expected_category = AggregatorService.REPO_CATEGORY_MAP.get(source.repo_name, "")
            assert source.role_category == expected_category, (
                f"Source {source.repo_name} has category '{source.role_category}', "
                f"expected '{expected_category}'"
            )
    finally:
        session.close()
        engine.dispose()
