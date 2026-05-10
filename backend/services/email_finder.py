"""
EmailFinder — resolves work email addresses from LinkedIn profile URLs.

Uses pattern matching (first.last@company.com) to generate candidate emails.
"""

import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def validate_linkedin_url(url: str) -> bool:
    """Validate that input is a valid LinkedIn profile URL.

    Valid format: https://www.linkedin.com/in/{slug}
    (with optional trailing slash and query params)

    Returns True if valid, False otherwise.
    """
    pattern = r'^https://www\.linkedin\.com/in/[a-zA-Z0-9_-]+/?(\?.*)?$'
    return bool(re.match(pattern, url))


class EmailFinder:
    """Resolves work email addresses from LinkedIn profile URLs."""

    async def resolve_email(self, linkedin_url: str) -> Optional[str]:
        """Attempt to resolve work email from LinkedIn profile.

        Uses pattern matching (first.last@company.com) and
        common email format patterns.

        Args:
            linkedin_url: A validated LinkedIn profile URL

        Returns:
            The resolved email address, or None if not found
        """
        if not validate_linkedin_url(linkedin_url):
            return None

        # Extract the slug from the LinkedIn URL
        slug = self._extract_slug(linkedin_url)
        if not slug:
            return None

        # Generate candidate email patterns from the slug
        # LinkedIn slugs are often first-last or firstname-lastname
        candidates = self._generate_email_candidates(slug)

        # In a real implementation, we'd verify these against an API
        # (e.g., Hunter.io or SMTP check)
        # For now, return the most likely candidate
        if candidates:
            return candidates[0]

        return None

    def _extract_slug(self, url: str) -> Optional[str]:
        """Extract the profile slug from a LinkedIn URL."""
        match = re.search(r'linkedin\.com/in/([a-zA-Z0-9_-]+)', url)
        if match:
            return match.group(1)
        return None

    def _generate_email_candidates(self, slug: str) -> list[str]:
        """Generate candidate email addresses from a LinkedIn slug.

        Common patterns:
        - first.last@company.com
        - firstlast@company.com
        - first@company.com
        """
        # Split slug by common separators
        parts = re.split(r'[-_]', slug.lower())
        parts = [p for p in parts if p and not p.isdigit()]

        if len(parts) < 2:
            return []

        first = parts[0]
        last = parts[-1] if len(parts) > 1 else ""

        # We can't determine the company domain from just the LinkedIn URL
        # This would need additional data (company from their profile)
        # Return empty for now - the router will handle the "not found" case
        return []
