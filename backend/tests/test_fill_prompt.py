"""What the answering prompts actually say.

These read through ``_load_prompt`` rather than off disk, because the shared
contract now lives in a partial (``_answer_rules.md`` / ``_compose_rules.md``)
that is inlined at load time. Asserting on the assembled text is what pins the
prompt the model really receives, and it covers the batched prompts too, since
they inline the same partials.
"""
from backend.services.openai_service import _load_prompt


def _prompt() -> str:
    return _load_prompt("answer_question.txt")


def _compose() -> str:
    return _load_prompt("compose_answer.txt")


def test_prompt_forces_closest_listed_option():
    text = _prompt().lower()
    # Multiple-choice answers must still be exact option text.
    assert "not in the list" in text


def test_prompt_defines_no_answer_sentinel():
    text = _prompt()
    assert "__NO_ANSWER__" in text


def test_prompt_does_not_instruct_fabrication():
    text = _prompt().lower()
    # The old fabrication rules must be gone.
    assert "3.5/4.0" not in text
    assert "always agree" not in text
    assert "never say you have zero experience" not in text
    assert "never say \"i don't have experience\"" not in text


def test_prompt_demands_exact_option_text():
    text = _prompt().lower()
    assert "word for word" in text
    assert "not in the list" in text


def test_prompt_teaches_derivation_not_guessing():
    text = _prompt().lower()
    assert "how did you hear" in text  # unknowable → __NO_ANSWER__
    assert "years of experience" in text  # derived from date ranges, not guessed
    assert "prefer not to say" in text  # the decline-to-answer exception survives
    assert "meaning" in text  # options matched by meaning, not wording


def test_prompt_prefers_inference_over_a_blank():
    """The contract is infer-first: a question with no field holding the literal
    answer must still be reasoned about before it is abandoned."""
    text = _prompt().lower()
    assert "derive one from the available information" in text
    assert "reason from what you have before concluding you can't answer" in text
    # The named inference routes the user asked for.
    for cue in ("relocate", "notice period", "salary expectation", "proficiency"):
        assert cue in text


def test_prompt_states_the_blank_threshold():
    """"Not in one field" is not a reason to skip; "no reasoning could produce
    it" is. Both halves must be present or the model reverts to skipping."""
    text = _prompt().lower()
    assert "i couldn't find it in one field" in text
    assert "no amount of reasoning over this profile could produce it" in text


def test_prompt_keeps_the_never_fabricate_floor():
    text = _prompt().lower()
    assert "never fabricate" in text
    assert "traceable to something in the profile" in text
    # The categories that stay blank however hard you reason.
    for cue in ("government id", "reference names", "criminal-history"):
        assert cue in text


def test_prompt_picks_the_closest_option_rather_than_skipping():
    text = _prompt().lower()
    assert "closest supported option" in text




def test_compose_prompt_composes_open_ended():
    text = _compose().lower()
    assert "open-ended" in text          # it is the generative contract, not extraction
    assert "first person" in text


def test_compose_prompt_keeps_hard_fact_guardrails():
    text = _compose().lower()
    assert "may not invent" in text                              # no fabricated credentials
    assert "do not invent specific claims about the company" in text  # no fabricated company facts
    assert "job posting" in text


def test_compose_prompt_keeps_floor_sentinel():
    text = _compose()
    assert "__NO_ANSWER__" in text       # blank floor survives when nothing can be grounded
