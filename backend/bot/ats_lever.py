"""
Lever ATS auto-apply handler (Selenium).

Lever forms follow a consistent structure:
- jobs.lever.co/company/job-id or company.lever.co
- Standard fields: full name, email, phone, resume, LinkedIn, website
- Custom questions: text, textarea, dropdown, file uploads
- Single-page form with "Submit application" button

Lever is simpler than Greenhouse — fewer custom question types,
more predictable field names.
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


def is_lever(url: str) -> bool:
    """Check if a URL is a Lever application."""
    url_lower = url.lower()
    return any(x in url_lower for x in [
        "lever.co", "jobs.lever",
    ])


def apply_lever(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    task_id: str,
    log_fn,
    ollama: OllamaService | None = None,
) -> tuple[str, list[dict]]:
    """
    Fill and submit a Lever application form using Selenium.

    Returns:
        (result, unknown_fields)
    """
    log_fn(task_id, "Filling Lever application form...")
    time.sleep(random.uniform(2, 4))

    # Check if we need to click "Apply" first to show the form
    for sel in [
        (By.CSS_SELECTOR, "a.postings-btn"),
        (By.CSS_SELECTOR, 'a[href*="apply"]'),
        (By.XPATH, '//button[contains(text(), "Apply")]'),
        (By.XPATH, '//a[contains(text(), "Apply")]'),
    ]:
        try:
            btn = driver.find_element(*sel)
            if btn.is_displayed():
                btn.click()
                time.sleep(random.uniform(2, 3))
                break
        except Exception:
            continue

    unknown: list[dict] = []

    # --- Standard fields ---

    # Full name (Lever uses a single name field)
    full_name = f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip()
    _fill_input(driver, 'input[name="name"], input[placeholder*="name"]',
                full_name, "Full Name", log_fn, task_id)

    # Email
    _fill_input(driver, 'input[name="email"], input[type="email"]',
                settings.get("email", ""), "Email", log_fn, task_id)

    # Phone
    _fill_input(driver, 'input[name="phone"], input[type="tel"]',
                settings.get("phone", ""), "Phone", log_fn, task_id)

    # Current company (optional)
    _fill_input(driver, 'input[name="org"], input[name*="company"]',
                "", "Company", log_fn, task_id)

    # LinkedIn
    for sel in ['input[name*="linkedin"]', 'input[name="urls[LinkedIn]"]']:
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

    # GitHub / Website
    for sel in ['input[name*="github"]', 'input[name="urls[GitHub]"]',
                'input[name*="portfolio"]', 'input[name="urls[Portfolio]"]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                website = settings.get("website", "")
                if website:
                    el.clear()
                    el.send_keys(website)
                    log_fn(task_id, "  Filled GitHub/Portfolio")
                    break
        except Exception:
            continue

    # Other URL fields
    for ui in driver.find_elements(By.CSS_SELECTOR, 'input[name^="urls["]'):
        try:
            if (ui.get_attribute("value") or "").strip():
                continue
            name = (ui.get_attribute("name") or "").lower()
            if "linkedin" in name:
                ui.clear()
                ui.send_keys(settings.get("linkedin_url", ""))
            elif "github" in name or "portfolio" in name:
                ui.clear()
                ui.send_keys(settings.get("website", ""))
        except Exception:
            continue

    # --- Resume upload ---
    resume_path = settings.get("resume_file_path", "")
    if resume_path and os.path.exists(resume_path):
        file_inputs = driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
        resume_uploaded = False
        for fi in file_inputs:
            name = (fi.get_attribute("name") or "").lower()
            label = _get_nearby_label(driver, fi)
            if "resume" in name or "resume" in label.lower() or "cv" in label.lower():
                try:
                    fi.send_keys(os.path.abspath(resume_path))
                    log_fn(task_id, "  Uploaded resume")
                    resume_uploaded = True
                    break
                except Exception as e:
                    log_fn(task_id, f"  Resume upload failed: {e}")

        # If no resume-specific input found, try the first file input
        if not resume_uploaded and file_inputs:
            try:
                file_inputs[0].send_keys(os.path.abspath(resume_path))
                log_fn(task_id, "  Uploaded resume (first file input)")
            except Exception:
                pass

    # --- Custom questions ---

    from selenium.webdriver.support.ui import Select

    # Select dropdowns
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

    # Text inputs (custom questions)
    for inp in driver.find_elements(By.CSS_SELECTOR,
            '.application-additional input[type="text"], .custom-question input[type="text"]'):
        try:
            if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
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

    # Textareas
    for ta in driver.find_elements(By.TAG_NAME, "textarea"):
        try:
            if not ta.is_displayed() or (ta.get_attribute("value") or "").strip():
                continue
            label = _get_nearby_label(driver, ta)
            if not label or "cover" in label.lower():
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
    for fs in driver.find_elements(By.CSS_SELECTOR, "fieldset, .application-question"):
        try:
            legend = None
            for sel in ["legend", "label:first-child", ".application-label"]:
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
        log_fn(task_id, "Clicked Submit on Lever form")
        time.sleep(random.uniform(3, 5))

        page_source = driver.page_source.lower()
        if "thank" in page_source or "submitted" in page_source or "success" in page_source:
            log_fn(task_id, "Application submitted successfully!")
            return "done", []

        return "done", []

    log_fn(task_id, "Could not find submit button on Lever form")
    return "failed", []


# ── Helper functions ─────────────────────────────────────────


def _find_submit_button(driver: WebDriver):
    """Locate the submit button on a Lever form."""
    for sel in [
        (By.CSS_SELECTOR, 'button[type="submit"]'),
        (By.CSS_SELECTOR, "button.postings-btn"),
    ]:
        try:
            btn = driver.find_element(*sel)
            if btn.is_displayed():
                return btn
        except Exception:
            continue

    for text in ["Submit application", "Submit", "Apply"]:
        try:
            btn = driver.find_element(By.XPATH, f"//button[contains(text(), '{text}')]")
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
            var parent = el.closest('.application-question, .field, .form-group');
            if (parent) {
                var label = parent.querySelector('label, .application-label');
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
