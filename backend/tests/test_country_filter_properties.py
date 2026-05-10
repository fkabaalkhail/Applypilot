"""
Property-based tests for CountryFilter.
Feature: job-scraper-aggregator, Property 5: Country Classification Correctness
Validates: Requirements 3.1, 3.2, 3.3, 3.5
"""

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.services.country_filter import CountryFilter

filter_instance = CountryFilter()

# Strategies
us_state_abbrevs = list(filter_instance.US_STATE_ABBREVS - {"CA"})  # Exclude ambiguous CA
us_state_names = list(filter_instance.US_STATE_NAMES)
ca_province_abbrevs = list(filter_instance.CA_PROVINCE_ABBREVS - filter_instance.US_STATE_ABBREVS)
ca_province_names = list(filter_instance.CA_PROVINCE_NAMES)

city_name = st.from_regex(r'[A-Z][a-z]{2,10}', fullmatch=True)


@settings(max_examples=100)
@given(city=city_name, state=st.sampled_from(us_state_abbrevs))
def test_city_state_pattern_classified_as_us(city, state):
    """City, STATE pattern should always classify as US."""
    location = f"{city}, {state}"
    result = filter_instance.classify(location)
    assert result == "US", f"Expected 'US' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(state_name=st.sampled_from(us_state_names))
def test_full_state_name_classified_as_us(state_name):
    """Full US state name should classify as US."""
    result = filter_instance.classify(state_name)
    assert result == "US", f"Expected 'US' for '{state_name}', got '{result}'"


@settings(max_examples=100)
@given(city=city_name, province=st.sampled_from(ca_province_abbrevs))
def test_city_province_pattern_classified_as_ca(city, province):
    """City, PROVINCE pattern should always classify as CA."""
    location = f"{city}, {province}"
    result = filter_instance.classify(location)
    assert result == "CA", f"Expected 'CA' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(province_name=st.sampled_from(ca_province_names))
def test_full_province_name_classified_as_ca(province_name):
    """Full Canadian province name should classify as CA."""
    result = filter_instance.classify(province_name)
    assert result == "CA", f"Expected 'CA' for '{province_name}', got '{result}'"


@settings(max_examples=100)
@given(prefix=st.sampled_from(["United States", "USA", "U.S.A.", "U.S."]))
def test_explicit_us_indicators(prefix):
    """Explicit US country indicators should classify as US."""
    result = filter_instance.classify(prefix)
    assert result == "US", f"Expected 'US' for '{prefix}', got '{result}'"


def test_explicit_canada_indicator():
    """Explicit 'Canada' should classify as CA."""
    result = filter_instance.classify("Canada")
    assert result == "CA"


def test_remote_defaults_to_us():
    """'Remote' without country indicator defaults to US."""
    result = filter_instance.classify("Remote")
    assert result == "US"


@settings(max_examples=100)
@given(state=st.sampled_from(us_state_abbrevs))
def test_remote_in_us_location(state):
    """'Remote in <US location>' should classify as US."""
    location = f"Remote in {state}"
    result = filter_instance.classify(location)
    assert result == "US", f"Expected 'US' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(province_name=st.sampled_from(ca_province_names))
def test_remote_in_ca_location(province_name):
    """'Remote in <CA location>' should classify as CA."""
    location = f"Remote in {province_name}"
    result = filter_instance.classify(location)
    assert result == "CA", f"Expected 'CA' for '{location}', got '{result}'"


def test_non_north_american_returns_none():
    """Non-US/CA locations should return None."""
    locations = ["London, UK", "Berlin, Germany", "Tokyo, Japan", "Mumbai, India", "Sydney, Australia"]
    for loc in locations:
        result = filter_instance.classify(loc)
        assert result is None, f"Expected None for '{loc}', got '{result}'"


def test_empty_string_returns_none():
    """Empty string should return None."""
    assert filter_instance.classify("") is None
    assert filter_instance.classify("   ") is None
