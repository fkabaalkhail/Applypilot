"""
SmartFilter — evaluates jobs against user-defined filter rules before applying.

Checks: company blacklist, keyword blacklist, salary range, experience range,
and duplicate detection via ApplicationRecord.

Requirements: 7.1–7.11
"""

import logging
from backend.db.models import ScrapedJob, ApplicationRecord

logger = logging.getLogger(__name__)


class SmartFilter:
    """Evaluate a ScrapedJob against user-configured filter rules.

    Usage::

        sf = SmartFilter(settings)
        passes, reason = sf.evaluate(job, db)
        if not passes:
            job.skip_reason = reason
    """

    def __init__(self, settings: dict):
        self.company_blacklist: list[str] = [
            c.lower().strip()
            for c in (settings.get("company_blacklist") or [])
            if c and c.strip()
        ]
        self.keyword_blacklist: list[str] = [
            k.lower().strip()
            for k in (settings.get("keyword_blacklist") or [])
            if k and k.strip()
        ]
        self.min_salary: int | None = settings.get("min_salary")
        self.max_salary: int | None = settings.get("max_salary")
        self.min_experience_years: int | None = settings.get("min_experience_years")
        self.max_experience_years: int | None = settings.get("max_experience_years")

    def evaluate(self, job: ScrapedJob, db) -> tuple[bool, str]:
        """Run all filter checks on *job*.

        Returns ``(True, "")`` if the job passes all filters, or
        ``(False, skip_reason)`` on the first failing check.
        """
        # Checks that need db access
        reason = self._check_already_applied(job, db)
        if reason:
            return False, reason

        # Checks that only need the job
        for check in [
            self._check_company_blacklist,
            self._check_keyword_blacklist,
            self._check_salary_range,
            self._check_experience_range,
        ]:
            reason = check(job)
            if reason:
                return False, reason

        return True, ""

    # ------------------------------------------------------------------
    # Individual filter checks — return a reason string or None
    # ------------------------------------------------------------------

    def _check_company_blacklist(self, job: ScrapedJob) -> str | None:
        """Req 7.6 — case-insensitive company name match."""
        if not self.company_blacklist:
            return None
        company = (job.company or "").lower().strip()
        if not company:
            return None
        for blocked in self.company_blacklist:
            if blocked == company:
                return f"company_blacklisted:{blocked}"
        return None

    def _check_keyword_blacklist(self, job: ScrapedJob) -> str | None:
        """Req 7.5 — keyword search in job description."""
        if not self.keyword_blacklist:
            return None
        desc = (job.description or "").lower()
        if not desc:
            return None
        for kw in self.keyword_blacklist:
            if kw in desc:
                return f"keyword_blacklisted:{kw}"
        return None

    def _check_salary_range(self, job: ScrapedJob) -> str | None:
        """Req 7.4 — skip if salary entirely below user's minimum."""
        if self.min_salary is None:
            return None
        salary_str = getattr(job, "salary_range", "") or ""
        if not salary_str:
            return None
        max_offered = _parse_max_salary(salary_str)
        if max_offered is not None and max_offered < self.min_salary:
            return f"salary_below_minimum:{max_offered}<{self.min_salary}"
        return None

    def _check_experience_range(self, job: ScrapedJob) -> str | None:
        """Req 7.9, 7.10 — skip if required experience outside user's range."""
        required = getattr(job, "experience_years_required", None)
        if required is None:
            return None
        if self.max_experience_years is not None and required > self.max_experience_years:
            return f"overqualified_requirement:{required}>{self.max_experience_years}"
        if self.min_experience_years is not None and required < self.min_experience_years:
            return f"underqualified_for_role:{required}<{self.min_experience_years}"
        return None

    def _check_already_applied(self, job: ScrapedJob, db) -> str | None:
        """Req 3.2 — check ApplicationRecord by URL and job ID."""
        if db.query(ApplicationRecord).filter(
            ApplicationRecord.url == job.url
        ).first():
            return "duplicate_url"
        if job.id and db.query(ApplicationRecord).filter(
            ApplicationRecord.job_id == job.id
        ).first():
            return "duplicate_job_id"
        return None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _parse_max_salary(salary_str: str) -> int | None:
    """Extract the highest dollar figure from a salary string like '$100k - $150k'."""
    import re
    numbers = re.findall(r"\$?([\d,]+)\s*[kK]?", salary_str)
    if not numbers:
        return None
    values = []
    for n in numbers:
        raw = int(n.replace(",", ""))
        # Treat small numbers as thousands (e.g. "150k" → 150000)
        if raw < 1000:
            raw *= 1000
        values.append(raw)
    return max(values) if values else None
