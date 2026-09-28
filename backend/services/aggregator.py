"""
AggregatorService, orchestrates scraping, classification, and storage of jobs
from jobright-ai GitHub repositories.

Pipeline: seed sources → check commit SHA → fetch README → parse markdown →
classify (country, work_type, role_category) → deduplicate by URL → store.
"""

import os
import re
import logging
import datetime
from typing import Optional

import httpx
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from backend.db.models import GitHubSource, ScrapedJob
from backend.services.markdown_parser import (
    MarkdownParser,
    ParsedJob,
    clean_cell_text,
    clean_company_name,
    is_job_url,
    is_list_vendor_url,
)
from backend.services.country_filter import CountryFilter
from backend.services.work_type_classifier import WorkTypeClassifier
from backend.services.logo_cache import brand, load_branding, logo_quality
from backend.services.logo_resolver import domain_from_url, resolve_logo
from backend.services.location_parser import location_fields

logger = logging.getLogger(__name__)

GITHUB_API_BASE = "https://api.github.com"

# GitHub statuses meaning the repo itself is gone. Every other failure (5xx,
# 403/429 rate limits, timeouts) clears on a later poll, so the source stays
# in rotation instead of being parked in 'error' forever by one bad minute.
PERMANENT_HTTP_STATUSES = frozenset({404, 410, 451})

# How long a source parked in 'error' by a transient failure waits before
# cron-poll tries it again.
ERROR_RETRY_COOLDOWN = datetime.timedelta(hours=12)

# A re-parse that would retire more than this share of a source's visible rows
# as "gone from the README" is a format change, not a mass closure.
_VANISHED_GUARD_RATIO = 0.5
_VANISHED_GUARD_MIN = 10


class RepoMovedError(Exception):
    """The repo was renamed to one another source already tracks."""


def is_retryable_error(message: str) -> bool:
    """True when a source parked in 'error' failed for a reason a later poll
    can clear. Includes the 301s recorded before redirects were followed:
    those repos were renamed, and the rename is now adopted on poll."""
    match = re.match(r"HTTP (\d{3})\b", message or "")
    if match:
        return int(match.group(1)) not in PERMANENT_HTTP_STATUSES
    return (message or "").startswith(("Timeout", "Network"))


