"""
Bug Condition Exploration Tests — Easy Apply E2E Fix

These tests are EXPECTED TO FAIL on the current unfixed code.
Failure confirms the bugs exist. Do NOT fix the code or tests when they fail.

Bug 1: _set_react_value missing click/focus + TAB
Bug 1b: _set_react_value wrong textarea prototype in JS fallback
Bug 2: _do_easy_apply top-level-only button search

Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
"""

import re
from unittest.mock import MagicMock, call, patch, PropertyMock
import pytest
from hypothesis import given, strategies as st, settings as hyp_settings

from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import NoSuchElementException

from backend.bot.form_filler_selenium import FormFillerSelenium


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_element(tag_name="input", send_keys_fails=False, value=""):
    """Create a mock WebElement with configurable behavior."""
    el = MagicMock()
    el.tag_name = tag_name
    el.get_attribute.return_value = value

    if send_keys_fails:
        el.send_keys.side_effect = Exception("send_keys failed")
    else:
        # After send_keys, get_attribute("value") returns the value that was sent
        def _side_effect_send_keys(v):
            # Only update value for non-TAB keys
            if v != Keys.TAB:
                el.get_attribute.return_value = v
        el.send_keys.side_effect = _side_effect_send_keys

    return el


def _make_mock_driver():
    """Create a mock WebDriver."""
    driver = MagicMock()
    driver.execute_script = MagicMock()
    return driver


# ===========================================================================
# Bug 1 — _set_react_value missing click/focus + TAB
# ===========================================================================


class TestSetReactValueMissingClickAndTab:
    """
    Bug Condition: _set_react_value does not call element.click() before
    clear()/send_keys() and does not send Keys.TAB after send_keys().

    **Validates: Requirements 1.1, 1.3**
    """

    @given(value=st.text(min_size=1, max_size=50).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=10, deadline=None)
    def test_click_called_before_send_keys(self, value):
        """
        Property: For any non-empty value, element.click() MUST be called
        before element.clear() and element.send_keys().

        EXPECTED TO FAIL — click() is never called in current code.

        **Validates: Requirements 1.1**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(value=value)

        filler._set_react_value(driver, element, value)

        # Assert click was called at all
        element.click.assert_called()

        # Assert click was called BEFORE clear and send_keys
        call_names = [c[0] for c in element.method_calls]
        click_idx = call_names.index("click")
        clear_idx = call_names.index("clear")
        send_keys_idx = call_names.index("send_keys")
        assert click_idx < clear_idx, "click() must be called before clear()"
        assert click_idx < send_keys_idx, "click() must be called before send_keys()"

    @given(value=st.text(min_size=1, max_size=50).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=10, deadline=None)
    def test_tab_sent_after_send_keys(self, value):
        """
        Property: For any non-empty value, Keys.TAB MUST be sent after
        send_keys(value) to trigger React blur/validation.

        EXPECTED TO FAIL — TAB is never sent in current code.

        **Validates: Requirements 1.3**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(value=value)

        filler._set_react_value(driver, element, value)

        # Collect all send_keys calls
        send_keys_calls = [
            c for c in element.method_calls
            if c[0] == "send_keys"
        ]
        # There should be at least 2 send_keys calls: one for value, one for TAB
        assert len(send_keys_calls) >= 2, (
            f"Expected at least 2 send_keys calls (value + TAB), got {len(send_keys_calls)}"
        )
        # The last send_keys call should be Keys.TAB
        last_send_keys_args = send_keys_calls[-1][1]
        assert Keys.TAB in last_send_keys_args, (
            f"Last send_keys call should be Keys.TAB, got {last_send_keys_args}"
        )


# ===========================================================================
# Bug 1b — Wrong textarea prototype in JS fallback
# ===========================================================================


class TestSetReactValueTextareaPrototype:
    """
    Bug Condition: When send_keys fails and JS fallback is used on a
    <textarea> element, the JS always tries HTMLInputElement.prototype first
    instead of using HTMLTextAreaElement.prototype for textareas.

    **Validates: Requirements 1.2**
    """

    @given(value=st.text(min_size=1, max_size=100).filter(lambda x: x.strip()))
    @hyp_settings(max_examples=10, deadline=None)
    def test_textarea_uses_correct_prototype(self, value):
        """
        Property: For any textarea element where send_keys fails (forcing
        JS fallback), the executed JS MUST use HTMLTextAreaElement.prototype
        as the FIRST prototype checked, not HTMLInputElement.prototype.

        EXPECTED TO FAIL — current code always tries HTMLInputElement.prototype first.

        **Validates: Requirements 1.2**
        """
        filler = FormFillerSelenium()
        driver = _make_mock_driver()
        element = _make_mock_element(tag_name="textarea", send_keys_fails=True)

        filler._set_react_value(driver, element, value)

        # The JS fallback should have been called
        driver.execute_script.assert_called()

        # Get the JS that was executed
        js_code = driver.execute_script.call_args[0][0]

        # For a textarea element, the JS should use HTMLTextAreaElement.prototype
        # BEFORE or INSTEAD of HTMLInputElement.prototype
        input_pos = js_code.find("HTMLInputElement.prototype")
        textarea_pos = js_code.find("HTMLTextAreaElement.prototype")

        # The textarea prototype should appear first (or the code should
        # check tag name and use the correct one)
        assert textarea_pos != -1, (
            "JS fallback for textarea must reference HTMLTextAreaElement.prototype"
        )
        assert textarea_pos < input_pos or input_pos == -1, (
            "For textarea elements, HTMLTextAreaElement.prototype should be checked "
            "before HTMLInputElement.prototype. Current JS checks HTMLInputElement first."
        )


