"""
AggregatorService — orchestrates scraping, classification, and storage of jobs
from jobright-ai GitHub repositories.

Pipeline: seed sources → check commit SHA → fetch README → parse markdown →
classify (country, work_type, role_category) → deduplicate by URL → store.
"""

import os
import logging
import datetime
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from backend.db.models import GitHubSource, ScrapedJob
from backend.services.markdown_parser import MarkdownParser, ParsedJob
from backend.services.country_filter import CountryFilter
from backend.services.work_type_classifier import WorkTypeClassifier

logger = logging.getLogger(__name__)

GITHUB_API_BASE = "https://api.github.com"


class AggregatorService:
    """Orchestrates scraping, classification, and storage of jobs from GitHub sources."""

    REPOS: list[dict] = [
        {
            "url": "https://github.com/jobright-ai/2026-Software-Engineer-New-Grad",
            "category": "Software Engineering",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Data-Analysis-New-Grad",
            "category": "Data Analysis",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Engineering-New-Grad",
            "category": "Engineering and Development",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Account-New-Grad",
            "category": "Accounting and Finance",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Consultant-New-Grad",
            "category": "Consultant",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Design-New-Grad",
            "category": "Creatives and Design",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Product-Management-New-Grad",
            "category": "Product Management",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Management-New-Grad",
            "category": "Management and Executive",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Internship",
            "category": "",
            "level": "internship",
        },
    ]

    REPO_CATEGORY_MAP: dict[str, str] = {
        "2026-Software-Engineer-New-Grad": "Software Engineering",
        "2026-Data-Analysis-New-Grad": "Data Analysis",
        "2026-Engineering-New-Grad": "Engineering and Development",
        "2026-Account-New-Grad": "Accounting and Finance",
        "2026-Consultant-New-Grad": "Consultant",
        "2026-Design-New-Grad": "Creatives and Design",
        "2026-Product-Management-New-Grad": "Product Management",
        "2026-Management-New-Grad": "Management and Executive",
        "2026-Internship": "",
    }

    def __init__(self, db: Session):
        self.db = db
        self.parser = MarkdownParser()
        self.country_filter = CountryFilter()
        self.work_type_classifier = WorkTypeClassifier()

    async def seed_sources(self) -> dict[str, int]:
        """Create GitHubSource records for all 9 repos. Idempotent.

        Returns {"created": N, "existing": M}
        """
        created = 0
        existing = 0

        for repo_config in self.REPOS:
            repo_url = repo_config["url"]

            # Check if source already exists
            source = (
                self.db.query(GitHubSource)
                .filter(GitHubSource.repo_url == repo_url)
                .first()
            )

            if source:
                existing += 1
                continue

            # Extract owner and repo name from URL
            # URL format: https://github.com/{owner}/{repo}
            parts = repo_url.rstrip("/").split("/")
            repo_owner = parts[-2]
            repo_name = parts[-1]

            new_source = GitHubSource(
                repo_url=repo_url,
                repo_owner=repo_owner,
                repo_name=repo_name,
                file_path="README.md",
                poll_interval_minutes=60,
                role_category=repo_config["category"],
                experience_level=repo_config["level"],
                status="active",
            )
            self.db.add(new_source)
            created += 1

        if created > 0:
            self.db.commit()

        return {"created": created, "existing": existing}

    async def poll_source(self, source: GitHubSource) -> int:
        """Poll a single source: check SHA → fetch → parse → classify → store.

        Returns count of new jobs added.
        """
        try:
            # Step 1: Check if commit SHA has changed
            changed, new_sha = await self._check_commit_sha(source)
            if not changed:
                return 0

            # Step 2: Fetch README content
            content = await self._fetch_readme(source)

            # Step 3: Determine if this is the mega-repo (Internship)
            is_mega_repo = "Internship" in source.repo_name

            # Step 4: Parse markdown content
            parsed_jobs = self.parser.parse(content, is_mega_repo=is_mega_repo)

            # Step 5: Classify and store each job
            new_count = 0
            for job in parsed_jobs:
                stored = self._classify_and_store(job, source)
                if stored:
                    new_count += 1

            # Step 6: Update source metadata
            source.last_polled_at = datetime.datetime.utcnow()
            source.last_commit_sha = new_sha
            source.status = "active"
            source.error_message = ""
            self.db.commit()

            return new_count

        except httpx.HTTPStatusError as e:
            logger.error(
                "GitHub API error polling %s: %s", source.repo_url, str(e)
            )
            source.status = "error"
            source.error_message = f"HTTP {e.response.status_code}: {str(e)[:400]}"
            self.db.commit()
            return 0

        except httpx.TimeoutException as e:
            logger.error(
                "Timeout polling %s: %s", source.repo_url, str(e)
            )
            source.status = "error"
            source.error_message = f"Timeout: {str(e)[:400]}"
            self.db.commit()
            return 0

        except Exception as e:
            logger.warning(
                "Error polling %s: %s", source.repo_url, str(e)
            )
            return 0

    async def poll_all_sources(self) -> dict[str, int]:
        """Poll all active sources. Returns summary of results."""
        sources = (
            self.db.query(GitHubSource)
            .filter(GitHubSource.status == "active")
            .all()
        )

        results: dict[str, int] = {}
        for source in sources:
            count = await self.poll_source(source)
            results[source.repo_name] = count

        return results

    async def _check_commit_sha(self, source: GitHubSource) -> tuple[bool, str]:
        """Check if commit SHA has changed using GitHub API.

        Returns (changed, new_sha). If the SHA is the same as stored,
        returns (False, current_sha).
        """
        url = (
            f"{GITHUB_API_BASE}/repos/{source.repo_owner}/"
            f"{source.repo_name}/commits?per_page=1"
        )

        headers = self._get_github_headers()

        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers, timeout=30)
            response.raise_for_status()
            commits = response.json()

        if not commits:
            return False, source.last_commit_sha or ""

        new_sha = commits[0]["sha"]
        changed = new_sha != source.last_commit_sha
        return changed, new_sha

    async def _fetch_readme(self, source: GitHubSource) -> str:
        """Fetch raw README content from GitHub API."""
        url = (
            f"{GITHUB_API_BASE}/repos/{source.repo_owner}/"
            f"{source.repo_name}/contents/{source.file_path}"
        )

        headers = self._get_github_headers()
        headers["Accept"] = "application/vnd.github.v3.raw"

        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers, timeout=60)
            response.raise_for_status()
            return response.text

    def _get_github_headers(self) -> dict[str, str]:
        """Build GitHub API request headers, including auth token if available."""
        headers: dict[str, str] = {
            "Accept": "application/vnd.github+json",
        }
        token = os.getenv("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _get_experience_level(self, source: GitHubSource) -> str:
        """Returns 'internship' or 'new_grad' based on source repo name."""
        if "Internship" in source.repo_name:
            return "internship"
        return "new_grad"

    def _classify_and_store(self, job: ParsedJob, source: GitHubSource) -> bool:
        """Classify a parsed job and store it if it passes filters.

        Returns True if the job was stored, False if skipped (duplicate or excluded).
        """
        # Classify country
        country = self.country_filter.classify(job.location)
        if country is None:
            # Exclude non-US/CA jobs
            return False

        # Classify work type
        work_type = self.work_type_classifier.classify(job.location)

        # Determine role category: use section_category from parser if available,
        # otherwise fall back to source.role_category
        role_category = job.section_category if job.section_category else source.role_category

        # Determine experience level
        experience_level = self._get_experience_level(source)

        # Deduplication: check if URL already exists
        existing = (
            self.db.query(ScrapedJob)
            .filter(ScrapedJob.url == job.url)
            .first()
        )
        if existing:
            return False

        # Store the job
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
            work_type=work_type,
            role_category=role_category,
            country=country,
            experience_level=experience_level,
            company_logo=job.company_logo or "",
        )
        self.db.add(scraped_job)
        try:
            self.db.commit()
        except Exception:
            # Duplicate URL or other constraint violation — rollback and skip
            self.db.rollback()
            return False
        return True
