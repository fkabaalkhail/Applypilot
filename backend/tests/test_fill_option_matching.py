"""Option-matching guards in the /api/fill router (pure functions, no app).

The failure mode these pin down: an AI answer that no option truly matches must
return None (so the field is left for the user / the re-ask round) rather than
snapping to a confidently wrong option.
"""

from backend.routers.fill import _match_option


def test_range_set_without_containment_matches_nothing():
    # "seven years" has no digits, token overlap on the shared "years" token
    # must not select an arbitrary bucket.
    assert _match_option("seven years", ["Under 1 year", "1-2 years", "3-5 years"]) is None


def test_numeric_answer_snaps_into_its_bucket():
    assert _match_option("7", ["1-2 years", "3-5 years", "5+ years"]) == "5+ years"


def test_low_token_overlap_is_rejected():
    # Only "working" overlaps (1 of the option's 3 tokens), noise, not a match.
    assert _match_option("several years working abroad", ["Working Holiday Visa"]) is None


def test_never_picks_a_different_university_on_the_shared_token():
    # The random-university bug: every school shares "University" with the
    # answer; a single shared token must not select anything.
    assert (
        _match_option("University of Ottawa", ["University of Oklahoma", "University of Texas"])
        is None
    )


def test_morphological_prefix_still_matches():
    assert _match_option("Canada", ["American", "Canadian", "Other"]) == "Canadian"


def test_contains_tier_still_matches():
    assert (
        _match_option("No", ["Yes", "No, I do not require sponsorship"])
        == "No, I do not require sponsorship"
    )
