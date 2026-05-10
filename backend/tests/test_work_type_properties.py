"""
Property-based tests for WorkTypeClassifier.
Feature: job-scraper-aggregator, Property 6: Work Type Classification Correctness
Validates: Requirements 4.1, 4.2, 4.4
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.services.work_type_classifier import WorkTypeClassifier

classifier = WorkTypeClassifier()

# Strategy: generate a city name to combine with indicators
city_name = st.from_regex(r'[A-Z][a-z]{2,10}', fullmatch=True)
state_abbrev = st.sampled_from(["CA", "NY", "TX", "WA", "IL", "MA"])


@settings(max_examples=100)
@given(
    city=city_name,
    state=state_abbrev,
    indicator=st.sampled_from(["Remote", "remote", "REMOTE", "Remote in", "Work from home", "WFH", "wfh"])
)
def test_remote_indicators_classify_as_remote(city, state, indicator):
    """Any location with a remote indicator should classify as remote."""
    location = f"{indicator} {city}, {state}"
    result = classifier.classify(location)
    assert result == "remote", f"Expected 'remote' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(
    city=city_name,
    state=state_abbrev,
    indicator=st.sampled_from(["Hybrid", "hybrid", "HYBRID"])
)
def test_hybrid_indicators_classify_as_hybrid(city, state, indicator):
    """Any location with a hybrid indicator should classify as hybrid."""
    location = f"{indicator} - {city}, {state}"
    result = classifier.classify(location)
    assert result == "hybrid", f"Expected 'hybrid' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(
    city=city_name,
    state=state_abbrev,
    indicator=st.sampled_from(["On Site", "On-Site", "Onsite", "on site", "In-Person", "In Office", "in office"])
)
def test_onsite_indicators_classify_as_onsite(city, state, indicator):
    """Any location with an onsite indicator should classify as onsite."""
    location = f"{indicator} - {city}, {state}"
    result = classifier.classify(location)
    assert result == "onsite", f"Expected 'onsite' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(city=city_name, state=state_abbrev)
def test_no_indicator_defaults_to_onsite(city, state):
    """Location with no work type indicator should default to onsite."""
    location = f"{city}, {state}"
    result = classifier.classify(location)
    assert result == "onsite", f"Expected 'onsite' for '{location}', got '{result}'"


def test_empty_string_defaults_to_onsite():
    """Empty string should default to onsite."""
    assert classifier.classify("") == "onsite"
    assert classifier.classify("   ") == "onsite"


@settings(max_examples=100)
@given(
    city=city_name,
    state=state_abbrev,
)
def test_remote_priority_over_hybrid(city, state):
    """When both remote and hybrid indicators present, remote wins."""
    location = f"Remote / Hybrid - {city}, {state}"
    result = classifier.classify(location)
    assert result == "remote", f"Expected 'remote' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(
    city=city_name,
    state=state_abbrev,
)
def test_remote_priority_over_onsite(city, state):
    """When both remote and onsite indicators present, remote wins."""
    location = f"Remote / On Site - {city}, {state}"
    result = classifier.classify(location)
    assert result == "remote", f"Expected 'remote' for '{location}', got '{result}'"


@settings(max_examples=100)
@given(city=city_name, state=state_abbrev)
def test_hybrid_priority_over_onsite(city, state):
    """When both hybrid and onsite indicators present, hybrid wins."""
    location = f"Hybrid / On Site - {city}, {state}"
    result = classifier.classify(location)
    assert result == "hybrid", f"Expected 'hybrid' for '{location}', got '{result}'"


def test_result_always_valid_value():
    """classify() should always return one of the three valid values."""
    import random
    import string
    for _ in range(100):
        loc = ''.join(random.choices(string.ascii_letters + string.digits + " ,.-/", k=random.randint(0, 50)))
        result = classifier.classify(loc)
        assert result in ("remote", "hybrid", "onsite"), f"Invalid result '{result}' for '{loc}'"
