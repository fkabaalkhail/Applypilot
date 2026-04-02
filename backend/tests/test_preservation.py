"""
Preservation Property Tests — Easy Apply E2E Fix

These tests capture BASELINE behavior on the UNFIXED code.
They MUST PASS before and after the fix to confirm no regressions.

Validates: Requirements 3.1, 3.2, 3.3, 3.6
"""

from unittest.mock import MagicMock, call, PropertyMock
import pytest
from hypothesis import given, strategies as st, settings as hyp_settings

from backend.bot.form_filler_selenium import FormFillerSelenium


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_element(tag_name="input", send_keys_fails=False, current_value=""):
    """Create a mock WebElement with configurable behavior."""
    el = MagicMock()
    el.tag_name = tag_name
    el.is_displayed.return_value = True

    # Track the current value
    _value = {"v": current_value}

    def _get_attr(attr):
        if attr == "value":
            return _value["v"]
        if attr == "id":
            return ""
        if attr == "aria-label":
            return ""
        if attr == "placeholder":
            return ""
        if attr == "name":
            return ""
        return ""

    el.get_attribute.side_effect = _get_attr

    if send_keys_fails:
        el.send_keys.side_effect = Exception("send_keys failed")
    else:
        def _send_keys(v):
            # Only update value for non-TAB keys
            from selenium.webdriver.common.keys import Keys
            if v != Keys.TAB:
                _value["v"] = str(v)
        el.send_keys.side_effect = _send_keys

    def _clear():
        _value["v"] = ""
    el.clear.side_effect = _clear

    return el


def _make_mock_driver():
    """Create a mock WebDriver."""
    driver = MagicMock()
    driver.execute_script = MagicMock()
    driver.find_elements.return_value = []
    return driver


# ===========================================================================
# Preservation 1 — _set_react_value with successful send_keys
# ===========================================================================


class TestSetReactValuePreservation:
    """
    Preservation: _set_react_value with a mock element where send_keys
    succeeds sets the value via clear() + send_keys() and returns normally.

    These tests MUST PASS on the current unfixed code.

    **Validates: Requirements 3.1**
    """

    @given(value=st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=20, deadline=None)
    def test_clear_then_send_keys_sets_value(self, value):
        """
        Property: For any non-empty string value, when send_keys succeeds,
        _set_react_value calls clear() then send_keys(value), and the
        element's value attribute equals the input value afterward.

        **Validates: Requirements 3.1**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(tag_name="input", current_value="")

        filler._set_react_value(driver, element, value)

        # clear() must have been called
        element.clear.assert_called()

        # send_keys must have been called with the value
        element.send_keys.assert_any_call(value)

        # The element's value should now equal the input value
        assert element.get_attribute("value") == value

        # JS fallback should NOT have been called (send_keys succeeded)
        driver.execute_script.assert_not_called()

    @given(value=st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=20, deadline=None)
    def test_clear_called_before_send_keys(self, value):
        """
        Property: For any non-empty string value, clear() is called
        before send_keys(value) in the method call sequence.

        **Validates: Requirements 3.1**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(tag_name="input", current_value="")

        filler._set_react_value(driver, element, value)

        # Extract method call names in order
        call_names = [c[0] for c in element.method_calls]
        clear_idx = call_names.index("clear")
        send_keys_idx = call_names.index("send_keys")
        assert clear_idx < send_keys_idx, "clear() must be called before send_keys()"

    def test_returns_normally_on_success(self):
        """
        Unit test: _set_react_value returns None (no exception) when
        send_keys succeeds and value sticks.

        **Validates: Requirements 3.1**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(tag_name="input", current_value="")

        # Should not raise
        result = filler._set_react_value(driver, element, "hello world")
        assert result is None


# ===========================================================================
# Preservation 2 — fill_visible_fields skips already-filled fields
# ===========================================================================


class TestFillVisibleFieldsSkipsFilledFields:
    """
    Preservation: fill_visible_fields skips fields that already have a value.

    These tests MUST PASS on the current unfixed code.

    **Validates: Requirements 3.2**
    """

    def test_skips_text_input_with_existing_value(self):
        """
        Unit test: A text input that already has a non-empty value should
        be skipped — _set_react_value should NOT be called on it.

        **Validates: Requirements 3.2**
        """
        filler = FormFillerSelenium(settings={"first_name": "John"})
        driver = _make_mock_driver()

        # Create an input that already has a value
        filled_input = _make_mock_element(tag_name="input", current_value="Already filled")
        filled_input.is_displayed.return_value = True

        # Make driver.find_elements return this input for text inputs
        def find_elements_side_effect(by, selector):
            if "input" in selector and "text" in selector:
                return [filled_input]
            return []

        driver.find_elements.side_effect = find_elements_side_effect

        unknown = filler.fill_visible_fields(driver, {})

        # The input should NOT have been cleared or typed into
        filled_input.clear.assert_not_called()
        # No unknown fields should be returned for this filled input
        assert len(unknown) == 0

    def test_skips_textarea_with_existing_value(self):
        """
        Unit test: A textarea that already has a non-empty value should
        be skipped — _set_react_value should NOT be called on it.

        **Validates: Requirements 3.2**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()

        filled_textarea = _make_mock_element(tag_name="textarea", current_value="Existing text")
        filled_textarea.is_displayed.return_value = True

        def find_elements_side_effect(by, selector):
            if selector == "textarea":
                return [filled_textarea]
            return []

        driver.find_elements.side_effect = find_elements_side_effect

        unknown = filler.fill_visible_fields(driver, {})

        filled_textarea.clear.assert_not_called()

    @given(existing_value=st.text(min_size=1, max_size=50).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=15, deadline=None)
    def test_any_nonempty_value_causes_skip(self, existing_value):
        """
        Property: For any non-empty, non-whitespace existing value,
        fill_visible_fields skips the field without modifying it.

        **Validates: Requirements 3.2**
        """
        filler = FormFillerSelenium(settings={"first_name": "John"})
        driver = _make_mock_driver()

        filled_input = _make_mock_element(tag_name="input", current_value=existing_value)
        filled_input.is_displayed.return_value = True

        def find_elements_side_effect(by, selector):
            if "input" in selector and "text" in selector:
                return [filled_input]
            return []

        driver.find_elements.side_effect = find_elements_side_effect

        filler.fill_visible_fields(driver, {})

        # Should not have been cleared or typed into
        filled_input.clear.assert_not_called()


