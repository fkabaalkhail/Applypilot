"""
Finding the keys that answer the wrong questions.

The three keys below are the ones production actually banked on
bmo.wd3.myworkdayjobs.com on 2026-08-09 (recorded verbatim in
chrome-extension/src/shared/questionText.ts). They were deleted by hand before
this audit existed, so the regression that matters is that the audit would have
caught them — not that the bank is currently clean.
"""

from types import SimpleNamespace

from backend.services.answer_memory import (
    attractor_neighbours,
    is_machine_id,
    key_health,
)
from scripts.audit_saved_answers import audit


PRODUCTION_BAD_KEYS = [
    ("Select One Required", "widget_boilerplate"),
    ("Yes Required", "widget_boilerplate"),
    ("b0531cc2ff371001d8a97c876e680000-b0531cc2ff371001d8a9b9c2eef00002", "machine_id"),
]


def test_the_production_keys_are_flagged():
    for key, reason in PRODUCTION_BAD_KEYS:
        assert key_health(key) == reason, key


def test_real_questions_are_not_flagged():
    for key in [
        "Are you at least 18 years of age?*",
        "Do you hold a valid social insurance number (SIN)?*",
        "How Did You Hear About Us?*",
        "Ethnicity",  # terse, but it names the question
        "Gender Identity",
        "candidate_country",  # a poor label that still says what the field is
    ]:
        assert key_health(key) == "", key


def test_boilerplate_variants():
    for key in ["Select One", "Select…", "Please select", "Required", "No Required",
                "Choose an option", "Yes", "N/A"]:
        assert key_health(key) == "widget_boilerplate", key


def test_a_question_containing_boilerplate_words_is_still_a_question():
    # "Select" and "one" appear here, but so does an actual question.
    assert key_health("Select one: are you legally authorized to work?") == ""
    assert key_health("Which option best describes your work authorization?") == ""


def test_unlabeled_sentinel_and_blank():
    assert key_health("Unlabeled field") == "unlabeled"
    assert key_health("   ") == "empty_key"


def test_is_machine_id_is_narrow():
    assert is_machine_id("b0531cc2ff371001d8a97c876e680000-b0531cc2ff371001d8a9b9c2eef00002")
    assert is_machine_id("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
    assert not is_machine_id("candidate_country")
    assert not is_machine_id("Are you 18?")  # whitespace is prose, never an id


def _row(row_id, question, embedding):
    return SimpleNamespace(id=row_id, question_raw=question, embedding=embedding)


def test_attractor_neighbours_finds_a_key_that_collides_with_others():
    # Two near-identical vectors and one orthogonal to both.
    a = _row(1, "Question A", [1.0, 0.0])
    b = _row(2, "Question B", [0.99, 0.14])
    c = _row(3, "Question C", [0.0, 1.0])
    near = attractor_neighbours([a, b, c])
    assert set(near) == {1, 2}
    assert near[1][0][0] == 2
    assert 3 not in near


def test_attractor_neighbours_is_silent_on_a_healthy_bank():
    rows = [_row(1, "A", [1.0, 0.0]), _row(2, "B", [0.0, 1.0])]
    assert attractor_neighbours(rows) == {}


def test_rows_without_embeddings_are_skipped_not_flagged():
    rows = [_row(1, "A", []), _row(2, "B", None)]
    assert attractor_neighbours(rows) == {}


def test_audit_combines_both_signals():
    rows = [
        _row(1, "Yes Required", [1.0, 0.0]),
        _row(2, "Are you willing to relocate?", [0.0, 1.0]),
        _row(3, "Would you consider relocating?", [0.02, 0.999]),
    ]
    flagged = audit(rows)
    assert flagged[1] == "widget_boilerplate"
    assert flagged[2] == "attracts_other_questions"
    assert flagged[3] == "attracts_other_questions"
