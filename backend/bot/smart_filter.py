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
        
        # Location filter - user's allowed locations/regions
        self.allowed_locations: list[str] = []
        regions = settings.get("regions") or []
        location = settings.get("location") or ""
        if regions:
            self.allowed_locations = [r.lower().strip() for r in regions if r and r.strip()]
        elif location:
            self.allowed_locations = [location.lower().strip()]
        
        # Get user's country - check explicit country field first, then infer from city
        city = (settings.get("city") or "").lower()
        country_setting = (settings.get("country") or "").lower()
        self.user_country: str = ""
        
        # Check explicit country setting first
        if "canada" in country_setting:
            self.user_country = "canada"
        elif country_setting:
            self.user_country = country_setting
        else:
            # Infer country from city/location settings
            canadian_indicators = [
                "canada", "ontario", "quebec", "british columbia", "alberta", 
                "manitoba", "saskatchewan", "nova scotia", "new brunswick",
                "ottawa", "toronto", "vancouver", "montreal", "calgary", "edmonton",
                "winnipeg", "halifax", "victoria", "quebec city", "hamilton",
                "kitchener", "waterloo", "london, on", "mississauga", "brampton"
            ]
            
            for indicator in canadian_indicators:
                if indicator in city or indicator in location.lower():
                    self.user_country = "canada"
                    break

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
            self._check_location_filter,
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

    def _check_location_filter(self, job: ScrapedJob) -> str | None:
        """Filter jobs by location - skip US-only jobs if user is in Canada, etc."""
        job_location = (job.location or "").lower().strip()
        if not job_location:
            return None  # Can't filter without location info
        
        # If user is in Canada, skip jobs that are explicitly US-only
        if self.user_country == "canada":
            # Check for US-only indicators
            us_only_patterns = [
                "united states only",
                "us only",
                "usa only", 
                "must be located in the us",
                "must be in the us",
                "us-based only",
                "united states (remote)",  # Often means US remote only
            ]
            for pattern in us_only_patterns:
                if pattern in job_location:
                    return f"location_restricted:us_only"
            
            # Check job description for US-only requirements
            desc = (job.description or "").lower()
            for pattern in us_only_patterns:
                if pattern in desc:
                    return f"location_restricted:us_only_in_description"
        
        # If allowed_locations is set, check if job location matches any
        if self.allowed_locations:
            # Check if job location contains any allowed location
            for allowed in self.allowed_locations:
                if allowed in job_location or job_location in allowed:
                    return None  # Location matches, pass the filter
            
            # Check for "Remote" jobs - these might be acceptable
            if "remote" in job_location:
                # But skip if it says "Remote in United States" and user is in Canada
                if self.user_country == "canada" and ("united states" in job_location or "usa" in job_location):
                    return f"location_restricted:us_remote_only"
                # Generic remote jobs are OK
                return None
            
            # Location doesn't match any allowed location
            # But don't be too strict - only filter if clearly wrong country
            if self.user_country == "canada":
                # Skip jobs clearly in US cities/states
                us_indicators = ["new york", "san francisco", "los angeles", "seattle", 
                                "austin", "boston", "chicago", "denver", "atlanta",
                                "california", "texas", "washington", "florida", "georgia"]
                for indicator in us_indicators:
                    if indicator in job_location and "canada" not in job_location:
                        return f"location_mismatch:{job_location}"
        
        return None    def _check_already_applied(self, job: ScrapedJob, db) -> str | None:
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
