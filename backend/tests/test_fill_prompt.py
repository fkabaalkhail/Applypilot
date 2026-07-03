from pathlib import Path

PROMPT = Path(__file__).resolve().parent.parent.parent / "prompts" / "answer_question.txt"


def test_prompt_forces_closest_listed_option():
    text = PROMPT.read_text(encoding="utf-8").lower()
    assert "closest" in text
    assert "not in the list" in text
