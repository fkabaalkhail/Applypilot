"""
Greenhouse ATS auto-apply handler (Selenium).

Greenhouse forms follow a consistent structure:
- boards.greenhouse.io/company/jobs/ID or company.greenhouse.io
- Standard fields: first name, last name, email, phone, resume, cover letter
- Custom questions: dropdowns, text, checkboxes
- Single-page form with a Submit button

Strategy:
1. Navigate to the job URL
2. Fill standard fields from user settings
3. Upload resume
4. For custom questions: check prefilled answers, then AI fallback, else PendingQuestion
5. Submit or pause for user input
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


def is_greenhouse(url: str) -> bool:
    """Check if a URL is a Greenhouse application."""
    url_lower = url.lower()
    return any(x in url_lower for x in [
        "greenhouse.io", "boards.greenhouse", "grnh.se",
    ])


def apply_greenhouse(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    task_id: str,
    log_fn,
    ollama: OllamaService | None = None,
) -> tuple[str, list[dict]]:
    """
    Fill and submit a Greenhouse application form using Selenium.

    Returns:
        (result, unknown_fields)
        result: 'done', 'waiting', or 'failed'
        unknown_fields: list of fields the bot couldn't fill
    """
    log_fn(task_id, "Filling Greenhouse application form...")
    time.sleep(random.uniform(2, 4))

    unknown: list[dict] = []

    # --- Standard fields ---
    _fill_input(driver, '#first_name, input[name*="first_name"], input[autocomplete="given-name"]',
                settings.get("first_name", ""), "First Name", log_fn, task_id)
    _fill_input(driver, '#last_name, input[name*="last_name"], input[autocomplete="family-name"]',
                settings.get("last_name", ""), "Last Name", log_fn, task_id)
    _fill_input(driver, '#email, input[name*="email"], input[type="email"]',
                settings.get("email", ""), "Email", log_fn, task_id)
    _fill_input(driver, '#phone, input[name*="phone"], input[type="tel"]',
                settings.get("phone", ""), "Phone", log_fn, task_id)

    # LinkedIn URL
    for sel in ['input[name*="linkedin"]', 'input[placeholder*="linkedin"]', 'input[id*="linkedin"]']:
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

    # Website / Portfolio
    for sel in ['input[name*="website"]', 'input[name*="portfolio"]', 'input[placeholder*="github"]']:
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

    # --- Resume upload ---
    resume_path = settings.get("resume_file_path", "")
    if resume_path and os.path.exists(resume_path):
        file_inputs = driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
        for fi in file_inputs:
            label = _get_nearby_label(driver, fi)
            if any(kw in label.lower() for kw in ["resume", "cv", "curriculum"]) or not label:
                try:
                    fi.send_keys(os.path.abspath(resume_path))
                    log_fn(task_id, "  Uploaded resume")
                    break
                except Exception as e:
                    log_fn(task_id, f"  Resume upload failed: {e}")

    # --- Custom questions ---

    # Handle select dropdowns
    from selenium.webdriver.support.ui import Select
    selects = driver.find_elements(By.TAG_NAME, "select")
    for sel_el in selects:
        try:
            if not sel_el.is_displayed():
                continue
            # Skip if already has a non-default value
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

    # Handle text inputs (custom questions — exclude standard fields)
    exclude_names = ["name", "email", "phone", "linkedin", "website"]
    for inp in driver.find_elements(By.CSS_SELECTOR, 'input[type="text"]'):
        try:
            if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
                continue
            inp_name = (inp.get_attribute("name") or "").lower()
            if any(ex in inp_name for ex in exclude_names):
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

    # Handle textareas
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

    # Handle radio buttons / checkboxes in fieldsets
    for fs in driver.find_elements(By.CSS_SELECTOR, "fieldset, .field"):
        try:
            legend = None
            for sel in ["legend", "label:first-child", ".field__label"]:
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
            for r in radios:
                r_id = r.get_attribute("id")
                if r_id:
                    try:
                        r_label = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                        options.append(r_label.text.strip())
                    except Exception:
                        pass

            answer = _match_prefilled(label, prefilled)
            if not answer and ollama and options:
                answer = _ai_pick_option(ollama, label, options, settings)

            if answer:
                for r in radios:
                    r_id = r.get_attribute("id")
                    if r_id:
                        try:
                            r_label = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                            if answer.lower() in r_label.text.strip().lower():
                                r.click()
                                log_fn(task_id, f"  Selected '{answer}' for '{label}'")
                                break
                        except Exception:
                            continue
            else:
                unknown.append({"question": label, "type": "radio", "options": options})
        except Exception:
            continue

    # --- Check for unknowns ---
    if unknown:
        log_fn(task_id, f"Found {len(unknown)} questions that need answers")
        return "waiting", unknown

    # --- Submit ---
    time.sleep(random.uniform(1, 2))
    submit_btn = _find_submit_button(driver)
    if submit_btn:
        submit_btn.click()
        log_fn(task_id, "Clicked Submit on Greenhouse form")
        time.sleep(random.uniform(3, 5))

        page_source = driver.page_source.lower()
        if "thank" in page_source or "success" in page_source:
            log_fn(task_id, "Application submitted successfully!")
            return "done", []

        # Check for validation errors
        errors = driver.find_elements(By.CSS_SELECTOR, '.field--error, .error, [aria-invalid="true"]')
        if errors:
            log_fn(task_id, f"Form has {len(errors)} validation errors")
            return "failed", []

        return "done", []

    log_fn(task_id, "Could not find submit button")
    return "failed", []


# ── Helper functions ─────────────────────────────────────────


def _find_submit_button(driver: WebDriver):
    """Locate the submit button on a Greenhouse form."""
    for sel in [
        (By.CSS_SELECTOR, 'button[type="submit"]'),
        (By.CSS_SELECTOR, 'input[type="submit"]'),
        (By.CSS_SELECTOR, "#submit_app"),
        (By.CSS_SELECTOR, ".postings-btn"),
    ]:
        try:
            btn = driver.find_element(*sel)
            if btn.is_displayed():
                return btn
        except Exception:
            continue

    # Fallback: find by text content
    for text in ["Submit", "Apply"]:
        try:
            btn = driver.find_element(By.XPATH, f"//button[contains(text(), '{text}')]")
            if btn.is_displayed():
                return btn
        except Exception:
            continue

    return None


def _fill_input(driver: WebDriver, css_selectors: str, value: str, label: str, log_fn, task_id: str):
    """Fill an input field if it exists and is empty. Accepts comma-separated CSS selectors."""
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
            var parent = el.closest('.field, .form-group, .form__field');
            if (parent) {
                var label = parent.querySelector('label, .field__label');
                if (label) return label.innerText.trim();
            }
            return '';
        """, element)
        return parent_label or ""
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
    """Use AI to pick the best option from a list for a select/radio field."""
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
        # Match to an actual option
        answer_lower = answer.lower()
        for opt in options:
            if opt.lower() == answer_lower or answer_lower in opt.lower() or opt.lower() in answer_lower:
                return opt
    except Exception as e:
        logger.warning("AI option pick failed for '%s': %s", question, e)
    return None


def _ai_answer_text(ollama: OllamaService, question: str, settings: dict) -> str | None:
    """Use AI to generate a free-text answer for a form field."""
    try:
        resume_text = settings.get("_resume_text", "")
        answer = _run_async(ollama.answer_question(question, resume_text[:3000]))
        answer = answer.strip()
        return answer if answer else None
    except Exception as e:
        logger.warning("AI text answer failed for '%s': %s", question, e)
    return None
