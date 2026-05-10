"""
Property-based tests for ResumeTailor service.

Uses Hypothesis to verify correctness properties across many random inputs.
"""

# Feature: job-dashboard-apply, Property 17: Diff Computation Correctness

import difflib

from hypothesis import given, settings, strategies as st, HealthCheck

from backend.services.resume_tailor import ResumeTailor


# --- Strategies ---

# Generate resume-like multiline text (lines separated by newlines)
resume_line = st.text(
    alphabet=st.characters(
        whitelist_categories=("L", "N", "P", "Z", "S"),
        blacklist_characters="\r\n",
    ),
    min_size=0,
    max_size=80,
)

# Resume text as multiple lines joined by newlines
resume_text = st.lists(resume_line, min_size=0, max_size=10).map("\n".join)


# --- Property Test ---


@given(original=resume_text, tailored=resume_text)
@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
def test_diff_computation_correctness(original, tailored):
    """
    Property 17: Diff Computation Correctness

    For any pair of strings (original, tailored), computing the diff shall:
    - Produce an empty diff when original == tailored
    - Produce a non-empty diff when original != tailored
    - The diff correctly captures all changes between original and tailored,
      verified by independently computing the diff and comparing results.

    **Validates: Requirements 10.3**
    """
    # We instantiate ResumeTailor without a DB session since compute_diff is pure
    tailor = ResumeTailor.__new__(ResumeTailor)

    diff_result = tailor.compute_diff(original, tailored)

    if original == tailored:
        # When strings are identical, diff should be empty
        assert diff_result == "", (
            f"Expected empty diff for identical strings, got: {diff_result!r}"
        )
    else:
        # When strings differ, diff should be non-empty
        assert diff_result != "", (
            f"Expected non-empty diff for different strings.\n"
            f"Original: {original!r}\nTailored: {tailored!r}"
        )

        # Verify the diff correctly captures changes by independently computing
        # the unified diff and confirming the result matches
        original_lines = original.splitlines(keepends=True)
        tailored_lines = tailored.splitlines(keepends=True)

        expected_diff = "".join(
            difflib.unified_diff(
                original_lines,
                tailored_lines,
                fromfile="Original Resume",
                tofile="Tailored Resume",
                lineterm="",
            )
        )

        assert diff_result == expected_diff, (
            f"Diff result does not match expected unified diff.\n"
            f"Got: {diff_result!r}\nExpected: {expected_diff!r}"
        )
