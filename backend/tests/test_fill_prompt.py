from pathlib import Path

PROMPT = Path(__file__).resolve().parent.parent.parent / "prompts" / "answer_question.txt"


def test_prompt_forces_closest_listed_option():
    text = PROMPT.read_text(encoding="utf-8").lower()
    # Multiple-choice answers must still be exact option text.
    assert "not in the list" in text


def test_prompt_defines_no_answer_sentinel():
    text = PROMPT.read_text(encoding="utf-8")
    assert "__NO_ANSWER__" in text


def test_prompt_does_not_instruct_fabrication():
    text = PROMPT.read_text(encoding="utf-8").lower()
    # The old fabrication rules must be gone.
    assert "3.5/4.0" not in text
    assert "always agree" not in text
    assert "never say you have zero experience" not in text
    assert "never say \"i don't have experience\"" not in text


def test_prompt_demands_exact_option_text():
    text = PROMPT.read_text(encoding="utf-8").lower()
    assert "word for word" in text
    assert "not in the list" in text


def test_prompt_teaches_derivation_not_guessing():
    text = PROMPT.read_text(encoding="utf-8").lower()
    assert "how did you hear" in text  # unknowable → __NO_ANSWER__
    assert "years of experience" in text  # derived from date ranges, not guessed
    assert "prefer not to say" in text  # the decline-to-answer exception survives
    assert "meaning" in text  # options matched by meaning, not wording
