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
from backend.services.logo_resolver import resolve_logo

logger = logging.getLogger(__name__)

GITHUB_API_BASE = "https://api.github.com"


class AggregatorService:
    """Orchestrates scraping, classification, and storage of jobs from GitHub sources."""

    REPOS: list[dict] = [
        # === Community repos with DIRECT company apply links ===
        {
            "url": "https://github.com/Ouckah/Summer2025-Internships",
            "category": "Software Engineering",
            "level": "internship",
        },
        {
            "url": "https://github.com/vanshb03/New-Grad-2027",
            "category": "Software Engineering",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/speedyapply/2026-SWE-College-Jobs",
            "category": "Software Engineering",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/negarprh/Canadian-Tech-Internships-2026",
            "category": "Software Engineering",
            "level": "internship",
        },
        {
            "url": "https://github.com/zapplyjobs/New-Grad-Jobs-2026",
            "category": "",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2026",
            "category": "Software Engineering",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2026",
            "category": "Data Analysis",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/zapplyjobs/Internships-2026",
            "category": "",
            "level": "internship",
        },
        # === Jobright-AI Internship repos (2026) ===
        {
            "url": "https://github.com/jobright-ai/2026-Software-Engineer-Internship",
            "category": "Software Engineering",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Data-Analysis-Internship",
            "category": "Data Analysis",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Product-Management-Internship",
            "category": "Product Management",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Business-Analyst-Internship",
            "category": "Business Analyst",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Consultant-Internship",
            "category": "Consultant",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Marketing-Internship",
            "category": "Marketing",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Support-Internship",
            "category": "Customer Service and Support",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Education-Internship",
            "category": "Education and Training",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Public-Sector-Internship",
            "category": "Public Sector and Government",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-HR-Internship",
            "category": "Human Resources",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Legal-Internship",
            "category": "Legal and Compliance",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Art-Internship",
            "category": "Arts and Entertainment",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Sales-Internship",
            "category": "Sales",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Accounting-Internship",
            "category": "Accounting and Finance",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Design-Internship",
            "category": "Creatives and Design",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Management-Internship",
            "category": "Management and Executive",
            "level": "internship",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Engineering-Internship",
            "category": "Engineering and Development",
            "level": "internship",
        },
        # === Jobright-AI New Grad repos (2026) ===
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
            "url": "https://github.com/jobright-ai/2026-Product-Management-New-Grad",
            "category": "Product Management",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Business-Analyst-New-Grad",
            "category": "Business Analyst",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Consultant-New-Grad",
            "category": "Consultant",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Marketing-New-Grad",
            "category": "Marketing",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Support-New-Grad",
            "category": "Customer Service and Support",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Education-New-Grad",
            "category": "Education and Training",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Public-Sector-New-Grad",
            "category": "Public Sector and Government",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-HR-New-Grad",
            "category": "Human Resources",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Legal-New-Grad",
            "category": "Legal and Compliance",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Art-New-Grad",
            "category": "Arts and Entertainment",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Sales-New-Grad",
            "category": "Sales",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Accounting-New-Grad",
            "category": "Accounting and Finance",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Design-New-Grad",
            "category": "Creatives and Design",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Management-New-Grad",
            "category": "Management and Executive",
            "level": "new_grad",
        },
        {
            "url": "https://github.com/jobright-ai/2026-Engineering-New-Grad",
            "category": "Engineering and Development",
            "level": "new_grad",
        },
        # === Jobright-AI H1B Sponsorship repo ===
        {
            "url": "https://github.com/jobright-ai/Daily-H1B-Jobs-In-Tech",
            "category": "",
            "level": "new_grad",
        },
    ]

    REPO_CATEGORY_MAP: dict[str, str] = {
        "Summer2025-Internships": "Software Engineering",
        "New-Grad-2027": "Software Engineering",
        "2026-SWE-College-Jobs": "Software Engineering",
        "Canadian-Tech-Internships-2026": "Software Engineering",
        "New-Grad-Jobs-2026": "",
        "New-Grad-Software-Engineering-Jobs-2026": "Software Engineering",
        "New-Grad-Data-Science-Jobs-2026": "Data Analysis",
        "Internships-2026": "",
        # Jobright-AI repos
        "2026-Software-Engineer-Internship": "Software Engineering",
        "2026-Data-Analysis-Internship": "Data Analysis",
        "2026-Product-Management-Internship": "Product Management",
        "2026-Business-Analyst-Internship": "Business Analyst",
        "2026-Consultant-Internship": "Consultant",
        "2026-Marketing-Internship": "Marketing",
        "2026-Support-Internship": "Customer Service and Support",
        "2026-Education-Internship": "Education and Training",
        "2026-Public-Sector-Internship": "Public Sector and Government",
        "2026-HR-Internship": "Human Resources",
        "2026-Legal-Internship": "Legal and Compliance",
        "2026-Art-Internship": "Arts and Entertainment",
        "2026-Sales-Internship": "Sales",
        "2026-Accounting-Internship": "Accounting and Finance",
        "2026-Design-Internship": "Creatives and Design",
        "2026-Management-Internship": "Management and Executive",
        "2026-Engineering-Internship": "Engineering and Development",
        "2026-Software-Engineer-New-Grad": "Software Engineering",
        "2026-Data-Analysis-New-Grad": "Data Analysis",
        "2026-Product-Management-New-Grad": "Product Management",
        "2026-Business-Analyst-New-Grad": "Business Analyst",
        "2026-Consultant-New-Grad": "Consultant",
        "2026-Marketing-New-Grad": "Marketing",
        "2026-Support-New-Grad": "Customer Service and Support",
        "2026-Education-New-Grad": "Education and Training",
        "2026-Public-Sector-New-Grad": "Public Sector and Government",
        "2026-HR-New-Grad": "Human Resources",
        "2026-Legal-New-Grad": "Legal and Compliance",
        "2026-Art-New-Grad": "Arts and Entertainment",
        "2026-Sales-New-Grad": "Sales",
        "2026-Accounting-New-Grad": "Accounting and Finance",
        "2026-Design-New-Grad": "Creatives and Design",
        "2026-Management-New-Grad": "Management and Executive",
        "2026-Engineering-New-Grad": "Engineering and Development",
        "Daily-H1B-Jobs-In-Tech": "",
    }

    def __init__(self, db: Session):
        self.db = db
        self.parser = MarkdownParser()
        self.country_filter = CountryFilter()
        self.work_type_classifier = WorkTypeClassifier()

    async def seed_sources(self) -> dict[str, int]:
        """Create GitHubSource records for all configured repos. Idempotent.

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
        # Reject jobright redirect URLs — we only want direct company links
        if "jobright.ai" in job.url:
            return False

        # Classify country
        country = self.country_filter.classify(job.location)
        if country is None:
            # Exclude non-US/CA jobs
            return False

        # Work type: prefer the jobright "Work Model" column when present,
        # otherwise infer it from the location string.
        work_type = job.work_model or self.work_type_classifier.classify(job.location)

        # Determine role category: use section_category from parser if available,
        # otherwise fall back to source.role_category
        role_category = job.section_category if job.section_category else source.role_category

        # Determine experience level
        experience_level = self._get_experience_level(source)

        # Resolve an accurate company logo + domain. The parser already resolves
        # these from the company website URL; resolve again as a safety net for
        # rows that lacked a website link.
        company_logo = job.company_logo or ""
        company_domain = job.company_domain or ""
        if not company_domain:
            company_logo, company_domain = resolve_logo(job.company, job.company_url)

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
            company_logo=company_logo,
            company_domain=company_domain,
            company_url=job.company_url or "",
        )
        self.db.add(scraped_job)
        try:
            self.db.commit()
        except Exception:
            # Duplicate URL or other constraint violation — rollback and skip
            self.db.rollback()
            return False
        return True
