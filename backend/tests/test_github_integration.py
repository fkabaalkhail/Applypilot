"""
Integration tests for GitHub polling and job scraping.

Tests cover:
- GitHub API polling with mocked HTTP responses
- Markdown table parsing with real repo formats
- Deduplication across sources
- Incremental polling (only new jobs after last_polled_at)

Requirements: 1.2, 1.3, 11.4
"""

import asyncio
import datetime
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import ScrapedJob, GitHubSource
from backend.services.github_scraper import GitHubScraper, ParsedJob

# Create a test-specific database
TEST_DATABASE_URL = "sqlite:///./test_github_integration.db"
test_engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture(autouse=True)
def setup_test_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db_session():
    """Yield a test DB session."""
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def scraper(db_session):
    """Create a GitHubScraper with a real test DB session."""
    return GitHubScraper(db=db_session)


@pytest.fixture
def github_source(db_session):
    """Create a GitHub source in the DB."""
    source = GitHubSource(
        repo_url="https://github.com/jobright-ai/2025-Software-Engineer-New-Grad",
        repo_owner="jobright-ai",
        repo_name="2025-Software-Engineer-New-Grad",
        file_path="README.md",
        poll_interval_minutes=60,
        status="active",
    )
    db_session.add(source)
    db_session.commit()
    db_session.refresh(source)
    return source


# Real-format markdown content mimicking jobright-ai repos
JOBRIGHT_MARKDOWN_CONTENT = """\
# 2025 Software Engineer New Grad Positions

This repository tracks new grad software engineering positions.

| Company | Role | Location | Application/Link | Date Posted |
|---------|------|----------|-----------------|-------------|
| **Google** | Software Engineer, New Grad | Mountain View, CA | [Apply](https://careers.google.com/jobs/123) | 2025-01-15 |
| **Meta** | Software Engineer | Menlo Park, CA | [Apply](https://www.metacareers.com/jobs/456) | 2025-01-14 |
| **Amazon** | SDE I | Seattle, WA | [Apply](https://amazon.jobs/en/jobs/789) | 2025-01-13 |
| **Stripe** | Backend Engineer | San Francisco, CA | [Apply](https://stripe.com/jobs/listing/backend-engineer/101) | 2025-01-12 |
| **Netflix** | Software Engineer | Los Gatos, CA | [Apply](https://jobs.netflix.com/jobs/202) | 2025-01-11 |
"""

UPDATED_MARKDOWN_CONTENT = """\
# 2025 Software Engineer New Grad Positions

This repository tracks new grad software engineering positions.

| Company | Role | Location | Application/Link | Date Posted |
|---------|------|----------|-----------------|-------------|
| **Microsoft** | Software Engineer | Redmond, WA | [Apply](https://careers.microsoft.com/jobs/999) | 2025-01-16 |
| **Google** | Software Engineer, New Grad | Mountain View, CA | [Apply](https://careers.google.com/jobs/123) | 2025-01-15 |
| **Meta** | Software Engineer | Menlo Park, CA | [Apply](https://www.metacareers.com/jobs/456) | 2025-01-14 |
| **Amazon** | SDE I | Seattle, WA | [Apply](https://amazon.jobs/en/jobs/789) | 2025-01-13 |
| **Stripe** | Backend Engineer | San Francisco, CA | [Apply](https://stripe.com/jobs/listing/backend-engineer/101) | 2025-01-12 |
| **Netflix** | Software Engineer | Los Gatos, CA | [Apply](https://jobs.netflix.com/jobs/202) | 2025-01-11 |
"""


def _mock_httpx_client(mock_response):
    """Helper to create a properly mocked httpx.AsyncClient context manager."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)
    return mock_client


class TestMarkdownTableParsing:
    """Test parsing real-format markdown tables from GitHub repos."""

    def test_parse_jobright_format(self, scraper):
        """
        Parse a real-format markdown table like jobright-ai repos.
        Should extract all 5 jobs with correct fields.

        Requirements: 1.2
        """
        jobs = scraper.parse_markdown_table(JOBRIGHT_MARKDOWN_CONTENT)

        assert len(jobs) == 5

        # Verify first job (Google)
        google_job = jobs[0]
        assert "Google" in google_job.company
        assert "Software Engineer" in google_job.title
        assert google_job.location == "Mountain View, CA"
        assert google_job.url == "https://careers.google.com/jobs/123"
        assert google_job.posted_date == datetime.datetime(2025, 1, 15)

        # Verify last job (Netflix)
        netflix_job = jobs[4]
        assert "Netflix" in netflix_job.company
        assert netflix_job.url == "https://jobs.netflix.com/jobs/202"
        assert netflix_job.posted_date == datetime.datetime(2025, 1, 11)

    def test_parse_table_with_linked_companies(self, scraper):
        """Parse table where company names are markdown links."""
        content = """\
