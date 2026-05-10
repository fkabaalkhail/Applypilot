"""
GitHubScraper — fetches and parses job listings from GitHub repository markdown files.

Handles repositories like jobright-ai/2026-Software-Engineer-New-Grad that use
pipe-delimited markdown tables for job listings.
"""

import re
import logging
import datetime
from dataclasses import dataclass
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from backend.db.models import GitHubSource, ScrapedJob

logger = logging.getLogger(__name__)


@dataclass
class ParsedJob:
    """A job record parsed from a GitHub markdown table."""
    title: str
    company: str
    location: str
    url: str
    posted_date: Optional[datetime.datetime] = None


class GitHubScraper:
    """Scrapes job listings from GitHub repository markdown files."""

    GITHUB_API_BASE = "https://api.github.com"

    def __init__(self, db: Session):
        self.db = db

    async def fetch_jobs(self, source: GitHubSource) -> list[ParsedJob]:
        """Fetch new jobs from a GitHub repo since last poll.

        Uses GitHub API to get file content, then parses the markdown table.
        Only returns jobs not already in the database (by URL).
        """
        url = (
            f"{self.GITHUB_API_BASE}/repos/{source.repo_owner}/"
            f"{source.repo_name}/contents/{source.file_path}"
        )

        async with httpx.AsyncClient() as client:
            headers = {"Accept": "application/vnd.github.v3.raw"}
            response = await client.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            content = response.text

        jobs = self.parse_markdown_table(content)

        # Filter by last_polled_at if set (incremental processing)
        if source.last_polled_at and jobs:
            jobs = [
                j for j in jobs
                if j.posted_date and j.posted_date > source.last_polled_at
            ]

        return jobs

    def parse_markdown_table(self, content: str) -> list[ParsedJob]:
        """Parse pipe-delimited markdown table into structured job records.

        Handles formats like:
        | Company | Role | Location | Application/Link | Date Posted |
        |---------|------|----------|-----------------|-------------|
        | Google  | SWE  | Remote   | [Apply](url)    | 2024-01-15  |

        Algorithm:
        1. Split content by lines
        2. Find header row (contains | delimiters and recognizable column names)
        3. Map column positions to field names
        4. Skip separator row (contains ---)
        5. Parse each data row, extracting cell values
        6. Extract URLs from markdown link syntax [text](url)
        """
        lines = content.strip().split("\n")
        jobs: list[ParsedJob] = []

        # Find header row
        header_idx = None
        for i, line in enumerate(lines):
            if "|" in line and "---" not in line:
                # Check if it looks like a header (has recognizable column names)
                lower = line.lower()
                if any(kw in lower for kw in [
                    "company", "role", "title", "location",
                    "link", "apply", "date"
                ]):
                    header_idx = i
                    break

        if header_idx is None:
            return []

        # Parse header columns
        headers = [h.strip() for h in lines[header_idx].split("|")[1:-1]]
        column_map = self._map_columns_to_fields(headers)

        # Parse data rows (skip header + separator)
        start_idx = header_idx + 2  # skip header and separator row
        for line in lines[start_idx:]:
            if "|" not in line or line.strip().startswith("<!--"):
                continue
            cells = [c.strip() for c in line.split("|")[1:-1]]
            if len(cells) < len(headers):
                continue

            job = self._extract_job_from_cells(cells, column_map)
            if job and job.url:
                jobs.append(job)

        return jobs

    def extract_link_from_cell(self, cell: str) -> Optional[str]:
        """Extract URL from markdown link syntax [text](url)."""
        match = re.search(r'\[([^\]]*)\]\(([^)]+)\)', cell)
        if match:
            return match.group(2)
        # Check if cell is a plain URL
        if cell.startswith("http://") or cell.startswith("https://"):
            return cell.strip()
        return None

    async def poll_all_sources(self) -> int:
        """Poll all active GitHub sources. Returns count of new jobs added."""
        sources = (
            self.db.query(GitHubSource)
            .filter(GitHubSource.status == "active")
            .all()
        )
        total_new = 0

        for source in sources:
            try:
                jobs = await self.fetch_jobs(source)
                new_count = await self._store_jobs(jobs, source)
                total_new += new_count

                # Update source status
                source.last_polled_at = datetime.datetime.utcnow()
                source.status = "active"
                source.error_message = ""
                self.db.commit()
            except Exception as e:
                logger.error(f"Error polling {source.repo_url}: {e}")
                source.status = "error"
                source.error_message = str(e)[:500]
                self.db.commit()

        return total_new

    def _map_columns_to_fields(self, headers: list[str]) -> dict[int, str]:
        """Map column indices to field names using keyword matching."""
        column_map: dict[int, str] = {}
        for i, header in enumerate(headers):
            lower = header.lower().strip()
            if any(kw in lower for kw in ["company", "org"]):
                column_map[i] = "company"
            elif any(kw in lower for kw in ["role", "title", "position", "job"]):
                column_map[i] = "title"
            elif any(kw in lower for kw in ["location", "loc"]):
                column_map[i] = "location"
            elif any(kw in lower for kw in ["link", "apply", "application", "url"]):
                column_map[i] = "url"
            elif any(kw in lower for kw in ["date", "posted"]):
                column_map[i] = "posted_date"
        return column_map

    def _extract_job_from_cells(
        self, cells: list[str], column_map: dict[int, str]
    ) -> Optional[ParsedJob]:
        """Extract a ParsedJob from table cells using the column map."""
        data: dict = {}
        for idx, field in column_map.items():
            if idx < len(cells):
                cell = cells[idx]
                if field == "url":
                    data[field] = self.extract_link_from_cell(cell) or ""
                elif field == "posted_date":
                    data[field] = self._parse_date(cell)
                elif field in ("company", "title"):
                    # Company/title might also contain links
                    link = self.extract_link_from_cell(cell)
                    # Use the text part, not the URL
                    text_match = re.search(r'\[([^\]]+)\]', cell)
                    data[field] = text_match.group(1) if text_match else cell
                    # If URL field not yet set and this has a link, use it
                    if link and "url" not in data:
                        data["url"] = link
                else:
                    data[field] = cell

        if not data.get("url") or not data.get("title"):
            return None

        return ParsedJob(
            title=data.get("title", ""),
            company=data.get("company", ""),
            location=data.get("location", ""),
            url=data.get("url", ""),
            posted_date=data.get("posted_date"),
        )

    def _parse_date(self, date_str: str) -> Optional[datetime.datetime]:
        """Parse various date formats from GitHub job tables."""
        date_str = date_str.strip()
        if not date_str:
            return None

        formats = [
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%b %d, %Y",
            "%B %d, %Y",
            "%b %d",
            "%m/%d",
        ]
        for fmt in formats:
            try:
                dt = datetime.datetime.strptime(date_str, fmt)
                # If year is 1900 (no year in format), use current year
                if dt.year == 1900:
                    dt = dt.replace(year=datetime.datetime.utcnow().year)
                return dt
            except ValueError:
                continue
        return None

    async def _store_jobs(
        self, jobs: list[ParsedJob], source: GitHubSource
    ) -> int:
        """Store parsed jobs in the database, deduplicating by URL.

        Returns count of new jobs added.
        """
        new_count = 0
        for job in jobs:
            # Check for existing job with same URL
            existing = (
                self.db.query(ScrapedJob)
                .filter(ScrapedJob.url == job.url)
                .first()
            )
            if existing:
                continue

            scraped_job = ScrapedJob(
                title=job.title,
                company=job.company,
                location=job.location,
                url=job.url,
                description="",
                source_platform="github",
                github_source_id=source.id,
                posted_date=job.posted_date,
                easy_apply=0,
            )
            self.db.add(scraped_job)
            new_count += 1

        if new_count > 0:
            self.db.commit()
        return new_count


def validate_github_repo_url(url: str) -> bool:
    """Validate that a URL points to a valid GitHub repository.

    Valid format: https://github.com/{owner}/{repo} (with optional trailing slash)
    """
    pattern = r'^https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+/?$'
    return bool(re.match(pattern, url))
