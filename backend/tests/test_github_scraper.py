"""
Unit tests for GitHubScraper service.

Tests cover:
- parse_markdown_table: parsing pipe-delimited tables into ParsedJob records
- extract_link_from_cell: extracting URLs from markdown link syntax
- validate_github_repo_url: validating GitHub repository URLs
- _parse_date: parsing various date formats
- _map_columns_to_fields: mapping header columns to field names
"""

import datetime
from unittest.mock import MagicMock

import pytest

from backend.services.github_scraper import (
    GitHubScraper,
    ParsedJob,
    validate_github_repo_url,
)


@pytest.fixture
def scraper():
    """Create a GitHubScraper with a mock DB session."""
    mock_db = MagicMock()
    return GitHubScraper(db=mock_db)


class TestParseMarkdownTable:
    """Tests for parse_markdown_table method."""

    def test_basic_table(self, scraper):
        """Parse a standard pipe-delimited markdown table."""
        content = """\
| Company | Role | Location | Application/Link | Date Posted |
|---------|------|----------|-----------------|-------------|
| Google | Software Engineer | Remote | [Apply](https://google.com/apply) | 2024-01-15 |
| Meta | Backend Dev | NYC | [Apply](https://meta.com/apply) | 2024-01-16 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 2
        assert jobs[0].company == "Google"
        assert jobs[0].title == "Software Engineer"
        assert jobs[0].location == "Remote"
        assert jobs[0].url == "https://google.com/apply"
        assert jobs[0].posted_date == datetime.datetime(2024, 1, 15)

        assert jobs[1].company == "Meta"
        assert jobs[1].title == "Backend Dev"
        assert jobs[1].location == "NYC"
        assert jobs[1].url == "https://meta.com/apply"

    def test_table_with_linked_company(self, scraper):
        """Parse table where company name is a markdown link."""
        content = """\
