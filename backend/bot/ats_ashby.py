"""
Ashby ATS auto-apply handler (Selenium).

Ashby forms (jobs.ashbyhq.com) use a React-based UI with:
- Standard fields: name, email, phone, resume, LinkedIn, etc.
- Toggle-style Yes/No buttons (segmented controls, not radio buttons)
- Text inputs, textareas, select dropdowns
- Multi-section forms with a single Submit button

Toggle buttons are rendered as adjacent <button> or <div> elements
inside a container, with text like "Yes" / "No". They use
aria-pressed, data-state, or CSS classes to indicate selection.
"""

from __future__ import annotations

import asyncio
import os
import time
import random
import logging
from typing import TYPE_CHECKING

from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webdriver import WebDriver

if TYPE_CHECKING:
    from backend.services.ollama_service import OllamaService

logger = logging.getLogger(__name__)


def is_ashby(url: str) -> bool:
    """Check if a URL is an Ashby application."""
    url_lower = url.lower()
    return any(x in url_lower for x in [
        "ashbyhq.com", "jobs.ashby",
    ])


def apply_ashby(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    task_id: str,
    log_fn,
    ollama: OllamaService | None = None,
) -> tuple[str, list[dict]]:
    """
    Fill and submit an Ashby application form using Selenium.

    Returns:
        (result, unknown_fields)
        result: 'done', 'waiting', or 'failed'
        unknown_fields: list of fields the bot couldn't fill
    """
    log_fn(task_id, "Filling Ashby application form...")
    time.sleep(random.uniform(2, 4))

    unknown: list[dict] = []

    # --- Standard fields ---
    _fill_input(driver, 'input[name="name"], input[name*="first_name"]',
                f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip(),
                "Name", log_fn, task_id)
    _fill_input(driver,
                'input[name*="first"], input[data-testid*="first"], input[placeholder*="First"]',
                settings.get("first_name", ""), "First Name", log_fn, task_id)
    _fill_input(driver,
                'input[name*="last"], input[data-testid*="last"], input[placeholder*="Last"]',
                settings.get("last_name", ""), "Last Name", log_fn, task_id)
    _fill_input(driver,
                'input[name*="email"], input[type="email"]',
                settings.get("email", ""), "Email", log_fn, task_id)
    _fill_input(driver,
                'input[name*="phone"], input[type="tel"]',
                settings.get("phone", ""), "Phone", log_fn, task_id)

    # LinkedIn URL
    for sel in ['input[name*="linkedin"]', 'input[placeholder*="linkedin" i]',
                'input[placeholder*="LinkedIn"]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                linkedin_url = settings.get("linkedin_url", "")
                if linkedin_url:
                    el.clear()
                    el.send_keys(linkedin_url)
                    log_fn(task_id, "  Filled LinkedIn URL")
                    break
        except Exception:
            continue

    # Website / Portfolio / GitHub
    for sel in ['input[name*="website"]', 'input[name*="portfolio"]',
                'input[placeholder*="github" i]', 'input[placeholder*="portfolio" i]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                website = settings.get("website", "")
                if website:
                    el.clear()
                    el.send_keys(website)
                    log_fn(task_id, "  Filled Website/Portfolio")
                    break
        except Exception:
            continue

    # Location / City
    for sel in ['input[name*="location"]', 'input[name*="city"]',
                'input[placeholder*="location" i]', 'input[placeholder*="city" i]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                city = settings.get("city", "")
                if city:
                    el.clear()
                    el.send_keys(city)
                    log_fn(task_id, "  Filled Location/City")
                    break
        except Exception:
            continue

    # --- Resume upload ---
    resume_path = settings.get("resume_file_path", "")
    if resume_path and os.path.exists(resume_path):
        file_inputs = driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
        for fi in file_inputs:
            try:
                fi.send_keys(os.path.abspath(resume_path))
                log_fn(task_id, "  Uploaded resume")
                time.sleep(1)
                break
            except Exception as e:
                log_fn(task_id, f"  Resume upload failed: {e}")

    # --- Toggle-style Yes/No buttons (Ashby specialty) ---
    _handle_toggle_buttons(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Select dropdowns ---
    _handle_selects(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Custom text inputs ---
    _handle_custom_text_inputs(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Textareas ---
    _handle_textareas(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Radio buttons (standard HTML radios) ---
    _handle_radio_buttons(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Check for unknowns ---
    if unknown:
        log_fn(task_id, f"Found {len(unknown)} questions that need answers")
        return "waiting", unknown

    # --- Submit ---
    time.sleep(random.uniform(1, 2))
    submit_btn = _find_submit_button(driver)
    if submit_btn:
        submit_btn.click()
        log_fn(task_id, "Clicked Submit on Ashby form")
        time.sleep(random.uniform(3, 5))

        page_source = driver.page_source.lower()
        if any(kw in page_source for kw in ["thank", "success", "submitted", "received"]):
            log_fn(task_id, "Application submitted successfully!")
            return "done", []

        errors = driver.find_elements(By.CSS_SELECTOR,
            '[class*="error"], [class*="Error"], [aria-invalid="true"], [data-error]')
        if errors:
            visible_errors = [e for e in errors if e.is_displayed()]
            if visible_errors:
                log_fn(task_id, f"Form has {len(visible_errors)} validation errors")
                return "failed", []

        return "done", []

    log_fn(task_id, "Could not find submit button")
    return "failed", []


# ── Toggle button handler (Ashby's Yes/No segmented controls) ────────


def _handle_toggle_buttons(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle Ashby's toggle-style Yes/No buttons.

    Ashby renders these as a group of adjacent buttons or divs inside a
    container. The question text is in a nearby label/heading. Each option
    is a clickable element with text like "Yes" or "No".

    Common patterns:
    - <div role="group"> containing <button> children
    - <div> with [data-testid] containing clickable segments
    - Adjacent <button> elements styled as a segmented control
    - Elements with aria-pressed="true"/"false"
    """
    # Strategy: find question containers that have toggle-like button groups
    toggle_groups = _find_toggle_groups(driver)

    for group_info in toggle_groups:
        label = group_info["label"]
        options = group_info["options"]  # list of (text, element) tuples
        container = group_info.get("container")

        if not label or not options:
            continue

        # Check if already selected
        already_selected = False
        for opt_text, opt_el in options:
            try:
                pressed = opt_el.get_attribute("aria-pressed")
                data_state = opt_el.get_attribute("data-state")
                classes = opt_el.get_attribute("class") or ""
                if pressed == "true" or data_state == "on" or "selected" in classes or "active" in classes:
                    already_selected = True
                    break
            except Exception:
                continue
        if already_selected:
            continue

        # Determine the answer
        option_texts = [t for t, _ in options]
        answer = _match_prefilled(label, prefilled)
        if not answer:
            answer = _infer_toggle_answer(label, option_texts, settings)
        if not answer and ollama:
            answer = _ai_pick_option(ollama, label, option_texts, settings)

        if answer:
            clicked = False
            for opt_text, opt_el in options:
                if answer.lower().strip() in opt_text.lower().strip() or opt_text.lower().strip() in answer.lower().strip():
                    try:
                        opt_el.click()
                        log_fn(task_id, f"  Toggled '{opt_text}' for '{label}'")
                        clicked = True
                        time.sleep(0.3)
                        break
                    except Exception:
                        # Try JS click as fallback
                        try:
                            driver.execute_script("arguments[0].click();", opt_el)
                            log_fn(task_id, f"  Toggled '{opt_text}' for '{label}' (JS)")
                            clicked = True
                            time.sleep(0.3)
                            break
                        except Exception:
                            continue
            if not clicked:
                unknown.append({"question": label, "type": "toggle", "options": option_texts})
        else:
            unknown.append({"question": label, "type": "toggle", "options": option_texts})


def _find_toggle_groups(driver) -> list[dict]:
    """Discover toggle button groups on the page.

    Returns list of dicts: {label, options: [(text, element)], container}
    """
    groups = []

    # Pattern 1: role="group" containers (most common in Ashby)
    for container in driver.find_elements(By.CSS_SELECTOR, '[role="group"], [role="radiogroup"]'):
        try:
            if not container.is_displayed():
                continue
            buttons = container.find_elements(By.CSS_SELECTOR, 'button, [role="radio"], [role="option"]')
            if len(buttons) < 2:
                continue
            options = []
            for btn in buttons:
                text = btn.text.strip()
                if text and len(text) < 30:
                    options.append((text, btn))
            if len(options) >= 2:
                label = _get_nearby_label_for_container(driver, container)
                groups.append({"label": label, "options": options, "container": container})
        except Exception:
            continue

    # Pattern 2: Ashby segmented control — adjacent buttons in a div
    # Look for containers with exactly 2-5 button children that look like toggles
    for container in driver.find_elements(By.CSS_SELECTOR,
            '[class*="segmented"], [class*="toggle"], [class*="ButtonGroup"], '
            '[class*="button-group"], [data-testid*="toggle"], [data-testid*="segment"]'):
        try:
            if not container.is_displayed():
                continue
            buttons = container.find_elements(By.CSS_SELECTOR, 'button, div[role="button"], span[role="button"]')
            if not (2 <= len(buttons) <= 5):
                continue
            options = []
            for btn in buttons:
                text = btn.text.strip()
                if text and len(text) < 30:
                    options.append((text, btn))
            if len(options) >= 2:
                label = _get_nearby_label_for_container(driver, container)
                if label and not any(g["label"] == label for g in groups):
                    groups.append({"label": label, "options": options, "container": container})
        except Exception:
            continue

    # Pattern 3: JS-based discovery — find all question blocks with Yes/No style buttons
    try:
        toggle_data = driver.execute_script("""
            var results = [];
            // Find all form field containers
            var containers = document.querySelectorAll(
                '[class*="FormField"], [class*="form-field"], [class*="question"], '
                + '[class*="Question"], [data-testid*="field"], [data-testid*="question"]'
            );
            for (var c of containers) {
                var label = '';
                var labelEl = c.querySelector('label, [class*="label"], [class*="Label"], h3, h4, p:first-child');
                if (labelEl) label = labelEl.innerText.trim();
                if (!label) continue;

                // Look for button-like children that form a toggle
                var btns = c.querySelectorAll('button, [role="button"], [role="radio"]');
                if (btns.length >= 2 && btns.length <= 5) {
                    var allShort = true;
                    for (var b of btns) {
                        if (b.innerText.trim().length > 30 || !b.innerText.trim()) allShort = false;
                    }
                    if (allShort) {
                        results.push({
                            label: label,
                            containerIndex: Array.from(containers).indexOf(c),
                            buttonTexts: Array.from(btns).map(b => b.innerText.trim())
                        });
                    }
                }
            }
            return results;
        """)
        if toggle_data:
            containers = driver.find_elements(By.CSS_SELECTOR,
                '[class*="FormField"], [class*="form-field"], [class*="question"], '
                '[class*="Question"], [data-testid*="field"], [data-testid*="question"]')
            for td in toggle_data:
                label = td["label"]
                if any(g["label"] == label for g in groups):
                    continue
                idx = td["containerIndex"]
                if idx < len(containers):
                    container = containers[idx]
                    buttons = container.find_elements(By.CSS_SELECTOR,
                        'button, [role="button"], [role="radio"]')
                    options = []
                    for btn in buttons:
                        text = btn.text.strip()
                        if text and len(text) < 30:
                            options.append((text, btn))
                    if len(options) >= 2:
                        groups.append({"label": label, "options": options, "container": container})
    except Exception as e:
        logger.debug("JS toggle discovery failed: %s", e)

    return groups


def _infer_toggle_answer(label: str, options: list[str], settings: dict) -> str | None:
    """Infer Yes/No answers for common questions without needing AI.

    Uses the user's profile settings to answer standard screening questions.
    """
    label_lower = label.lower()
    option_lower = [o.lower() for o in options]

    # Only handle Yes/No style toggles for inference
    has_yes = any("yes" in o for o in option_lower)
    has_no = any("no" in o for o in option_lower)
    if not (has_yes and has_no):
        return None

    yes_text = next((o for o in options if o.lower().strip() == "yes"), "Yes")
    no_text = next((o for o in options if o.lower().strip() == "no"), "No")

    # "Are you based in [country]?" / "Are you located in..."
    if any(kw in label_lower for kw in ["based in", "located in", "reside in", "live in", "currently in"]):
        city = (settings.get("city") or "").lower()
        country = (settings.get("country") or "").lower()
        # Check if the question mentions a location the user is in
        if "united states" in label_lower or "u.s." in label_lower or "usa" in label_lower:
            if "canada" in country or any(c in city for c in ["ottawa", "toronto", "vancouver", "montreal"]):
                return no_text
            if "united states" in country or "us" in country:
                return yes_text
        if "canada" in label_lower:
            if "canada" in country or any(c in city for c in ["ottawa", "toronto", "vancouver", "montreal"]):
                return yes_text
        return None  # Let AI handle ambiguous location questions

    # "Do you require sponsorship?" / "Will you need visa sponsorship?"
    if any(kw in label_lower for kw in ["sponsorship", "visa", "work authorization",
                                         "authorized to work", "employment authorization"]):
        # Check if user has indicated sponsorship need in settings
        needs_sponsorship = settings.get("needs_sponsorship")
        if needs_sponsorship is not None:
            return yes_text if needs_sponsorship else no_text
        # Default: assume no sponsorship needed (common for citizens/PRs)
        return no_text

    # "Are you legally authorized to work?"
    if any(kw in label_lower for kw in ["legally authorized", "eligible to work",
                                         "right to work", "authorized to work"]):
        return yes_text

    # "Are you 18 years or older?"
    if any(kw in label_lower for kw in ["18 years", "18 or older", "legal age"]):
        return yes_text

    # "Do you have a valid driver's license?"
    if "driver" in label_lower and "license" in label_lower:
        has_license = settings.get("has_drivers_license")
        if has_license is not None:
            return yes_text if has_license else no_text

    # "Are you willing to relocate?"
    if "relocat" in label_lower:
        willing = settings.get("willing_to_relocate")
        if willing is not None:
            return yes_text if willing else no_text

    # "Do you have experience with...?" — let AI handle
    # "Have you worked at...?" — let AI handle

    return None


# ── Standard form element handlers ───────────────────────────


def _handle_selects(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle <select> dropdowns."""
    from selenium.webdriver.support.ui import Select
    for sel_el in driver.find_elements(By.TAG_NAME, "select"):
        try:
            if not sel_el.is_displayed():
                continue
            current = sel_el.get_attribute("value") or ""
            if current:
                continue
            label = _get_nearby_label(driver, sel_el)
            if not label:
                continue

            options = [o.text.strip() for o in sel_el.find_elements(By.TAG_NAME, "option")
                       if o.get_attribute("value")]

            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_pick_option(ollama, label, options, settings)

            if answer:
                s = Select(sel_el)
                for o in s.options:
                    if answer.lower() in o.text.strip().lower():
                        s.select_by_visible_text(o.text.strip())
                        log_fn(task_id, f"  Selected '{o.text.strip()}' for '{label}'")
                        break
            else:
                unknown.append({"question": label, "type": "select", "options": options})
        except Exception:
            continue

    # Ashby also uses custom dropdown components (not native <select>)
    _handle_custom_dropdowns(driver, settings, prefilled, unknown, log_fn, task_id, ollama)


def _handle_custom_dropdowns(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle Ashby's custom React dropdown components.

    These look like a clickable div that opens a listbox when clicked.
    """
    # Find elements that act as custom selects
    custom_selects = driver.find_elements(By.CSS_SELECTOR,
        '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], '
        '[class*="Select"], [class*="select"], [class*="Dropdown"], [class*="dropdown"]')

    for cs in custom_selects:
        try:
            if not cs.is_displayed():
                continue
            # Check if already has a value
            current_text = cs.text.strip()
            if current_text and current_text.lower() not in ["select", "choose", "select...", "choose...", "--"]:
                continue

            label = _get_nearby_label(driver, cs)
            if not label:
                continue

            # Click to open the dropdown
            cs.click()
            time.sleep(0.5)

            # Find the options in the opened listbox
            option_els = driver.find_elements(By.CSS_SELECTOR,
                '[role="option"], [role="listbox"] li, [class*="option"], [class*="Option"]')
            options = []
            option_map = {}
            for oel in option_els:
                text = oel.text.strip()
                if text and oel.is_displayed():
                    options.append(text)
                    option_map[text.lower()] = oel

            if not options:
                # Close dropdown by pressing Escape
                from selenium.webdriver.common.keys import Keys
                driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
                continue

            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_pick_option(ollama, label, options, settings)

            if answer:
                answer_lower = answer.lower()
                clicked = False
                for opt_text, opt_el in option_map.items():
                    if answer_lower in opt_text or opt_text in answer_lower:
                        opt_el.click()
                        log_fn(task_id, f"  Selected '{opt_text}' for '{label}'")
                        clicked = True
                        time.sleep(0.3)
                        break
                if not clicked:
                    from selenium.webdriver.common.keys import Keys
                    driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
                    unknown.append({"question": label, "type": "select", "options": options})
            else:
                from selenium.webdriver.common.keys import Keys
                driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
                unknown.append({"question": label, "type": "select", "options": options})
        except Exception:
            continue


def _handle_custom_text_inputs(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle text inputs for custom questions (excluding standard fields)."""
    exclude_names = ["name", "first", "last", "email", "phone", "linkedin",
                     "website", "portfolio", "github", "location", "city"]
    for inp in driver.find_elements(By.CSS_SELECTOR, 'input[type="text"], input:not([type])'):
        try:
            if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
                continue
            inp_name = (inp.get_attribute("name") or "").lower()
            inp_placeholder = (inp.get_attribute("placeholder") or "").lower()
            inp_id = (inp.get_attribute("id") or "").lower()
            combined = f"{inp_name} {inp_placeholder} {inp_id}"
            if any(ex in combined for ex in exclude_names):
                continue
            label = _get_nearby_label(driver, inp)
            if not label:
                continue
            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_answer_text(ollama, label, settings)
            if answer:
                inp.clear()
                inp.send_keys(answer)
                log_fn(task_id, f"  Filled '{label}'")
            else:
                unknown.append({"question": label, "type": "text", "options": []})
        except Exception:
            continue


def _handle_textareas(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle textarea fields."""
    for ta in driver.find_elements(By.TAG_NAME, "textarea"):
        try:
            if not ta.is_displayed() or (ta.get_attribute("value") or "").strip():
                continue
            label = _get_nearby_label(driver, ta)
            if not label:
                continue
            if any(kw in label.lower() for kw in ["cover letter", "cover_letter"]):
                continue
            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_answer_text(ollama, label, settings)
            if answer:
                ta.clear()
                ta.send_keys(answer)
                log_fn(task_id, f"  Filled textarea '{label}'")
            else:
                unknown.append({"question": label, "type": "text", "options": []})
        except Exception:
            continue


def _handle_radio_buttons(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Handle standard HTML radio button groups."""
    for fs in driver.find_elements(By.CSS_SELECTOR, "fieldset, [role='radiogroup']"):
        try:
            legend = None
            for sel in ["legend", "label:first-child", "[class*='label']", "[class*='Label']"]:
                try:
                    legend = fs.find_element(By.CSS_SELECTOR, sel)
                    break
                except Exception:
                    continue
            if not legend:
                continue
            label = legend.text.strip()
            if not label:
                continue

            radios = fs.find_elements(By.CSS_SELECTOR, 'input[type="radio"]')
            if not radios or any(r.is_selected() for r in radios):
                continue

            options = []
            radio_map = {}
            for r in radios:
                r_id = r.get_attribute("id")
                r_text = ""
                if r_id:
                    try:
                        r_label = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                        r_text = r_label.text.strip()
                    except Exception:
                        pass
                if not r_text:
                    # Try sibling text
                    try:
                        r_text = driver.execute_script(
                            "return arguments[0].parentElement.innerText.trim();", r)
                    except Exception:
                        pass
                if r_text:
                    options.append(r_text)
                    radio_map[r_text.lower()] = r

            answer = _match_prefilled(label, prefilled)
            if not answer and ollama and options:
                answer = _ai_pick_option(ollama, label, options, settings)

            if answer:
                answer_lower = answer.lower()
                for opt_text, radio_el in radio_map.items():
                    if answer_lower in opt_text or opt_text in answer_lower:
                        radio_el.click()
                        log_fn(task_id, f"  Selected '{opt_text}' for '{label}'")
                        break
            else:
                unknown.append({"question": label, "type": "radio", "options": options})
        except Exception:
            continue


# ── Helper functions ─────────────────────────────────────────


def _find_submit_button(driver: WebDriver):
    """Locate the submit button on an Ashby form."""
    for sel in [
        (By.CSS_SELECTOR, 'button[type="submit"]'),
        (By.CSS_SELECTOR, 'input[type="submit"]'),
        (By.CSS_SELECTOR, '[data-testid*="submit"]'),
        (By.CSS_SELECTOR, '[class*="submit" i]'),
    ]:
        try:
            btn = driver.find_element(*sel)
            if btn.is_displayed():
                return btn
        except Exception:
            continue

    # Fallback: find by text content
    for text in ["Submit", "Submit Application", "Apply", "Send Application"]:
        try:
            btn = driver.find_element(By.XPATH,
                f"//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
                f"'abcdefghijklmnopqrstuvwxyz'), '{text.lower()}')]")
            if btn.is_displayed():
                return btn
        except Exception:
            continue

    return None


def _fill_input(driver: WebDriver, css_selectors: str, value: str, label: str, log_fn, task_id: str):
    """Fill an input field if it exists and is empty."""
    if not value:
        return
    for sel in css_selectors.split(","):
        sel = sel.strip()
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                el.clear()
                el.send_keys(value)
                log_fn(task_id, f"  Filled {label}")
                return
        except Exception:
            continue


def _get_nearby_label(driver: WebDriver, element) -> str:
    """Find the label text for a form element."""
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
    if placeholder:
        return placeholder

    # Try parent container label via JS
    try:
        parent_label = driver.execute_script("""
            var el = arguments[0];
            // Walk up to find a container with a label
            for (var i = 0; i < 5; i++) {
                el = el.parentElement;
                if (!el) break;
                var label = el.querySelector('label, [class*="label"], [class*="Label"], legend');
                if (label && label.innerText.trim()) return label.innerText.trim();
            }
            return '';
        """, element)
        return parent_label or ""
    except Exception:
        return ""


def _get_nearby_label_for_container(driver: WebDriver, container) -> str:
    """Find the question label for a toggle button container.

    Looks at preceding siblings, parent labels, and nearby headings.
    """
    try:
        label = driver.execute_script("""
            var el = arguments[0];

            // Check for label inside the parent container
            var parent = el.parentElement;
            for (var i = 0; i < 5 && parent; i++) {
                var lbl = parent.querySelector('label, [class*="label"], [class*="Label"], legend, h3, h4');
                if (lbl && lbl.innerText.trim() && !el.contains(lbl)) {
                    return lbl.innerText.trim();
                }
                // Check preceding sibling
                var prev = parent.previousElementSibling;
                if (prev) {
                    var text = prev.innerText.trim();
                    if (text && text.length < 200) return text;
                }
                parent = parent.parentElement;
            }

            // aria-labelledby
            var labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
                var lblEl = document.getElementById(labelledBy);
                if (lblEl) return lblEl.innerText.trim();
            }

            // aria-label
            var ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return ariaLabel;

            return '';
        """, container)
        return label or ""
    except Exception:
        return ""


def _match_prefilled(label: str, prefilled: dict) -> str | None:
    """Fuzzy match a label against prefilled answers."""
    if not label or not prefilled:
        return None
    label_lower = label.lower().strip()
    for q, a in prefilled.items():
        q_lower = q.lower().strip()
        if q_lower in label_lower or label_lower in q_lower:
            return str(a)
        q_words = set(q_lower.split())
        l_words = set(label_lower.split())
        if len(q_words & l_words) >= 2:
            return str(a)
    return None


def _run_async(coro):
    """Run an async coroutine from sync context."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result(timeout=130)
    else:
        return asyncio.run(coro)


def _ai_pick_option(ollama: OllamaService, question: str, options: list[str], settings: dict) -> str | None:
    """Use AI to pick the best option from a list."""
    if not options:
        return None
    try:
        resume_text = settings.get("_resume_text", "")
        options_str = ", ".join(options)
        prompt_ctx = (
            f"Question: {question}\n"
            f"Options: {options_str}\n\n"
            f"Pick the single best option from the list above. "
            f"Reply with ONLY the option text, nothing else.\n\n"
            f"Applicant context:\n{resume_text[:3000]}"
        )
        answer = _run_async(ollama.answer_question(question, prompt_ctx))
        answer = answer.strip()
        answer_lower = answer.lower()
        for opt in options:
            if opt.lower() == answer_lower or answer_lower in opt.lower() or opt.lower() in answer_lower:
                return opt
    except Exception as e:
        logger.warning("AI option pick failed for '%s': %s", question, e)
    return None


def _ai_answer_text(ollama: OllamaService, question: str, settings: dict) -> str | None:
    """Use AI to generate a free-text answer."""
    try:
        resume_text = settings.get("_resume_text", "")
        answer = _run_async(ollama.answer_question(question, resume_text[:3000]))
        answer = answer.strip()
        return answer if answer else None
    except Exception as e:
        logger.warning("AI text answer failed for '%s': %s", question, e)
    return None
