"""Pure-function tests for the answer→option snapper (no DB, no client)."""
from backend.routers.fill import _match_option


def test_exact_and_substring_still_win():
    assert _match_option("Canadian", ["American", "Canadian"]) == "Canadian"
    assert _match_option("No", ["Yes", "No, I do not require sponsorship"]).startswith("No")


def test_shared_prefix_tier_matches_morphological_variant():
    assert _match_option("Canada", ["American", "Canadian", "Other"]) == "Canadian"
    assert _match_option("Canadien", ["American", "Canadian"]) == "Canadian"


def test_short_prefixes_do_not_match():
    assert _match_option("cat", ["category"]) is None


def test_no_options_returns_none():
    assert _match_option("anything", []) is None