| Company | Title | Location | Link | Date |
|---------|-------|----------|------|------|
| [Stripe](https://stripe.com) | SWE | SF | [Apply](https://stripe.com/jobs/1) | 2024-02-01 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 1
        assert jobs[0].company == "Stripe"
        assert jobs[0].url == "https://stripe.com/jobs/1"

    def test_empty_content(self, scraper):
        """Return empty list for content with no table."""
        jobs = scraper.parse_markdown_table("")
        assert jobs == []

    def test_no_header_row(self, scraper):
        """Return empty list when no recognizable header is found."""
        content = "Just some text\nwithout any table"
        jobs = scraper.parse_markdown_table(content)
        assert jobs == []

    def test_table_with_preamble(self, scraper):
        """Parse table that has text before the header row."""
        content = """\
# Job Listings

Here are the latest jobs:

| Company | Role | Location | Apply | Date Posted |
|---------|------|----------|-------|-------------|
| Amazon | SDE | Seattle | [Link](https://amazon.com/j/1) | 2024-03-01 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 1
        assert jobs[0].company == "Amazon"
        assert jobs[0].title == "SDE"

    def test_skips_html_comments(self, scraper):
        """Skip lines that are HTML comments."""
        content = """\
| Company | Role | Location | Link | Date |
|---------|------|----------|------|------|
| Google | SWE | Remote | [Apply](https://g.co/1) | 2024-01-01 |
<!-- This is a comment -->
| Meta | BE | NYC | [Apply](https://meta.com/1) | 2024-01-02 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 2

    def test_skips_rows_with_insufficient_cells(self, scraper):
        """Skip rows that don't have enough cells."""
        content = """\
| Company | Role | Location | Link | Date |
|---------|------|----------|------|------|
| Google | SWE | Remote | [Apply](https://g.co/1) | 2024-01-01 |
| Incomplete |
| Meta | BE | NYC | [Apply](https://meta.com/1) | 2024-01-02 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 2

    def test_row_without_url_is_skipped(self, scraper):
        """Skip rows where no URL can be extracted."""
        content = """\
| Company | Role | Location | Link | Date |
|---------|------|----------|------|------|
| Google | SWE | Remote | N/A | 2024-01-01 |
| Meta | BE | NYC | [Apply](https://meta.com/1) | 2024-01-02 |
"""
        jobs = scraper.parse_markdown_table(content)
        assert len(jobs) == 1
        assert jobs[0].company == "Meta"


class TestExtractLinkFromCell:
    """Tests for extract_link_from_cell method."""

    def test_markdown_link(self, scraper):
        """Extract URL from standard markdown link."""
        url = scraper.extract_link_from_cell("[Apply](https://example.com/job)")
        assert url == "https://example.com/job"

    def test_markdown_link_with_text(self, scraper):
        """Extract URL from markdown link with descriptive text."""
        url = scraper.extract_link_from_cell("[Click here to apply](https://jobs.com/123)")
        assert url == "https://jobs.com/123"

    def test_plain_https_url(self, scraper):
        """Extract plain HTTPS URL."""
        url = scraper.extract_link_from_cell("https://example.com/apply")
        assert url == "https://example.com/apply"

    def test_plain_http_url(self, scraper):
        """Extract plain HTTP URL."""
        url = scraper.extract_link_from_cell("http://example.com/apply")
        assert url == "http://example.com/apply"

    def test_no_url(self, scraper):
        """Return None when no URL is found."""
        url = scraper.extract_link_from_cell("N/A")
        assert url is None

    def test_empty_cell(self, scraper):
        """Return None for empty cell."""
        url = scraper.extract_link_from_cell("")
        assert url is None

    def test_markdown_link_empty_text(self, scraper):
        """Extract URL from markdown link with empty text."""
        url = scraper.extract_link_from_cell("[](https://example.com/job)")
        assert url == "https://example.com/job"


class TestValidateGithubRepoUrl:
    """Tests for validate_github_repo_url function."""

    def test_valid_url(self):
        """Accept valid GitHub repo URL."""
        assert validate_github_repo_url("https://github.com/owner/repo") is True

    def test_valid_url_with_trailing_slash(self):
        """Accept valid GitHub repo URL with trailing slash."""
        assert validate_github_repo_url("https://github.com/owner/repo/") is True

    def test_valid_url_with_dashes_and_dots(self):
        """Accept repo names with dashes and dots."""
        assert validate_github_repo_url(
            "https://github.com/jobright-ai/2026-Software-Engineer-New-Grad"
        ) is True

    def test_invalid_no_repo(self):
        """Reject URL without repo name."""
        assert validate_github_repo_url("https://github.com/owner") is False

    def test_invalid_not_github(self):
        """Reject non-GitHub URLs."""
        assert validate_github_repo_url("https://gitlab.com/owner/repo") is False

    def test_invalid_http(self):
        """Reject HTTP (non-HTTPS) URLs."""
        assert validate_github_repo_url("http://github.com/owner/repo") is False

    def test_invalid_with_extra_path(self):
        """Reject URLs with extra path segments."""
        assert validate_github_repo_url(
            "https://github.com/owner/repo/tree/main"
        ) is False

    def test_invalid_empty(self):
        """Reject empty string."""
        assert validate_github_repo_url("") is False


class TestParseDate:
    """Tests for _parse_date method."""

    def test_iso_format(self, scraper):
        """Parse ISO date format."""
        dt = scraper._parse_date("2024-01-15")
        assert dt == datetime.datetime(2024, 1, 15)

    def test_us_format(self, scraper):
        """Parse US date format."""
        dt = scraper._parse_date("01/15/2024")
        assert dt == datetime.datetime(2024, 1, 15)

    def test_abbreviated_month(self, scraper):
        """Parse abbreviated month format."""
        dt = scraper._parse_date("Jan 15, 2024")
        assert dt == datetime.datetime(2024, 1, 15)

    def test_full_month(self, scraper):
        """Parse full month name format."""
        dt = scraper._parse_date("January 15, 2024")
        assert dt == datetime.datetime(2024, 1, 15)

    def test_month_day_only(self, scraper):
        """Parse month/day format (uses current year)."""
        dt = scraper._parse_date("Jan 15")
        assert dt is not None
        assert dt.month == 1
        assert dt.day == 15
        assert dt.year == datetime.datetime.utcnow().year

    def test_empty_string(self, scraper):
        """Return None for empty string."""
        dt = scraper._parse_date("")
        assert dt is None

    def test_unrecognized_format(self, scraper):
        """Return None for unrecognized date format."""
        dt = scraper._parse_date("not a date")
        assert dt is None


class TestMapColumnsToFields:
    """Tests for _map_columns_to_fields method."""

    def test_standard_headers(self, scraper):
        """Map standard column headers."""
        headers = ["Company", "Role", "Location", "Application/Link", "Date Posted"]
        column_map = scraper._map_columns_to_fields(headers)
        assert column_map[0] == "company"
        assert column_map[1] == "title"
        assert column_map[2] == "location"
        assert column_map[3] == "url"
        assert column_map[4] == "posted_date"

    def test_alternative_headers(self, scraper):
        """Map alternative column header names."""
        headers = ["Organization", "Position", "Loc", "URL", "Posted"]
        column_map = scraper._map_columns_to_fields(headers)
        assert column_map[0] == "company"
        assert column_map[1] == "title"
        assert column_map[2] == "location"
        assert column_map[3] == "url"
        assert column_map[4] == "posted_date"

    def test_unrecognized_headers_ignored(self, scraper):
        """Unrecognized headers are not mapped."""
        headers = ["Company", "Salary", "Role"]
        column_map = scraper._map_columns_to_fields(headers)
        assert 0 in column_map  # company
        assert 1 not in column_map  # salary not mapped
        assert 2 in column_map  # title
