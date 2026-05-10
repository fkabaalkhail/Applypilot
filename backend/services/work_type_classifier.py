"""
WorkTypeClassifier — extracts work arrangement type from job location text.

Used by the Aggregator to classify jobs as remote, hybrid, or onsite based on
location field content from jobright-ai GitHub repositories.

Priority order for ambiguous cases: Remote > Hybrid > On Site.
Defaults to "onsite" when no indicator is found.
"""

import re


class WorkTypeClassifier:
    """Extracts work arrangement type from job location text."""

    REMOTE_INDICATORS: list[str] = ["remote", "remote in", "work from home", "wfh"]
    HYBRID_INDICATORS: list[str] = ["hybrid"]
    ONSITE_INDICATORS: list[str] = ["on site", "on-site", "onsite", "in-person", "in office"]

    def classify(self, location: str) -> str:
        """Classify location text into 'remote', 'hybrid', or 'onsite'.

        Priority order: Remote > Hybrid > On Site.
        Defaults to 'onsite' if no indicator found.
        """
        if not location or not location.strip():
            return "onsite"

        location_lower = location.lower().strip()

        # Check remote indicators first (highest priority)
        if self._has_remote_indicator(location_lower):
            return "remote"

        # Check hybrid indicators (second priority)
        if self._has_hybrid_indicator(location_lower):
            return "hybrid"

        # Check onsite indicators (third priority)
        if self._has_onsite_indicator(location_lower):
            return "onsite"

        # Default to onsite when no indicator found
        return "onsite"

    def _has_remote_indicator(self, location_lower: str) -> bool:
        """Check if location contains a remote work indicator.

        Handles patterns like:
        - "Remote"
        - "Remote in San Francisco, CA"
        - "Work from home"
        - "WFH"
        """
        # "remote in <location>" pattern — still remote
        if re.search(r'\bremote\s+in\b', location_lower):
            return True

        # General "remote" keyword (word boundary to avoid false positives)
        if re.search(r'\bremote\b', location_lower):
            return True

        # "work from home" phrase
        if "work from home" in location_lower:
            return True

        # "wfh" abbreviation (word boundary)
        if re.search(r'\bwfh\b', location_lower):
            return True

        return False

    def _has_hybrid_indicator(self, location_lower: str) -> bool:
        """Check if location contains a hybrid work indicator."""
        return bool(re.search(r'\bhybrid\b', location_lower))

    def _has_onsite_indicator(self, location_lower: str) -> bool:
        """Check if location contains an on-site work indicator.

        Handles patterns like:
        - "On Site"
        - "On-Site"
        - "Onsite"
        - "In-Person"
        - "In Office"
        """
        if re.search(r'\bon[\s-]?site\b', location_lower):
            return True

        if re.search(r'\bin[\s-]person\b', location_lower):
            return True

        if re.search(r'\bin\s+office\b', location_lower):
            return True

        return False
