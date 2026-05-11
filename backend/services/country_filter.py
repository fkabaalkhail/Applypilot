"""
CountryFilter — classifies job locations into country codes (US, CA) or excludes them.

Used by the Aggregator to filter jobs to only North American (US/Canada) positions.
Handles various location formats from jobright-ai GitHub repositories including
city-state patterns, remote indicators, and explicit country names.
"""

import re
from typing import Optional


class CountryFilter:
    """Classifies job locations into country codes (US, CA) or excludes them."""

    US_STATE_ABBREVS: set[str] = {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
        "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
        "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
        "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
        "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
        "DC",
    }

    US_STATE_NAMES: set[str] = {
        "Alabama", "Alaska", "Arizona", "Arkansas", "California",
        "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
        "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
        "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
        "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
        "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
        "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
        "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
        "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
        "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
        "District of Columbia",
    }

    CA_PROVINCE_ABBREVS: set[str] = {
        "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE",
        "NT", "YT", "NU",
    }

    CA_PROVINCE_NAMES: set[str] = {
        "Ontario", "Quebec", "British Columbia", "Alberta", "Manitoba",
        "Saskatchewan", "Nova Scotia", "New Brunswick",
        "Newfoundland and Labrador", "Prince Edward Island",
        "Northwest Territories", "Yukon", "Nunavut",
    }

    def classify(self, location: str) -> Optional[str]:
        """Classify location text into 'US', 'CA', or None (excluded).

        Classification priority:
        1. Check for Canada first (province indicators, explicit "Canada")
        2. Check for USA (state indicators, explicit "United States"/"USA")
        3. "Remote" alone defaults to USA
        4. No match returns None (excluded)
        """
        if not location or not location.strip():
            return None

        location = location.strip()

        # Check for emoji flags first
        if "🇺🇸" in location:
            return "US"
        if "🇨🇦" in location:
            return "CA"

        # Check Canada first (important: must come before USA check
        # because "CA" is ambiguous — California vs Canada)
        if self._is_canada(location):
            return "CA"

        if self._is_usa(location):
            return "US"

        # "Remote" without any country/state indicator defaults to USA
        if re.search(r'\bremote\b', location, re.IGNORECASE):
            return "US"

        return None

    def _is_usa(self, location: str) -> bool:
        """Check if location indicates a USA job.

        Matches:
        - Explicit "United States" or "USA"
        - City, STATE_ABBREV patterns (e.g., "San Francisco, CA")
        - Full state names (e.g., "California")
        - "Remote in <US location>" patterns
        """
        # Explicit country indicators
        if re.search(r'\bUnited States\b', location, re.IGNORECASE):
            return True
        if re.search(r'\bUSA\b', location):
            return True
        if re.search(r'\bU\.S\.A\.?\b', location):
            return True
        if re.search(r'\bU\.S\.(?:\b|$)', location):
            return True

        # City, STATE_ABBREV pattern (e.g., "San Francisco, CA" or "Austin, TX")
        # This handles the "CA" ambiguity — when preceded by a city, it's California
        city_state_match = re.search(
            r'[A-Za-z\s]+,\s*([A-Z]{2})\b', location
        )
        if city_state_match:
            abbrev = city_state_match.group(1)
            if abbrev in self.US_STATE_ABBREVS:
                return True

        # Full state names (case-insensitive match)
        location_lower = location.lower()
        for state_name in self.US_STATE_NAMES:
            if state_name.lower() in location_lower:
                return True

        # Standalone state abbreviation (not preceded by city comma pattern)
        # Check for state abbreviations as standalone tokens
        # But skip "CA" standalone — it's ambiguous, handled separately below
        tokens = re.findall(r'\b([A-Z]{2})\b', location)
        for token in tokens:
            if token in self.US_STATE_ABBREVS and token != "CA":
                # Make sure it's not a Canadian province abbreviation
                if token not in self.CA_PROVINCE_ABBREVS:
                    return True

        # Handle standalone "CA" — default to California (USA) for these repos
        # unless it's clearly Canada context (handled by _is_canada first)
        if "CA" in tokens and "CA" in self.US_STATE_ABBREVS:
            # If we got here, _is_canada didn't match, so treat as California
            return True

        return False

    def _is_canada(self, location: str) -> bool:
        """Check if location indicates a Canadian job.

        Matches:
        - Explicit "Canada"
        - City, PROVINCE_ABBREV patterns (e.g., "Toronto, ON")
        - Full province names (e.g., "Ontario", "British Columbia")
        - "Remote in <CA location>" patterns
        - Province abbreviations (excluding "CA" ambiguity unless with "Canada")
        """
        # Explicit country indicator
        if re.search(r'\bCanada\b', location, re.IGNORECASE):
            return True

        # City, PROVINCE_ABBREV pattern (e.g., "Toronto, ON" or "Vancouver, BC")
        city_province_match = re.search(
            r'[A-Za-z\s]+,\s*([A-Z]{2})\b', location
        )
        if city_province_match:
            abbrev = city_province_match.group(1)
            # Only match Canadian provinces that are NOT also US states
            # "CA" is excluded here since it's ambiguous
            if abbrev in self.CA_PROVINCE_ABBREVS and abbrev not in self.US_STATE_ABBREVS:
                return True

        # Full province names (case-insensitive match)
        location_lower = location.lower()
        for province_name in self.CA_PROVINCE_NAMES:
            if province_name.lower() in location_lower:
                return True

        # Standalone province abbreviations (not "CA" which is ambiguous)
        tokens = re.findall(r'\b([A-Z]{2})\b', location)
        for token in tokens:
            if token in self.CA_PROVINCE_ABBREVS and token not in self.US_STATE_ABBREVS:
                return True

        return False