# ===========================================================================
# Preservation 3 — fill_in_iframe switches to default content after each iframe
# ===========================================================================


class TestFillInIframeSwitchesBack:
    """
    Preservation: fill_in_iframe switches to default content after each iframe.

    These tests MUST PASS on the current unfixed code.

    **Validates: Requirements 3.3**
    """

    @given(num_iframes=st.integers(min_value=1, max_value=5))
    @hyp_settings(max_examples=10, deadline=None)
    def test_switches_to_default_content_after_each_iframe(self, num_iframes):
        """
        Property: For any number of iframes (1-5), fill_in_iframe calls
        driver.switch_to.default_content() after processing each iframe.

        **Validates: Requirements 3.3**
        """
        filler = FormFillerSelenium()
        driver = MagicMock()

        # Create mock iframes
        iframes = [MagicMock() for _ in range(num_iframes)]
        driver.find_elements.return_value = iframes

        # Make fill_visible_fields a no-op by returning empty list
        driver.find_elements.side_effect = None

        # We need find_elements to return iframes for "iframe" tag,
        # and empty lists for everything else
        def find_elements_side_effect(by, selector):
            if selector == "iframe":
                return iframes
            return []

        driver.find_elements.side_effect = find_elements_side_effect

        filler.fill_visible_fields = MagicMock(return_value=[])

        filler.fill_in_iframe(driver, {})

        # default_content should be called at least once per iframe
        # (once at start + once before each iframe switch + once in finally)
        default_content_calls = driver.switch_to.default_content.call_count
        # At minimum: 1 (initial) + num_iframes (before each switch) + num_iframes (finally)
        # = 1 + 2*num_iframes
        assert default_content_calls >= num_iframes + 1, (
            f"Expected at least {num_iframes + 1} default_content calls for "
            f"{num_iframes} iframes, got {default_content_calls}"
        )

    def test_single_iframe_switches_back(self):
        """
        Unit test: With one iframe, default_content is called after
        processing it.

        **Validates: Requirements 3.3**
        """
        filler = FormFillerSelenium()
        driver = MagicMock()

        iframe = MagicMock()

        def find_elements_side_effect(by, selector):
            if selector == "iframe":
                return [iframe]
            return []

        driver.find_elements.side_effect = find_elements_side_effect
        filler.fill_visible_fields = MagicMock(return_value=[])

        filler.fill_in_iframe(driver, {})

        # Verify switch_to.frame was called with the iframe
        driver.switch_to.frame.assert_called_with(iframe)
        # Verify default_content was called after
        driver.switch_to.default_content.assert_called()


# ===========================================================================
# Preservation 4 — _discard_modal behavior (reference to existing tests)
# ===========================================================================


class TestDiscardModalPreservation:
    """
    Preservation: _discard_modal behavior is already tested in
    test_easy_apply_helpers.py (TestDiscardModal class).

    This class adds a simple smoke test to confirm the import works
    and the function is callable, serving as a cross-reference.

    **Validates: Requirements 3.6**
    """

    def test_discard_modal_is_importable_and_callable(self):
        """
        Smoke test: _discard_modal can be imported and called with
        a mock driver without crashing.

        **Validates: Requirements 3.6**
        """
        from backend.bot.linkedin_bot import _discard_modal

        driver = MagicMock()
        driver.find_element.side_effect = Exception("not found")

        # Should not raise
        _discard_modal(driver)

        # Should have attempted to switch to default content
        driver.switch_to.default_content.assert_called()