def _listing_key(company: str, title: str) -> tuple[str, str]:
    """Company + title folded for matching a closed list row to a stored one
    (stored GitHub companies may still carry the old '**Name**' emphasis)."""
    return (clean_company_name(company).lower(),
            " ".join(clean_cell_text(title).lower().split()))


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

        Returns count of new jobs added. Always updates last_polled_at so cron
        rotation advances even when the README commit has not changed.
        """
        try:
            changed, new_sha = await self._check_commit_sha(source)
            new_count = 0

            if changed:
                content = await self._fetch_readme(source)
                is_mega_repo = "Internship" in source.repo_name
                listed = self.parser.parse(
                    content, is_mega_repo=is_mega_repo, include_closed=True
                )
                parsed_jobs = [job for job in listed if not job.closed]
                closed_jobs = [job for job in listed if job.closed]
                listed_urls = self._listed_urls(parsed_jobs)

                # The lists re-publish postings employers already closed,
                # verify genuinely-new URLs before they become catalogue rows
                # a user can click into a 404.
                dead_urls = await self._probe_new_urls(parsed_jobs)

                for job in parsed_jobs:
                    stored = self._classify_and_store(job, source, dead_urls=dead_urls)
                    if stored:
                        new_count += 1

                self._retire_delisted_rows(source, listed_urls, closed_jobs)
                source.last_commit_sha = new_sha
                await self._enrich_missing_descriptions(source.id, limit=8)

            source.last_polled_at = datetime.datetime.utcnow()
            source.status = "active"
            source.error_message = ""
            self.db.commit()
            return new_count

        except RepoMovedError as e:
            logger.warning("GitHub source %s: %s", source.repo_url, str(e))
            source.status = "error"
            source.error_message = str(e)[:500]
            source.last_polled_at = datetime.datetime.utcnow()
            self.db.commit()
            return 0

        except httpx.HTTPStatusError as e:
            logger.error(
                "GitHub API error polling %s: %s", source.repo_url, str(e)
            )
            # Only a repo that is gone for good leaves the rotation; a 5xx or
            # rate limit is retried on the next poll like any other source.
            if e.response.status_code in PERMANENT_HTTP_STATUSES:
                source.status = "error"
            source.error_message = f"HTTP {e.response.status_code}: {str(e)[:400]}"
            source.last_polled_at = datetime.datetime.utcnow()
            self.db.commit()
            return 0

        except httpx.TransportError as e:
            kind = "Timeout" if isinstance(e, httpx.TimeoutException) else "Network"
            logger.error(
                "%s polling %s: %s", kind, source.repo_url, str(e)
            )
            source.error_message = f"{kind}: {str(e)[:400]}"
            source.last_polled_at = datetime.datetime.utcnow()
            self.db.commit()
            return 0

        except Exception as e:
            logger.warning(
                "Error polling %s: %s", source.repo_url, str(e)
            )
            # Still advance the rotation, or one broken README would hold the
            # head of every cron-poll batch.
            try:
                self.db.rollback()
                source.error_message = f"Error: {str(e)[:400]}"
                source.last_polled_at = datetime.datetime.utcnow()
                self.db.commit()
            except Exception:
                self.db.rollback()
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

    def sources_due(self, limit: int = 5,
                    now: Optional[datetime.datetime] = None) -> list[GitHubSource]:
        """The next sources cron-poll should poll: least-recently polled first,
        active ones plus 'error' ones whose failure was transient once they have
        cooled down (a single 504 or a repo rename used to park a source for good).
        """
        now = now or datetime.datetime.utcnow()
        retry_before = now - ERROR_RETRY_COOLDOWN
        # A few dozen rows at most: filter the retry rule in Python.
        candidates = (
            self.db.query(GitHubSource)
            .filter(GitHubSource.status.in_(("active", "error")))
            .all()
        )
        due = [
            source for source in candidates
            if source.status == "active" or (
                is_retryable_error(source.error_message)
                and (source.last_polled_at is None or source.last_polled_at < retry_before)
            )
        ]
        due.sort(key=lambda s: (s.last_polled_at is not None,
                                s.last_polled_at or datetime.datetime.min))
        return due[:limit]

    def _github_client(self, timeout: float) -> httpx.AsyncClient:
        """GitHub API client. Follows redirects: a renamed repo answers 301."""
        return httpx.AsyncClient(follow_redirects=True, timeout=timeout)

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

        async with self._github_client(timeout=30) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            commits = response.json()
            if response.history:
                # Renamed repo: GitHub redirected to /repositories/{id}. Adopt
                # the new name so the README fetch and later polls go direct.
                await self._adopt_repo_rename(client, source, headers)

        if not commits:
            return False, source.last_commit_sha or ""

        new_sha = commits[0]["sha"]
        changed = new_sha != source.last_commit_sha
        return changed, new_sha

    async def _adopt_repo_rename(self, client: httpx.AsyncClient,
                                 source: GitHubSource, headers: dict) -> None:
        """Point ``source`` at its repo's current owner/name (the API's
        ``full_name``). Raises RepoMovedError when another source already
        tracks the new name, so the two never poll the same README."""
        response = await client.get(
            f"{GITHUB_API_BASE}/repos/{source.repo_owner}/{source.repo_name}",
            headers=headers,
        )
        response.raise_for_status()
        full_name = str((response.json() or {}).get("full_name") or "")
        owner, _, name = full_name.partition("/")
        if not owner or not name:
            return
        if (owner.lower(), name.lower()) == (source.repo_owner.lower(), source.repo_name.lower()):
            return

        repo_url = f"https://github.com/{owner}/{name}"
        tracked = (
            self.db.query(GitHubSource.id)
            .filter(func.lower(GitHubSource.repo_url) == repo_url.lower(),
                    GitHubSource.id != source.id)
            .first()
        )
        if tracked:
            raise RepoMovedError(f"Renamed to {full_name}, already tracked by source {tracked[0]}")

        logger.info("GitHub source %s renamed to %s", source.repo_url, full_name)
        source.repo_owner = owner
        source.repo_name = name
        source.repo_url = repo_url

    async def _fetch_readme(self, source: GitHubSource) -> str:
        """Fetch raw README content from GitHub API."""
        url = (
            f"{GITHUB_API_BASE}/repos/{source.repo_owner}/"
            f"{source.repo_name}/contents/{source.file_path}"
        )

        headers = self._get_github_headers()
        headers["Accept"] = "application/vnd.github.v3.raw"

        async with self._github_client(timeout=60) as client:
            response = await client.get(url, headers=headers)
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

    def _get_experience_level(self, source: GitHubSource, title: str = "") -> str:
        """Returns 'internship' or 'new_grad' based on source repo name, or on
        the title for mixed lists (speedyapply's README is all internships)."""
        if "Internship" in source.repo_name:
            return "internship"
        title_lower = (title or "").lower()
        if "intern" in title_lower or "co-op" in title_lower or "coop" in title_lower:
            return "internship"
        return "new_grad"

    async def _probe_new_urls(self, parsed_jobs: list[ParsedJob]) -> set[str]:
        """Liveness-check the parsed URLs that aren't in the catalogue yet.

        Returns the set of canonical URLs that answered an honest 404/410.
        Bounded (probe budget + timeouts); URLs past the budget pass through
        unverified and the hourly verify sweep catches them later.
        """
        from backend.services.cross_source_dedup import canonical_url
        from backend.services.description_extractor import BROWSER_HEADERS
        from backend.services.listing_freshness import probe_urls_liveness

        candidates: list[str] = []
        seen: set[str] = set()
        for job in parsed_jobs:
            url = canonical_url(job.url or "")
            if url and url not in seen and not is_list_vendor_url(url):
                seen.add(url)
                candidates.append(url)
        if not candidates:
            return set()

        known: set[str] = set()
        for i in range(0, len(candidates), 400):
            chunk = candidates[i:i + 400]
            known.update(
                row[0] for row in
                self.db.query(ScrapedJob.url).filter(ScrapedJob.url.in_(chunk)).all()
            )
        fresh = [u for u in candidates if u not in known]
        if not fresh:
            return set()

        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=10,
                                         headers=BROWSER_HEADERS) as client:
                verdicts = await probe_urls_liveness(client, fresh, budget=80)
        except Exception:
            return set()
        return {url for url, verdict in verdicts.items() if verdict == "dead"}

    @staticmethod
    def _listed_urls(jobs: list[ParsedJob]) -> set[str]:
        """Every form a listed URL may be stored under: raw (rows stored before
        canonical_url existed kept '?utm_source=vansh') and canonical."""
        from backend.services.cross_source_dedup import canonical_url

        urls: set[str] = set()
        for job in jobs:
            if job.url:
                urls.add(job.url)
                urls.add(canonical_url(job.url))
        return urls

    def _retire_delisted_rows(self, source: GitHubSource, listed_urls: set[str],
                              closed_jobs: list[ParsedJob]) -> dict[str, int]:
        """Soft-remove this source's visible rows the list stopped offering.

        - closed: the list now marks the posting closed (🔒 / strikethrough).
          Those rows drop the link, so they match on company + title.
        - vanished: the URL is gone from the README we just re-parsed in full.

        A URL the list still shows open is never touched. A re-parse that would
        retire most of the source's rows as vanished is a README format change,
        not a mass closure, so only the closed matches are applied then.
        Column-only reads and updates; the caller commits.
        """
        from backend.services.cross_source_dedup import canonical_url
        from backend.services.listing_freshness import HIDDEN_LISTING_STATUSES, LISTING_REMOVED

        rows = (
            self.db.query(ScrapedJob.id, ScrapedJob.url, ScrapedJob.company, ScrapedJob.title)
            .filter(
                ScrapedJob.github_source_id == source.id,
                or_(ScrapedJob.listing_status.is_(None),
                    ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES)),
            )
            .all()
        )
        closed_keys = {_listing_key(job.company, job.title) for job in closed_jobs}
        closed_urls = self._listed_urls([job for job in closed_jobs if job.url]) - listed_urls

        closed_ids: list[int] = []
        vanished_ids: list[int] = []
        for row_id, url, company, title in rows:
            url = url or ""
            if url in listed_urls or canonical_url(url) in listed_urls:
                continue
            if (url in closed_urls or canonical_url(url) in closed_urls
                    or _listing_key(company or "", title or "") in closed_keys):
                closed_ids.append(row_id)
            else:
                vanished_ids.append(row_id)

        if vanished_ids and (
            not listed_urls
            or len(vanished_ids) > max(_VANISHED_GUARD_MIN, len(rows) * _VANISHED_GUARD_RATIO)
        ):
            logger.warning(
                "GitHub source %s: %d of %d rows missing from the README, "
                "not retiring them (parse likely broken)",
                source.repo_url, len(vanished_ids), len(rows),
            )
            vanished_ids = []

        now = datetime.datetime.utcnow()
        retired = closed_ids + vanished_ids
        for i in range(0, len(retired), 400):
            chunk = retired[i:i + 400]
            self.db.query(ScrapedJob).filter(ScrapedJob.id.in_(chunk)).update(
                {"listing_status": LISTING_REMOVED, "listing_status_changed_at": now},
                synchronize_session=False,
            )
        if closed_ids or vanished_ids:
            logger.info("GitHub source %s: retired %d closed, %d vanished rows",
                        source.repo_url, len(closed_ids), len(vanished_ids))
        return {"closed": len(closed_ids), "vanished": len(vanished_ids)}

    def _classify_and_store(self, job: ParsedJob, source: GitHubSource,
                            dead_urls: frozenset | set = frozenset()) -> bool:
        """Classify a parsed job and store it if it passes filters.

        Returns True if the job was stored, False if skipped (duplicate or
        excluded). URLs in ``dead_urls`` are stored as already-removed: the
        catalogue never shows them, and remembering the URL stops the next
        poll from re-discovering and re-probing the same dead posting.
        """
        # Reject list-vendor redirect URLs (jobright.ai, zapply.jobs): we only
        # want direct company links
        if is_list_vendor_url(job.url):
            return False
        # Malformed links ('https:/.workable.com/...') are dead on arrival.
        if not is_job_url(job.url):
            return False

        # Same posting, different utm_* decorations must collide on the URL
        # unique constraint instead of slipping in twice.
        from backend.services.cross_source_dedup import canonical_url
        job.url = canonical_url(job.url)

        # A list date is a publish date, never a future one: a future date tops
        # the date-sorted feed and never ages past the expiry cutoff.
        if job.posted_date and job.posted_date > datetime.datetime.utcnow():
            job.posted_date = datetime.datetime.utcnow()

        # Classify country
        country = self.country_filter.classify(job.location)
        if country is None:
            # Exclude non-US/CA jobs
            return False

        # Work type: prefer the jobright "Work Model" column when present,
        # otherwise infer it from the location string.
        work_type = job.work_model or self.work_type_classifier.classify(job.location)

        # Determine role category, normalised to the canonical taxonomy:
        #   1. section header from the parser (mega-repos), else
        #   2. the source repo's configured category, else
        #   3. classify from the job title.
        from backend.services.role_classifier import classify, normalize_category

        raw_category = job.section_category or source.role_category or ""
        role_category = normalize_category(raw_category) or (
            raw_category if raw_category else ""
        )
        if not role_category:
            role_category = classify(job.title)

        # Determine experience level
        experience_level = self._get_experience_level(source, job.title)

        # Resolve an accurate company logo + domain. The parser already resolves
        # these from the company website URL; without one its domain is a name
        # guess, and an employer-hosted apply link (carvana.com/careers/...)
        # is better evidence.
        company_logo = job.company_logo or ""
        company_domain = job.company_domain or ""
        if not company_domain or not domain_from_url(job.company_url):
            resolved_logo, company_domain = resolve_logo(
                job.company, job.company_url, apply_url=job.url
            )
            if logo_quality(company_logo) == 0:
                company_logo = resolved_logo

        # Deduplication: check if URL already exists. Query the column, not the
        # entity: loading the row pulls its description over the wire for a boolean.
        existing = (
            self.db.query(ScrapedJob.url)
            .filter(ScrapedJob.url == job.url)
            .first()
        )
        if existing:
            return False

        # Store the job
        from backend.services.cross_source_dedup import mark_inferior_twins, normalize_title
        from backend.services.listing_freshness import LISTING_ACTIVE, LISTING_REMOVED

        now = datetime.datetime.utcnow()
        is_dead = job.url in dead_urls
        # A self-hosted logo (and verified domain) from the logo store wins.
        company_logo, company_domain = brand(
            load_branding(self.db, [job.company]), job.company, company_logo, company_domain
        )

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
            title_norm=normalize_title(job.title),
            listing_status=LISTING_REMOVED if is_dead else LISTING_ACTIVE,
            listing_status_changed_at=now if is_dead else None,
            first_seen_at=now,
            last_seen_at=now,
            source_trust="medium",
            **location_fields(job.location),
        )
        self.db.add(scraped_job)
        try:
            self.db.commit()
        except Exception:
            # Duplicate URL or other constraint violation, rollback and skip
            self.db.rollback()
            return False

        if is_dead:
            return False  # remembered, hidden, not a new catalogue job

        # This direct row supersedes LinkedIn/Indeed copies that arrived first.
        try:
            mark_inferior_twins(self.db, scraped_job)
        except Exception:
            self.db.rollback()
        return True

    async def _enrich_missing_descriptions(
        self, source_id: int | None = None, limit: int = 10
    ) -> int:
        """Fetch descriptions for jobs that only have metadata + apply URL."""
        from sqlalchemy import or_
        from backend.services.description_extractor import (
            BROWSER_HEADERS,
            extract_description_from_url,
            sanitize_description,
        )

        from backend.services.listing_freshness import HIDDEN_LISTING_STATUSES

        query = self.db.query(ScrapedJob).filter(
            or_(ScrapedJob.description == "", ScrapedJob.description.is_(None)),
            or_(ScrapedJob.listing_status.is_(None),
                ScrapedJob.listing_status.notin_(HIDDEN_LISTING_STATUSES)),
        )
        if source_id is not None:
            query = query.filter(ScrapedJob.github_source_id == source_id)
        jobs = query.order_by(ScrapedJob.id.desc()).limit(limit).all()

        enriched = 0
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
            for job in jobs:
                if not job.url:
                    continue
                try:
                    description = await extract_description_from_url(client, job.url)
                    if description:
                        job.description = sanitize_description(description)
                        enriched += 1
                except Exception as exc:
                    logger.debug("Description enrich failed for job %s: %s", job.id, exc)

        if enriched:
            self.db.commit()
        return enriched
