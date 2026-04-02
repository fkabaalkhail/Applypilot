"""
FormFiller for Selenium — fills Easy Apply form fields using profile data.

Supports iframe-aware filling, React value persistence, and AI fallback
via OllamaService for unknown fields.
"""

from __future__ import annotations

import asyncio
import os
import logging
import random
import time
from typing import TYPE_CHECKING

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement

if TYPE_CHECKING:
    from backend.services.ollama_service import OllamaService

logger = logging.getLogger(__name__)


class FormFillerSelenium:
    def __init__(self, settings: dict | None = None):
        self.resume_path = (settings or {}).get("resume_file_path", "") or ""
        self._settings = settings or {}

    # ------------------------------------------------------------------
    # React-compatible value setter (Task 4.2)
    # ------------------------------------------------------------------

    def _set_react_value(self, driver: WebDriver, element: WebElement, value: str) -> None:
        """Set a value on an input/textarea with React compatibility.

        Primary approach: click to focus, clear, send_keys, then TAB to
        trigger blur/validation — matching smart_form_filler.py::_fill_field.
        Fallback: JS native setter that bypasses React's synthetic event
        system using tag-name-aware prototype resolution, then dispatches
        input/change/blur so React picks up the new value.
        """
        try:
            element.click()
            time.sleep(0.2)
            element.clear()
            time.sleep(0.1)
            element.send_keys(value)
            time.sleep(0.5)
            # Handle LinkedIn typeahead/autocomplete dropdowns
            self._try_select_typeahead(driver, element)
            # Verify the value stuck
            if element.get_attribute("value") == value:
                element.send_keys(Keys.TAB)
                time.sleep(0.2)
                return
            # Value might have changed due to typeahead selection — that's OK
            if element.get_attribute("value"):
                element.send_keys(Keys.TAB)
                time.sleep(0.2)
                return
        except Exception:
            pass

        # Fallback — JS native setter + event dispatch (tag-name-aware)
        js = """
        var el = arguments[0];
        var val = arguments[1];
        var proto = (el.tagName.toLowerCase() === 'textarea')
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(el, val);
        } else {
            el.value = val;
        }
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
        el.dispatchEvent(new Event('blur', {bubbles: true}));
        """
        driver.execute_script(js, element, value)
        try:
            element.send_keys(Keys.TAB)
            time.sleep(0.2)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # LinkedIn typeahead/autocomplete handler
    # ------------------------------------------------------------------

    def _try_select_typeahead(self, driver: WebDriver, element: WebElement) -> None:
        """Handle LinkedIn's typeahead/autocomplete dropdowns.

        After typing a value, LinkedIn shows a dropdown list for fields like
        City, State, Postal. Click the first matching option to make the
        value stick.
        """
        try:
            time.sleep(0.8)  # Wait for dropdown to appear

            dropdown_selectors = [
                "div[role='listbox'] div[role='option']",
                "ul[role='listbox'] li",
                ".basic-typeahead__selectable",
                ".typeahead-multiselect__option",
                "[data-test-basic-typeahead-option]",
                ".artdeco-typeahead__results-list li",
                ".artdeco-typeahead__result",
            ]

            for sel in dropdown_selectors:
                try:
                    options = driver.find_elements(By.CSS_SELECTOR, sel)
                    if options:
                        for opt in options:
                            if opt.is_displayed():
                                opt_text = opt.text.strip()
                                if opt_text:
                                    opt.click()
                                    logger.info("Selected typeahead: %s", opt_text[:50])
                                    time.sleep(0.3)
                                    return
                except Exception:
                    continue

            # Fallback: Down arrow + Enter
            try:
                element.send_keys(Keys.ARROW_DOWN)
                time.sleep(0.3)
                element.send_keys(Keys.ENTER)
                time.sleep(0.3)
            except Exception:
                pass

        except Exception as e:
            logger.debug("Typeahead selection failed: %s", e)

    # ------------------------------------------------------------------
    # Core field filling (updated to use _set_react_value)
    # ------------------------------------------------------------------

    def fill_visible_fields(self, driver: WebDriver, prefilled: dict) -> list[dict]:
        """Fill all visible form fields in the current context.

        Returns a list of unknown fields that could not be filled.
        """
        unknown: list[dict] = []

        # Text/email/tel/number/password inputs (shuffled for human-like order)
        text_inputs = driver.find_elements(
            By.CSS_SELECTOR,
            'input[type="text"], input[type="email"], input[type="tel"], '
            'input[type="number"], input[type="password"]',
        )
        random.shuffle(text_inputs)
        for inp in text_inputs:
            try:
                if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
                    continue
                label = self._get_label(driver, inp)
                if not label:
                    continue
                value = self._map_field(label)
                if value:
                    self._set_react_value(driver, inp, value)
                    logger.info("Filled '%s'", label)
                    continue
                answer = self._match_prefilled(label, prefilled)
                if answer:
                    self._set_react_value(driver, inp, answer)
                    logger.info("Filled '%s' with prefilled", label)
                    continue
                unknown.append({"question": label, "type": "text", "options": []})
            except Exception:
                continue

        # File uploads (resume)
        for fi in driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]'):
            try:
                if self.resume_path and os.path.exists(self.resume_path):
                    fi.send_keys(os.path.abspath(self.resume_path))
                    logger.info("Uploaded resume")
            except Exception:
                pass

        # Select dropdowns (shuffled for human-like order)
        selects = driver.find_elements(By.TAG_NAME, "select")
        random.shuffle(selects)
        for sel in selects:
            try:
                if not sel.is_displayed():
                    continue
                label = self._get_label(driver, sel)
                options = [
                    o.text.strip()
                    for o in sel.find_elements(By.TAG_NAME, "option")
                    if o.get_attribute("value")
                ]
                answer = self._match_prefilled(label, prefilled) if label else None
                if answer:
                    from selenium.webdriver.support.ui import Select

                    s = Select(sel)
                    for o in s.options:
                        if answer.lower() in o.text.strip().lower():
                            s.select_by_visible_text(o.text.strip())
                            break
                    continue
                if sel.get_attribute("value"):
                    continue
                if label:
                    unknown.append({"question": label, "type": "select", "options": options})
            except Exception:
                continue

        # Textareas (shuffled for human-like order)
        textareas = driver.find_elements(By.TAG_NAME, "textarea")
        random.shuffle(textareas)
        for ta in textareas:
            try:
                if not ta.is_displayed() or (ta.get_attribute("value") or "").strip():
                    continue
                label = self._get_label(driver, ta)
                if not label:
                    continue
                answer = self._match_prefilled(label, prefilled)
                if answer:
                    self._set_react_value(driver, ta, answer)
                    continue
                unknown.append({"question": label, "type": "text", "options": []})
            except Exception:
                continue

        # Radio buttons — group by name, collect options, try prefilled
        radio_groups: dict[str, list[WebElement]] = {}
        for radio in driver.find_elements(By.CSS_SELECTOR, 'input[type="radio"]'):
            try:
                if not radio.is_displayed():
                    continue
                name = radio.get_attribute("name") or ""
                if name:
                    radio_groups.setdefault(name, []).append(radio)
            except Exception:
                continue

        # Shuffle group processing order for human-like behaviour
        group_items = list(radio_groups.items())
        random.shuffle(group_items)
        for name, radios in group_items:
            try:
                # Skip if one is already selected
                if any(r.is_selected() for r in radios):
                    continue
                label = self._get_label(driver, radios[0])
                if not label:
                    continue
                options = []
                for r in radios:
                    opt = r.get_attribute("value") or ""
                    if not opt:
                        # Try sibling label text
                        try:
                            r_id = r.get_attribute("id")
                            if r_id:
                                lbl = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                                opt = lbl.text.strip()
                        except Exception:
                            pass
                    if opt:
                        options.append(opt)

                answer = self._match_prefilled(label, prefilled)
                if answer:
                    for r in radios:
                        val = r.get_attribute("value") or ""
                        if answer.lower() in val.lower() or val.lower() in answer.lower():
                            r.click()
                            logger.info("Filled radio '%s' with prefilled → '%s'", label, val)
                            break
                    continue
                unknown.append({"question": label, "type": "radio", "options": options, "_radios_name": name})
            except Exception:
                continue

        return unknown

    # ------------------------------------------------------------------
    # Iframe-aware filling (Task 4.1)
    # ------------------------------------------------------------------

    def fill_in_iframe(self, driver: WebDriver, prefilled: dict) -> list[dict]:
        """Fill fields across ALL iframes on the page, plus the main content.

        Switches into each iframe, calls fill_visible_fields(), then
        switches back to default content. Returns the combined list of
        unknown fields from every context.
        """
        all_unknown: list[dict] = []

        # 1. Fill fields in the top-level (default) content first
        driver.switch_to.default_content()
        try:
            unknown = self.fill_visible_fields(driver, prefilled)
            all_unknown.extend(unknown)
        except Exception as exc:
            logger.warning("Error filling default content: %s", exc)

        # 2. Iterate over every iframe on the page
        iframes = driver.find_elements(By.TAG_NAME, "iframe")
        logger.info("Found %d iframe(s) to search", len(iframes))

        for idx, iframe in enumerate(iframes):
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(iframe)
                logger.debug("Switched to iframe %d", idx)
                unknown = self.fill_visible_fields(driver, prefilled)
                all_unknown.extend(unknown)
            except Exception as exc:
                logger.warning("Error filling iframe %d: %s", idx, exc)
            finally:
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass

        return all_unknown

    # ------------------------------------------------------------------
    # AI fallback filling (Task 4.3)
    # ------------------------------------------------------------------

    def fill_with_ai_fallback(
        self,
        driver: WebDriver,
        prefilled: dict,
        ollama: OllamaService,
        resume_text: str,
    ) -> list[dict]:
        """Fill fields using profile → prefilled → AI, saving PendingQuestions only as last resort.

        Priority order:
        1. Profile data mapping
        2. Prefilled answers dictionary
        3. AI-generated answer via OllamaService
        4. Return as unknown (caller saves as PendingQuestion)

        Works across iframes using fill_in_iframe for steps 1-2, then
        attempts AI on any remaining unknowns.
        """
        # Reset AI answer tracking for this invocation
        self._last_ai_answers: list[dict] = []

        # Steps 1-2: profile + prefilled via iframe-aware fill
        unknown = self.fill_in_iframe(driver, prefilled)

        if not unknown:
            return []

        # Step 3: attempt AI for each unknown field
        still_unknown: list[dict] = []

        for field in unknown:
            question = field["question"]
            field_type = field.get("type", "text")
            options = field.get("options", [])

            try:
                if field_type in ("select", "radio") and options:
                    # Ask AI to pick the best option for select or radio
                    options_str = ", ".join(options)
                    prompt_ctx = (
                        f"Question: {question}\n"
                        f"Options: {options_str}\n\n"
                        f"Pick the single best option from the list above. "
                        f"Reply with ONLY the option text, nothing else.\n\n"
                        f"Applicant context:\n{resume_text[:3000]}"
                    )
                    ai_answer = self._run_async(
                        ollama.answer_question(question, prompt_ctx)
                    )
                    ai_answer = ai_answer.strip()

                    matched = self._match_option(ai_answer, options)
                    if matched:
                        if field_type == "select":
                            self._select_option_in_page(driver, question, matched)
                            logger.info("AI filled select '%s' → '%s'", question, matched)
                        else:
                            self._click_radio_in_page(driver, field.get("_radios_name", ""), matched)
                            logger.info("AI filled radio '%s' → '%s'", question, matched)
                        self._last_ai_answers.append({
                            "question": question, "answer": matched, "source": "ai",
                        })
                        continue
                else:
                    # Text / textarea — ask AI for a free-text answer
                    ai_answer = self._run_async(
                        ollama.answer_question(question, resume_text[:3000])
                    )
                    ai_answer = ai_answer.strip()

                    if ai_answer:
                        filled = self._fill_field_by_label(driver, question, ai_answer)
                        if filled:
                            logger.info("AI filled '%s'", question)
                            self._last_ai_answers.append({
                                "question": question, "answer": ai_answer, "source": "ai",
                            })
                            continue
            except Exception as exc:
                logger.warning("AI fallback failed for '%s': %s", question, exc)

            # Step 4: AI also failed — mark as unknown for PendingQuestion
            still_unknown.append(field)

        return still_unknown

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _run_async(self, coro):
        """Run an async coroutine from sync context."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # We're inside an existing event loop (e.g. FastAPI) — use a
            # new thread to avoid blocking.
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, coro).result(timeout=130)
        else:
            return asyncio.run(coro)

    @staticmethod
    def _match_option(ai_answer: str, options: list[str]) -> str | None:
        """Fuzzy-match an AI answer to one of the available select options."""
        ai_lower = ai_answer.lower().strip()
        # Exact match
        for opt in options:
            if opt.lower().strip() == ai_lower:
                return opt
        # Substring match
        for opt in options:
            if ai_lower in opt.lower() or opt.lower() in ai_lower:
                return opt
        return None

    def _select_option_in_page(self, driver: WebDriver, label: str, option_text: str) -> None:
        """Find a <select> by label and choose the given option. Searches iframes too."""
        if self._try_select_in_context(driver, label, option_text):
            return
        # Search iframes
        for iframe in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(iframe)
                if self._try_select_in_context(driver, label, option_text):
                    driver.switch_to.default_content()
                    return
            except Exception:
                pass
            finally:
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass

    def _try_select_in_context(self, driver: WebDriver, label: str, option_text: str) -> bool:
        """Try to select an option in the current browsing context. Returns True on success."""
        for sel in driver.find_elements(By.TAG_NAME, "select"):
            try:
                sel_label = self._get_label(driver, sel)
                if sel_label and sel_label.lower().strip() == label.lower().strip():
                    from selenium.webdriver.support.ui import Select

                    s = Select(sel)
                    for o in s.options:
                        if o.text.strip() == option_text:
                            s.select_by_visible_text(option_text)
                            return True
            except Exception:
                continue
        return False

    def _click_radio_in_page(self, driver: WebDriver, name: str, option_text: str) -> None:
        """Find a radio button group by name and click the matching option. Searches iframes too."""
        if self._try_radio_in_context(driver, name, option_text):
            return
        for iframe in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(iframe)
                if self._try_radio_in_context(driver, name, option_text):
                    driver.switch_to.default_content()
                    return
            except Exception:
                pass
            finally:
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass

    def _try_radio_in_context(self, driver: WebDriver, name: str, option_text: str) -> bool:
        """Try to click a radio option in the current browsing context."""
        option_lower = option_text.lower().strip()
        for radio in driver.find_elements(By.CSS_SELECTOR, f'input[type="radio"][name="{name}"]'):
            try:
                val = (radio.get_attribute("value") or "").lower().strip()
                if val == option_lower or option_lower in val or val in option_lower:
                    radio.click()
                    return True
                # Check associated label text
                r_id = radio.get_attribute("id")
                if r_id:
                    try:
                        lbl = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                        lbl_text = lbl.text.strip().lower()
                        if lbl_text == option_lower or option_lower in lbl_text or lbl_text in option_lower:
                            radio.click()
                            return True
                    except Exception:
                        pass
            except Exception:
                continue
        return False

    def _fill_field_by_label(self, driver: WebDriver, label: str, value: str) -> bool:
        """Find a text input or textarea by its label and fill it. Searches iframes too."""
        if self._try_fill_in_context(driver, label, value):
            return True
        # Search iframes
        for iframe in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(iframe)
                if self._try_fill_in_context(driver, label, value):
                    driver.switch_to.default_content()
                    return True
            except Exception:
                pass
            finally:
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass
        return False

    def _try_fill_in_context(self, driver: WebDriver, label: str, value: str) -> bool:
        """Try to fill a field by label in the current browsing context."""
        label_lower = label.lower().strip()

        for inp in driver.find_elements(
            By.CSS_SELECTOR,
            'input[type="text"], input[type="email"], input[type="tel"], '
            'input[type="number"]',
        ):
            try:
                if not inp.is_displayed():
                    continue
                inp_label = self._get_label(driver, inp)
                if inp_label and inp_label.lower().strip() == label_lower:
                    self._set_react_value(driver, inp, value)
                    return True
            except Exception:
                continue

        for ta in driver.find_elements(By.TAG_NAME, "textarea"):
            try:
                if not ta.is_displayed():
                    continue
                ta_label = self._get_label(driver, ta)
                if ta_label and ta_label.lower().strip() == label_lower:
                    self._set_react_value(driver, ta, value)
                    return True
            except Exception:
                continue

        return False

    def _get_label(self, driver: WebDriver, element: WebElement) -> str:
        el_id = element.get_attribute("id")
        if el_id:
            try:
                label = driver.find_element(By.CSS_SELECTOR, f'label[for="{el_id}"]')
                return label.text.strip()
            except Exception:
                pass
        aria = element.get_attribute("aria-label")
        if aria:
            return aria
        placeholder = element.get_attribute("placeholder")
        return placeholder or ""

    def _map_field(self, label: str) -> str:
        label_lower = label.lower()
        s = self._settings
        mappings = {
            "first name": s.get("first_name", ""),
            "last name": s.get("last_name", ""),
            "full name": f"{s.get('first_name', '')} {s.get('last_name', '')}".strip(),
            "name": f"{s.get('first_name', '')} {s.get('last_name', '')}".strip(),
            "email": s.get("email", ""),
            "e-mail": s.get("email", ""),
            "email or phone": s.get("linkedin_email", "") or s.get("email", ""),
            "phone": s.get("phone", ""),
            "mobile": s.get("phone", ""),
            "city": s.get("city", ""),
            "location": s.get("city", ""),
            "state": s.get("state", ""),
            "province": s.get("state", ""),
            "postal": s.get("postal", ""),
            "postal code": s.get("postal", ""),
            "zip": s.get("postal", ""),
            "zip code": s.get("postal", ""),
            "address": s.get("address", ""),
            "street": s.get("address", ""),
            "country": s.get("country", ""),
            "linkedin": s.get("linkedin_url", ""),
            "linkedin profile": s.get("linkedin_url", ""),
            "linkedin url": s.get("linkedin_url", ""),
            "website": s.get("website", ""),
            "portfolio": s.get("website", ""),
            "password": s.get("linkedin_password", ""),
        }
        for key, value in mappings.items():
            if key in label_lower and value:
                return value
        return ""

    def _match_prefilled(self, label: str, prefilled: dict) -> str | None:
        if not label or not prefilled:
            return None
        label_lower = label.lower().strip()
        for question, answer in prefilled.items():
            if question.lower().strip() in label_lower or label_lower in question.lower().strip():
                return str(answer)
        return None
