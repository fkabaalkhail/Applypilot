"""Unit tests for is_essay_question, the pure heuristic that decides which
long free-text fields get an AI-composed answer. No DB, no network."""
from backend.routers.fill import FormField, is_essay_question


def _f(label: str, type: str = "textarea", options=None, helpText: str = "") -> FormField:
    return FormField(label=label, type=type, options=options or [], helpText=helpText)


def test_motivation_question_is_essay():
    assert is_essay_question(_f("Why do you want to work here?")) is True


def test_behavioral_question_is_essay():
    assert is_essay_question(_f("Describe a time you faced a challenge.")) is True


def test_self_intro_question_is_essay():
    assert is_essay_question(_f("Tell us about yourself")) is True


def test_company_knowledge_question_is_essay():
    assert is_essay_question(_f("What do you know about our company?")) is True


def test_bare_question_mark_textarea_is_essay():
    # A genuine question on a long-text field, no keyword cue.
    assert is_essay_question(_f("What would your ideal workday involve?")) is True


def test_factual_experience_textarea_is_not_essay():
    # "Describe your experience with X" is groundable -> stays on answer_question.
    assert is_essay_question(_f("Describe your experience with COBOL")) is False


def test_cueless_comments_box_is_not_essay():
    assert is_essay_question(_f("Additional comments")) is False


def test_short_question_textarea_is_not_essay():
    # "Start date?" is a question but too short to be an essay prompt.
    assert is_essay_question(_f("Start date?")) is False


def test_numeric_control_is_never_essay():
    # A years-of-experience question rendered as a number input keeps strict grounding.
    assert is_essay_question(_f("How many years of experience do you have?", type="number")) is False


def test_field_with_options_is_never_essay():
    # A "why" question that is actually a dropdown must stay on the option-aware path.
    assert is_essay_question(_f("Why did you apply?", type="select", options=["Growth", "Pay"])) is False
