"""
Property-based tests for form fill priority order.

Property 1: Fill priority order — profile data > prefilled answers > AI > PendingQuestion
Validates: Requirements 2.4, 9.1, 9.5

The FormFillerSelenium must always prefer profile data over prefilled answers,
prefilled answers over AI-generated answers, and AI over leaving a field as
a PendingQuestion (unknown).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.bot.form_filler_selenium import FormFillerSelenium


# ---------------------------------------------------------------------------
# Strategies — generate realistic form-filling scenarios
# ---------------------------------------------------------------------------

# Profile-mappable field labels and their settings keys
PROFILE_FIELDS = {
    "first name": "first_name",
    "last name": "last_name",
    "email": "email",
    "phone": "phone",
    "city": "city",
    "linkedin url": "linkedin_url",
    "website": "website",
}

non_empty_text = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z")),
    min_size=1,
    max_size=50,
).filter(lambda s: s.strip())


@st.composite
def form_field_scenario(draw):
    """Generate a scenario with a field label, optional profile value,
    optional prefilled answer, and optional AI answer."""
    label = draw(st.sampled_from(list(PROFILE_FIELDS.keys())))
    settings_key = PROFILE_FIELDS[label]

    has_profile = draw(st.booleans())
    has_prefilled = draw(st.booleans())
    has_ai = draw(st.booleans())

    profile_value = draw(non_empty_text) if has_profile else ""
    prefilled_value = draw(non_empty_text) if has_prefilled else ""
    ai_value = draw(non_empty_text) if has_ai else ""

    return {
        "label": label,
        "settings_key": settings_key,
        "profile_value": profile_value,
        "prefilled_value": prefilled_value,
        "ai_value": ai_value,
        "has_profile": has_profile,
        "has_prefilled": has_prefilled,
        "has_ai": has_ai,
    }


# ---------------------------------------------------------------------------
# Fake Selenium elements and driver for deterministic testing
# ---------------------------------------------------------------------------


class FakeElement:
    """Simulates a Selenium WebElement for testing fill logic."""

    def __init__(self, tag: str, label: str, input_type: str = "text"):
        self._tag = tag
        self._label = label
        self._type = input_type
        self._value = ""
        self._displayed = True
        self._attrs = {"type": input_type, "value": ""}

    def is_displayed(self) -> bool:
        return self._displayed

    def get_attribute(self, name: str) -> str:
        if name == "value":
            return self._value
        return self._attrs.get(name, "")

    def clear(self):
        self._value = ""

    def send_keys(self, value: str):
        self._value = value

    @property
    def tag_name(self) -> str:
        return self._tag


class FakeDriver:
    """Simulates a Selenium WebDriver that returns controlled elements."""

    def __init__(self, elements_by_selector: dict[str, list[FakeElement]]):
        self._elements = elements_by_selector
        self._scripts_run = []

    def find_elements(self, by, selector):
        return self._elements.get(selector, [])

    def find_element(self, by, selector):
        elems = self._elements.get(selector, [])
        if elems:
            return elems[0]
        raise Exception(f"No element for {selector}")

    def execute_script(self, script, *args):
        self._scripts_run.append((script, args))
        # For _set_react_value fallback — just set the value directly
        if len(args) >= 2 and hasattr(args[0], "_value"):
            args[0]._value = args[1]

    def switch_to(self):
        pass

    @property
    def switch_to(self):
        return FakeSwitchTo()


class FakeSwitchTo:
    def default_content(self):
        pass

    def frame(self, f):
        pass


# ---------------------------------------------------------------------------
# Property tests
# ---------------------------------------------------------------------------


@given(scenario=form_field_scenario())
@settings(max_examples=200, deadline=None)
def test_profile_data_always_takes_priority_over_prefilled(scenario):
    """Property: When profile data exists for a field, it MUST be used
    regardless of whether a prefilled answer also exists.

    This validates Requirement 2.4: fill priority is profile > prefilled > AI.
    """
    assume(scenario["has_profile"])

    user_settings = {scenario["settings_key"]: scenario["profile_value"]}
    prefilled = {scenario["label"]: scenario["prefilled_value"]} if scenario["has_prefilled"] else {}

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    # Patch _get_label to return our controlled label
    with patch.object(filler, "_get_label", return_value=scenario["label"]):
        unknown = filler.fill_visible_fields(driver, prefilled)

    # Profile data was available, so the field must be filled with profile value
    assert element._value == scenario["profile_value"], (
        f"Expected profile value '{scenario['profile_value']}' but got '{element._value}'. "
        f"Profile data must always take priority over prefilled answers."
    )
    # Field should NOT appear in unknown list
    assert not any(u["question"] == scenario["label"] for u in unknown), (
        f"Field '{scenario['label']}' should not be unknown when profile data exists."
    )


@given(scenario=form_field_scenario())
@settings(max_examples=200, deadline=None)
def test_prefilled_used_when_no_profile_data(scenario):
    """Property: When no profile data exists but a prefilled answer does,
    the prefilled answer MUST be used.

    This validates Requirement 2.4: prefilled answers are second priority.
    """
    assume(not scenario["has_profile"] and scenario["has_prefilled"])

    # Empty settings — no profile data for this field
    user_settings = {}
    prefilled = {scenario["label"]: scenario["prefilled_value"]}

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    with patch.object(filler, "_get_label", return_value=scenario["label"]):
        unknown = filler.fill_visible_fields(driver, prefilled)

    assert element._value == scenario["prefilled_value"], (
        f"Expected prefilled value '{scenario['prefilled_value']}' but got '{element._value}'. "
        f"Prefilled answers must be used when no profile data exists."
    )
    assert not any(u["question"] == scenario["label"] for u in unknown)


@given(scenario=form_field_scenario())
@settings(max_examples=200, deadline=None)
def test_field_becomes_unknown_when_no_profile_or_prefilled(scenario):
    """Property: When neither profile data nor prefilled answer exists,
    the field MUST appear in the unknown list (candidate for AI or PendingQuestion).

    This validates Requirement 9.5: fields that can't be filled by profile or
    prefilled are escalated to AI, and if AI fails, become PendingQuestions.
    """
    assume(not scenario["has_profile"] and not scenario["has_prefilled"])

    user_settings = {}
    prefilled = {}

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    with patch.object(filler, "_get_label", return_value=scenario["label"]):
        unknown = filler.fill_visible_fields(driver, prefilled)

    # Field must be in the unknown list
    assert any(u["question"] == scenario["label"] for u in unknown), (
        f"Field '{scenario['label']}' should be unknown when no profile or prefilled data exists."
    )
    # Element should NOT have been filled
    assert element._value == "", (
        f"Field should remain empty when no profile or prefilled data exists, got '{element._value}'."
    )


@st.composite
def ai_fallback_scenario(draw):
    """Generate a scenario specifically for AI fallback testing:
    no profile data, no prefilled, but AI answer available."""
    label = draw(st.sampled_from(list(PROFILE_FIELDS.keys())))
    settings_key = PROFILE_FIELDS[label]
    ai_value = draw(non_empty_text)

    return {
        "label": label,
        "settings_key": settings_key,
        "profile_value": "",
        "prefilled_value": "",
        "ai_value": ai_value,
        "has_profile": False,
        "has_prefilled": False,
        "has_ai": True,
    }


@given(scenario=ai_fallback_scenario())
@settings(max_examples=100, deadline=None)
def test_ai_fallback_fills_unknown_fields(scenario):
    """Property: When fill_with_ai_fallback is called and AI returns an answer
    for an unknown field, the field MUST be filled and removed from unknowns.

    This validates Requirement 9.1: AI answers unknown text fields using resume context.
    """
    assume(not scenario["has_profile"] and not scenario["has_prefilled"] and scenario["has_ai"])


    user_settings = {}
    prefilled = {}

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    # Mock OllamaService to return the AI answer
    mock_ollama = MagicMock()

    async def fake_answer(q, ctx):
        return scenario["ai_value"]

    mock_ollama.answer_question = fake_answer

    with patch.object(filler, "_get_label", return_value=scenario["label"]), \
         patch.object(filler, "_fill_field_by_label", return_value=True) as mock_fill:
        still_unknown = filler.fill_with_ai_fallback(
            driver, prefilled, mock_ollama, "Sample resume text"
        )

    # AI answered, so field should NOT be in still_unknown
    assert not any(u["question"] == scenario["label"] for u in still_unknown), (
        f"Field '{scenario['label']}' should not be unknown after AI provides an answer."
    )
    # _fill_field_by_label should have been called with the stripped AI answer
    # (fill_with_ai_fallback calls .strip() on the AI response)
    mock_fill.assert_called_with(driver, scenario["label"], scenario["ai_value"].strip())


@given(scenario=ai_fallback_scenario())
@settings(max_examples=100, deadline=None)
def test_field_stays_unknown_when_ai_fails(scenario):
    """Property: When AI fails to answer a field (exception or empty response),
    the field MUST remain in the unknown list as a PendingQuestion candidate.

    This validates Requirement 9.5: if AI fails, save as PendingQuestion.
    """

    user_settings = {}
    prefilled = {}

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    # Mock OllamaService to raise an exception (AI failure)
    mock_ollama = MagicMock()

    async def failing_answer(q, ctx):
        raise ConnectionError("Ollama unreachable")

    mock_ollama.answer_question = failing_answer

    with patch.object(filler, "_get_label", return_value=scenario["label"]):
        still_unknown = filler.fill_with_ai_fallback(
            driver, prefilled, mock_ollama, "Sample resume text"
        )

    # AI failed, so field must remain unknown (PendingQuestion candidate)
    assert any(u["question"] == scenario["label"] for u in still_unknown), (
        f"Field '{scenario['label']}' must remain unknown when AI fails — "
        f"it should become a PendingQuestion."
    )


@given(scenario=form_field_scenario())
@settings(max_examples=200, deadline=None)
def test_priority_chain_is_strict(scenario):
    """Property: The full priority chain profile > prefilled > AI > PendingQuestion
    is strictly ordered. If a higher-priority source provides a value, lower-priority
    sources must NOT be consulted for that field.

    This is the comprehensive priority chain property.
    """
    user_settings = (
        {scenario["settings_key"]: scenario["profile_value"]}
        if scenario["has_profile"]
        else {}
    )
    prefilled = (
        {scenario["label"]: scenario["prefilled_value"]}
        if scenario["has_prefilled"]
        else {}
    )

    filler = FormFillerSelenium(settings=user_settings)
    element = FakeElement("input", scenario["label"])

    driver = FakeDriver({
        'input[type="text"], input[type="email"], input[type="tel"], '
        'input[type="number"], input[type="password"]': [element],
        "select": [],
        "textarea": [],
        'input[type="radio"]': [],
        'input[type="file"]': [],
        "iframe": [],
    })

    with patch.object(filler, "_get_label", return_value=scenario["label"]):
        unknown = filler.fill_visible_fields(driver, prefilled)

    if scenario["has_profile"]:
        # Profile wins — must use profile value
        assert element._value == scenario["profile_value"]
        assert not any(u["question"] == scenario["label"] for u in unknown)
    elif scenario["has_prefilled"]:
        # No profile, prefilled wins
        assert element._value == scenario["prefilled_value"]
        assert not any(u["question"] == scenario["label"] for u in unknown)
    else:
        # Neither — field is unknown, awaiting AI or PendingQuestion
        assert element._value == ""
        assert any(u["question"] == scenario["label"] for u in unknown)
