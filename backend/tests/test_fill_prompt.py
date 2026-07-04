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