# Jobs

| Company | Title | Location | Apply | Date |
|---------|-------|----------|-------|------|
| [Datadog](https://datadoghq.com) | Software Engineer | NYC | [Apply](https://careers.datadoghq.com/detail/123) | 2025-01-10 |
| [Cloudflare](https://cloudflare.com) | Systems Engineer | Austin, TX | [Apply](https://boards.greenhouse.io/cloudflare/jobs/456) | 2025-01-09 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 2
        assert jobs[0].company == "Datadog"
        assert jobs[0].url == "https://careers.datadoghq.com/detail/123"
        assert jobs[1].company == "Cloudflare"
        assert jobs[1].url == "https://boards.greenhouse.io/cloudflare/jobs/456"

    def test_parse_empty_content(self, scraper):
        """Empty content returns no jobs."""
        jobs = scraper.parse_markdown_table("")
        assert jobs == []

    def test_parse_content_without_table(self, scraper):
        """Content without a markdown table returns no jobs."""
        content = "# Just a README\n\nNo jobs here."
        jobs = scraper.parse_markdown_table(content)
        assert jobs == []


class TestJobStorageAndDeduplication:
    """Test storing parsed jobs and deduplication by URL."""

    def test_store_jobs_in_database(self, scraper, db_session, github_source):
        """
        Parsed jobs should be stored in the database with correct fields.

        Requirements: 1.2
        """
        jobs = [
            ParsedJob(
                title="Software Engineer",
                company="Google",
                location="Mountain View, CA",
                url="https://careers.google.com/jobs/123",
                posted_date=datetime.datetime(2025, 1, 15),
            ),
            ParsedJob(
                title="Backend Dev",
                company="Meta",
                location="Menlo Park, CA",
                url="https://metacareers.com/jobs/456",
                posted_date=datetime.datetime(2025, 1, 14),
            ),
        ]

        new_count = asyncio.run(scraper._store_jobs(jobs, github_source))
        assert new_count == 2

        # Verify jobs are in the database
        stored_jobs = db_session.query(ScrapedJob).all()
        assert len(stored_jobs) == 2

        google_job = db_session.query(ScrapedJob).filter(
            ScrapedJob.url == "https://careers.google.com/jobs/123"
        ).first()
        assert google_job is not None
        assert google_job.title == "Software Engineer"
        assert google_job.company == "Google"
        assert google_job.source_platform == "github"
        assert google_job.github_source_id == github_source.id

    def test_deduplication_by_url(self, scraper, db_session, github_source):
        """
        Polling the same content twice should not create duplicate jobs.
        Deduplication is by URL.

        Requirements: 1.3
        """
        jobs = [
            ParsedJob(
                title="Software Engineer",
                company="Google",
                location="Mountain View, CA",
                url="https://careers.google.com/jobs/123",
                posted_date=datetime.datetime(2025, 1, 15),
            ),
        ]

        # Store once
        first_count = asyncio.run(scraper._store_jobs(jobs, github_source))
        assert first_count == 1

        # Store again (same URL)
        second_count = asyncio.run(scraper._store_jobs(jobs, github_source))
        assert second_count == 0

        # Only one job in DB
        total = db_session.query(ScrapedJob).count()
        assert total == 1

    def test_deduplication_across_sources(self, scraper, db_session, github_source):
        """
        Jobs with the same URL from different sources should not be duplicated.

        Requirements: 1.3
        """
        # Pre-existing job from LinkedIn scraping
        existing_job = ScrapedJob(
            title="Software Engineer",
            company="Google",
            url="https://careers.google.com/jobs/123",
            description="Build things",
            source_platform="linkedin",
        )
        db_session.add(existing_job)
        db_session.commit()

        # Try to store same URL from GitHub
        jobs = [
            ParsedJob(
                title="Software Engineer",
                company="Google",
                location="Mountain View, CA",
                url="https://careers.google.com/jobs/123",
                posted_date=datetime.datetime(2025, 1, 15),
            ),
        ]

        new_count = asyncio.run(scraper._store_jobs(jobs, github_source))
        assert new_count == 0

        # Still only one job in DB
        total = db_session.query(ScrapedJob).count()
        assert total == 1


class TestIncrementalPolling:
    """Test that only new jobs (after last_polled_at) are returned."""

    def test_incremental_poll_filters_old_jobs(self, scraper, db_session, github_source):
        """
        When last_polled_at is set, only jobs posted after that date
        should be returned from fetch_jobs.

        Requirements: 11.4
        """
        # Set last_polled_at to Jan 13, so only Jan 14+ jobs should be returned
        github_source.last_polled_at = datetime.datetime(2025, 1, 13)
        db_session.commit()

        # Mock the HTTP call to return our test content
        mock_response = MagicMock()
        mock_response.text = JOBRIGHT_MARKDOWN_CONTENT
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = _mock_httpx_client(mock_response)

            jobs = asyncio.run(scraper.fetch_jobs(github_source))

        # Only jobs posted after Jan 13 should be returned (Jan 14 and Jan 15)
        assert len(jobs) == 2
        dates = [j.posted_date for j in jobs]
        assert all(d > datetime.datetime(2025, 1, 13) for d in dates)

    def test_first_poll_returns_all_jobs(self, scraper, db_session, github_source):
        """
        When last_polled_at is None (first poll), all jobs should be returned.

        Requirements: 11.4
        """
        assert github_source.last_polled_at is None

        mock_response = MagicMock()
        mock_response.text = JOBRIGHT_MARKDOWN_CONTENT
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = _mock_httpx_client(mock_response)

            jobs = asyncio.run(scraper.fetch_jobs(github_source))

        # All 5 jobs should be returned on first poll
        assert len(jobs) == 5

    def test_poll_updates_last_polled_at(self, scraper, db_session, github_source):
        """
        After a successful poll, last_polled_at should be updated.

        Requirements: 11.4
        """
        assert github_source.last_polled_at is None

        mock_response = MagicMock()
        mock_response.text = JOBRIGHT_MARKDOWN_CONTENT
        mock_response.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = _mock_httpx_client(mock_response)

            asyncio.run(scraper.poll_all_sources())

        db_session.refresh(github_source)
        assert github_source.last_polled_at is not None

    def test_incremental_poll_new_jobs_only(self, scraper, db_session, github_source):
        """
        Simulate two polls: first gets all jobs, second only gets new ones.
        Deduplication by URL ensures no duplicates even if incremental filter
        doesn't catch everything.

        Requirements: 1.2, 1.3, 11.4
        """
        # First poll - gets all jobs
        mock_response_1 = MagicMock()
        mock_response_1.text = JOBRIGHT_MARKDOWN_CONTENT
        mock_response_1.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = _mock_httpx_client(mock_response_1)

            first_count = asyncio.run(scraper.poll_all_sources())

        assert first_count == 5
        db_session.refresh(github_source)
        assert github_source.last_polled_at is not None

        # Second poll - updated content with 1 new job (Microsoft, Jan 16)
        # But since last_polled_at is ~now (after first poll), and Microsoft's
        # date is 2025-01-16 (in the past), the incremental filter will exclude it.
        # Additionally, deduplication prevents existing URLs from being re-added.
        mock_response_2 = MagicMock()
        mock_response_2.text = UPDATED_MARKDOWN_CONTENT
        mock_response_2.raise_for_status = MagicMock()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = _mock_httpx_client(mock_response_2)

            second_count = asyncio.run(scraper.poll_all_sources())

        # No new jobs added (all filtered by date or deduplicated)
        assert second_count == 0

        # Total jobs in DB should still be 5
        total = db_session.query(ScrapedJob).count()
        assert total == 5


class TestGitHubAPIPolling:
    """Test GitHub API interaction with mocked HTTP responses."""

    def test_fetch_jobs_calls_github_api(self, scraper, github_source):
        """
        fetch_jobs should call the correct GitHub API URL.

        Requirements: 1.2
        """
        mock_response = MagicMock()
        mock_response.text = JOBRIGHT_MARKDOWN_CONTENT
        mock_response.raise_for_status = MagicMock()

        mock_client = _mock_httpx_client(mock_response)

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = mock_client

            jobs = asyncio.run(scraper.fetch_jobs(github_source))

            # Verify the correct URL was called
            expected_url = (
                "https://api.github.com/repos/jobright-ai/"
                "2025-Software-Engineer-New-Grad/contents/README.md"
            )
            mock_client.get.assert_called_once_with(
                expected_url,
                headers={"Accept": "application/vnd.github.v3.raw"},
                timeout=30,
            )

        assert len(jobs) == 5

    def test_poll_handles_api_error(self, scraper, db_session, github_source):
        """
        When GitHub API returns an error, the source should be marked as error.

        Requirements: 1.2
        """
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(side_effect=Exception("API rate limited"))

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client_class.return_value = mock_client

            total = asyncio.run(scraper.poll_all_sources())

        assert total == 0
        db_session.refresh(github_source)
        assert github_source.status == "error"
        assert "API rate limited" in github_source.error_message
