"""
Workday ATS auto-apply handler (Selenium).

Workday forms are multi-page with a consistent structure:
- myworkdayjobs.com or workday.com URLs
- Standard fields: name, email, phone, address, work experience, education
- File upload for resume
- Multi-page flow with Next/Submit buttons
- Some positions require account creation (skip those)

Strategy:
1. Navigate to the job URL
2. Check if account creation is required — skip if so
3. Fill standard fields from settings and ResumeProfile
4. Upload resume
5. Navigate through pages (Next → Next → Submit)
6. For custom questions: prefilled answers, AI fallback, else PendingQuestion
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


def is_workday(url: str) -> bool:
    """Check if a URL is a Workday application."""
    url_lower = url.lower()
    return "myworkdayjobs" in url_lower or "workday.com" in url_lower


def apply_workday(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    task_id: str,
    log_fn,
    ollama: OllamaService | None = None,
) -> tuple[str, list[dict]]:
    """
    Fill and submit a Workday application form using Selenium.

    Returns:
        (result, unknown_fields)
        result: 'done', 'waiting', 'skipped', or 'failed'
        unknown_fields: list of fields the bot couldn't fill
    """
    log_fn(task_id, "Filling Workday application form...")
    time.sleep(random.uniform(3, 5))

    # Check if account creation is required
    page_source = driver.page_source.lower()
    if _requires_account_creation(page_source):
        log_fn(task_id, "Workday requires account creation — skipping")
        return "skipped", []

    unknown: list[dict] = []

    # Multi-page flow: fill fields on each page, then click Next/Submit
    max_pages = 10
    for page_num in range(max_pages):
        time.sleep(random.uniform(2, 3))

        # Fill standard fields on current page
        page_unknown = _fill_current_page(driver, settings, prefilled, log_fn, task_id, ollama)
        unknown.extend(page_unknown)

        # Upload resume if file input is present
        resume_path = settings.get("resume_file_path", "")
        if resume_path and os.path.exists(resume_path):
            for fi in driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]'):
                try:
                    fi.send_keys(os.path.abspath(resume_path))
                    log_fn(task_id, "  Uploaded resume")
                    time.sleep(2)
                    break
                except Exception:
                    continue

        # If there are unknowns, return early for user input
        if unknown:
            log_fn(task_id, f"Found {len(unknown)} questions that need answers")
            return "waiting", unknown

        # Try Submit button first (final page)
        submit_btn = _find_button(driver, ["Submit", "Submit Application"])
        if submit_btn:
            submit_btn.click()
            log_fn(task_id, "Clicked Submit on Workday form")
            time.sleep(random.uniform(3, 5))

            result_source = driver.page_source.lower()
            if "thank" in result_source or "success" in result_source or "submitted" in result_source:
                log_fn(task_id, "Application submitted successfully!")
                return "done", []
            return "done", []

        # Try Next button
        next_btn = _find_button(driver, ["Next", "Continue", "Save and Continue"])
        if next_btn:
            next_btn.click()
            log_fn(task_id, f"  Page {page_num + 1} completed, moving to next...")
            time.sleep(random.uniform(2, 4))
            continue

        # No Next or Submit found
        log_fn(task_id, "No Next or Submit button found on Workday form")
        return "failed", []

    log_fn(task_id, "Exceeded maximum page count for Workday form")
    return "failed", []


# ── Helper functions ─────────────────────────────────────────


def _requires_account_creation(page_source: str) -> bool:
    """Check if the Workday page requires creating an account."""
    indicators = [
        "create an account",
        "create account",
        "sign up",
        "register to apply",
        "create your account",
    ]
    return any(ind in page_source for ind in indicators)


def _fill_current_page(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    log_fn,
    task_id: str,
    ollama: OllamaService | None,
) -> list[dict]:
    """Fill all visible fields on the current Workday page."""
    unknown: list[dict] = []

    # Standard field mappings for Workday
    field_map = {
        "first name": settings.get("first_name", ""),
        "last name": settings.get("last_name", ""),
        "legal name": f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip(),
        "email": settings.get("email", ""),
        "email address": settings.get("email", ""),
        "phone": settings.get("phone", ""),
        "phone number": settings.get("phone", ""),
        "mobile": settings.get("phone", ""),
        "city": settings.get("city", ""),
        "address": settings.get("city", ""),
        "linkedin": settings.get("linkedin_url", ""),
    }

    # Fill text inputs
    for inp in driver.find_elements(By.CSS_SELECTOR,
            'input[type="text"], input[type="email"], input[type="tel"], input[type="number"]'):
        try:
            if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
                continue
            label = _get_nearby_label(driver, inp)
            if not label:
                continue

            # Try standard field mapping
            value = None
            label_lower = label.lower()
            for key, val in field_map.items():
                if key in label_lower and val:
                    value = val
                    break

            if value:
                inp.clear()
                inp.send_keys(value)
                log_fn(task_id, f"  Filled '{label}'")
                continue

            # Try prefilled answers
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

    # Fill select dropdowns
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
            if not answer and ollama and options:
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

    # Fill textareas
    for ta in driver.find_elements(By.TAG_NAME, "textarea"):
        try:
            if not ta.is_displayed() or (ta.get_attribute("value") or "").strip():
                continue
            label = _get_nearby_label(driver, ta)
            if not label:
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

    # Radio buttons
    radio_groups: dict[str, list] = {}
    for radio in driver.find_elements(By.CSS_SELECTOR, 'input[type="radio"]'):
        try:
            if not radio.is_displayed():
                continue
            name = radio.get_attribute("name") or ""
            if name:
                radio_groups.setdefault(name, []).append(radio)
        except Exception:
            continue

    for name, radios in radio_groups.items():
        try:
            if any(r.is_selected() for r in radios):
                continue
            label = _get_nearby_label(driver, radios[0])
            if not label:
                continue
            options = []
            for r in radios:
                r_id = r.get_attribute("id")
                if r_id:
                    try:
                        r_label = driver.find_element(By.CSS_SELECTOR, f'label[for="{r_id}"]')
                        options.append(r_label.text.strip())
                    except Exception:
                        val = r.get_attribute("value") or ""
                        if val:
                            options.append(val)

            answer = _match_prefilled(label, prefilled)
            if not answer and ollama and options:
                answer = _ai_pick_option(ollama, label, options, settings)

            if answer:
                for r in radios:
                    val = (r.get_attribute("value") or "").lower()
                    if answer.lower() in val or val in answer.lower():
                        r.click()
                        log_fn(task_id, f"  Selected '{answer}' for '{label}'")
                        break
            else:
                unknown.append({"question": label, "type": "radio", "options": options})
        except Exception:
            continue

    return unknown


def _find_button(driver: WebDriver, texts: list[str]):
    """Find a button by text content."""
    for text in texts:
        # Try exact button text
        for xpath in [
            f"//button[contains(text(), '{text}')]",
            f"//button[.//span[contains(text(), '{text}')]]",
            f"//input[@type='submit' and contains(@value, '{text}')]",
            f"//a[contains(text(), '{text}')]",
        ]:
            try:
                btn = driver.find_element(By.XPATH, xpath)
                if btn.is_displayed():
                    return btn
            except Exception:
                continue

    # Try generic submit button
    try:
        btn = driver.find_element(By.CSS_SELECTOR, 'button[type="submit"]')
        if btn.is_displayed():
            return btn
    except Exception:
        pass

    return None


def _get_nearby_label(driver: WebDriver, element) -> str:
    """Find the label for a form element."""
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
    try:
        parent_label = driver.execute_script("""
            var el = arguments[0];
            var parent = el.closest('[data-automation-id], .css-1wc0q5e, .formField, .field, .form-group');
            if (parent) {
                var label = parent.querySelector('label, [data-automation-id*="label"]');
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
    """Use AI to pick the best option from a list."""
    if not options:
        return None
    try:
        resume_text = settings.get("_resume_text", "")
        options_str = ", ".join(options)
        prompt_ctx = (
            f"Question: {question}\n"
            f"Options: {options_str}\n\n"
            f"Pick the single best option. Reply with ONLY the option text.\n\n"
            f"Applicant context:\n{resume_text[:3000]}"
        )
        answer = _run_async(ollama.answer_question(question, prompt_ctx))
        answer = answer.strip().lower()
        for opt in options:
            if opt.lower() == answer or answer in opt.lower() or opt.lower() in answer:
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
