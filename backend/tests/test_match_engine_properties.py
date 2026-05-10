"""
Property-based tests for MatchEngine service.

Uses Hypothesis to verify correctness properties across many random inputs.
"""

# Feature: job-dashboard-apply, Property 4: Match Score Label Mapping

from hypothesis import given, settings, strategies as st

from backend.services.match_engine import score_to_label


# --- Strategies ---

# Valid match scores are integers in [0, 100]
valid_score = st.integers(min_value=0, max_value=100)


# --- Property Test ---


@given(score=valid_score)
@settings(max_examples=100)
def test_score_to_label_mapping_is_correct(score):
    """
    Property 4: Match Score Label Mapping

    For any integer score in [0, 100], the label mapping shall produce
    "STRONG MATCH" if score >= 80, "GOOD MATCH" if 60 <= score < 80,
    and "FAIR MATCH" if score < 60. The mapping shall be total (every
    valid score gets exactly one label).

    **Validates: Requirements 2.2**
    """
    label = score_to_label(score)

    # 1. Verify correct label based on score value
    if score >= 80:
        assert label == "STRONG MATCH", (
            f"Score {score} >= 80 should map to 'STRONG MATCH', got '{label}'"
        )
    elif score >= 60:
        assert label == "GOOD MATCH", (
            f"Score {score} in [60, 80) should map to 'GOOD MATCH', got '{label}'"
        )
    else:
        assert label == "FAIR MATCH", (
            f"Score {score} < 60 should map to 'FAIR MATCH', got '{label}'"
        )

    # 2. Verify the mapping is total (always returns one of the three labels)
    assert label in {"STRONG MATCH", "GOOD MATCH", "FAIR MATCH"}, (
        f"Score {score} mapped to unexpected label '{label}'. "
        f"Expected one of: STRONG MATCH, GOOD MATCH, FAIR MATCH"
    )