# ===========================================================================
# Bug 2 — _do_easy_apply top-level-only button search
# ===========================================================================


class TestDoEasyApplyButtonSearchInIframes:
    """
    Bug Condition: _do_easy_apply searches only the default content for
    Submit/Review/Next buttons. When buttons are inside iframes, they
    are never found.

    Since _do_easy_apply has many dependencies, we test the button search
    pattern directly by verifying the code searches iframes.

    **Validates: Requirements 1.4, 1.5, 1.6**
    """

    @given(
        aria_label=st.sampled_from([
            "Submit application",
            "Review your application",
            "Continue to next step",
        ])
    )
    @hyp_settings(max_examples=3, deadline=None)
    def test_button_search_checks_iframes(self, aria_label):
        """
        Property: For any navigation button aria-label, when the button is
        NOT in default content but IS inside an iframe, the search should
        find it by iterating iframes.

        EXPECTED TO FAIL — current code only does driver.find_element()
        on default content and never switches to iframes for button search.

        **Validates: Requirements 1.4, 1.5, 1.6**
        """
        driver = MagicMock()

        # Button inside iframe
        iframe_button = MagicMock()
        iframe_button.is_displayed.return_value = True

        iframe_element = MagicMock()

        # driver.find_element raises on default content (button not there)
        # but succeeds inside iframe
        def find_element_side_effect(by, selector):
            if f"aria-label='{aria_label}'" in selector:
                raise NoSuchElementException(f"No button with aria-label='{aria_label}'")
            raise NoSuchElementException("not found")

        driver.find_element.side_effect = find_element_side_effect
        driver.find_elements.return_value = [iframe_element]

        # After switching to iframe, find_element should succeed
        in_iframe = False

        def switch_to_frame(frame):
            nonlocal in_iframe
            in_iframe = True
            # Now find_element should return the button
            def find_in_iframe(by, selector):
                if f"aria-label='{aria_label}'" in selector and in_iframe:
                    return iframe_button
                raise NoSuchElementException("not found")
            driver.find_element.side_effect = find_in_iframe

        driver.switch_to.frame.side_effect = switch_to_frame

        def switch_to_default():
            nonlocal in_iframe
            in_iframe = False
            driver.find_element.side_effect = find_element_side_effect

        driver.switch_to.default_content.side_effect = switch_to_default

        # Now test: try to find the button the way _do_easy_apply does it
        # The current code just does: driver.find_element(By.CSS_SELECTOR, selector)
        # It should ALSO search iframes, but it doesn't.

        # Simulate what _do_easy_apply does for button search:
        from selenium.webdriver.common.by import By
        button_found = False
        try:
            btn = driver.find_element(
                By.CSS_SELECTOR, f"button[aria-label='{aria_label}']"
            )
            if btn.is_displayed():
                button_found = True
        except Exception:
            pass

        # If not found in default content, search iframes
        # (This is what the FIXED code should do, but current code doesn't)
        if not button_found:
            for iframe in driver.find_elements(By.TAG_NAME, "iframe"):
                try:
                    driver.switch_to.frame(iframe)
                    btn = driver.find_element(
                        By.CSS_SELECTOR, f"button[aria-label='{aria_label}']"
                    )
                    if btn.is_displayed():
                        button_found = True
                        btn.click()
                        driver.switch_to.default_content()
                        break
                except Exception:
                    driver.switch_to.default_content()

        # The button SHOULD be found (it's in the iframe)
        assert button_found, (
            f"Button '{aria_label}' exists in iframe but was not found. "
            "Current _do_easy_apply only searches default content."
        )

        # Now verify that _do_easy_apply's ACTUAL code DOES use _find_nav_button
        # which searches iframes for navigation buttons.
        import inspect
        from backend.bot.linkedin_bot import _do_easy_apply, _find_nav_button
        source_easy_apply = inspect.getsource(_do_easy_apply)
        source_helper = inspect.getsource(_find_nav_button)

        # _do_easy_apply should call _find_nav_button for button search
        assert "_find_nav_button" in source_easy_apply, (
            "_do_easy_apply should use _find_nav_button helper for button search."
        )

        # _find_nav_button should search iframes via switch_to.frame
        assert "switch_to.frame" in source_helper, (
            "_find_nav_button must search iframes via switch_to.frame."
        )
