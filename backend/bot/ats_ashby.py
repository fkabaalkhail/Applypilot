"""
Ashby ATS auto-apply handler (Selenium).

Ashby forms (jobs.ashbyhq.com) use a React-based UI with:
- Standard fields: name, email, phone, resume, LinkedIn, etc.
- Toggle-style Yes/No buttons (NOT radio buttons, NOT checkboxes)
  These are rendered as clickable <div> or <button> siblings inside a
  wrapper. They do NOT use <input type="radio"> or role="group" reliably.
  The key is to find question text + adjacent clickable elements with
  short text like "Yes"/"No".
- Text inputs, textareas, select dropdowns
- Single-page form with a Submit button

Detection strategy for toggles:
  Ashby wraps each question in a form-field container. Inside, the label
  is a <label> or <p> or <div> with the question text. Below it sits a
  row of styled <div> or <button> elements acting as toggle options.
  We use a JS-based approach to walk the DOM and pair questions with
  their toggle options.
"""

from __future__ import annotations

import asyncio
import os
import time
import random
import logging
from typing import TYPE_CHECKING

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver

if TYPE_CHECKING:
    from backend.services.ollama_service import OllamaService

logger = logging.getLogger(__name__)


def is_ashby(url: str) -> bool:
    """Check if a URL is an Ashby application."""
    url_lower = url.lower()
    return any(x in url_lower for x in ["ashbyhq.com", "jobs.ashby"])


def apply_ashby(
    driver: WebDriver,
    settings: dict,
    prefilled: dict,
    task_id: str,
    log_fn,
    ollama: OllamaService | None = None,
) -> tuple[str, list[dict]]:
    """Fill and submit an Ashby application form."""
    log_fn(task_id, "Filling Ashby application form...")
    time.sleep(random.uniform(2, 4))

    unknown: list[dict] = []

    # --- Standard fields ---
    full_name = f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip()
    _fill_input(driver, 'input[name="name"], input[name*="full_name"]', full_name, "Name", log_fn, task_id)
    _fill_input(driver, 'input[name*="first"], input[placeholder*="First"]',
                settings.get("first_name", ""), "First Name", log_fn, task_id)
    _fill_input(driver, 'input[name*="last"], input[placeholder*="Last"]',
                settings.get("last_name", ""), "Last Name", log_fn, task_id)
    _fill_input(driver, 'input[name*="email"], input[type="email"]',
                settings.get("email", ""), "Email", log_fn, task_id)
    _fill_input(driver, 'input[name*="phone"], input[type="tel"]',
                settings.get("phone", ""), "Phone", log_fn, task_id)

    # LinkedIn
    for sel in ['input[name*="linkedin"]', 'input[placeholder*="LinkedIn"]',
                'input[placeholder*="linkedin"]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                val = settings.get("linkedin_url", "")
                if val:
                    el.clear(); el.send_keys(val)
                    log_fn(task_id, "  Filled LinkedIn URL")
                    break
        except Exception:
            continue

    # Website / Portfolio
    for sel in ['input[name*="website"]', 'input[name*="portfolio"]',
                'input[placeholder*="github"]', 'input[placeholder*="portfolio"]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                val = settings.get("website", "")
                if val:
                    el.clear(); el.send_keys(val)
                    log_fn(task_id, "  Filled Website")
                    break
        except Exception:
            continue

    # Location / City
    for sel in ['input[name*="location"]', 'input[name*="city"]',
                'input[placeholder*="location"]', 'input[placeholder*="city"]',
                'input[placeholder*="Location"]', 'input[placeholder*="City"]']:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                val = settings.get("city", "")
                if val:
                    el.clear(); el.send_keys(val)
                    log_fn(task_id, "  Filled Location")
                    break
        except Exception:
            continue

    # --- Resume upload ---
    resume_path = settings.get("resume_file_path", "")
    if resume_path and os.path.exists(resume_path):
        for fi in driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]'):
            try:
                fi.send_keys(os.path.abspath(resume_path))
                log_fn(task_id, "  Uploaded resume")
                time.sleep(1)
                break
            except Exception as e:
                log_fn(task_id, f"  Resume upload failed: {e}")

    # --- Toggle Yes/No buttons (Ashby's main challenge) ---
    _handle_ashby_toggles(driver, settings, prefilled, unknown, log_fn, task_id, ollama)

    # --- Select dropdowns (native) ---
    _handle_selects(driver, prefilled, unknown, log_fn, task_id, ollama, settings)

    # --- Custom text inputs ---
    _handle_custom_text_inputs(driver, prefilled, unknown, log_fn, task_id, ollama, settings)

    # --- Textareas ---
    _handle_textareas(driver, prefilled, unknown, log_fn, task_id, ollama, settings)

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
        page_src = driver.page_source.lower()
        if any(kw in page_src for kw in ["thank", "success", "submitted", "received"]):
            log_fn(task_id, "Application submitted successfully!")
            return "done", []
        errors = [e for e in driver.find_elements(By.CSS_SELECTOR,
            '[class*="error"], [class*="Error"], [aria-invalid="true"]') if e.is_displayed()]
        if errors:
            log_fn(task_id, f"Form has {len(errors)} validation errors")
            return "failed", []
        return "done", []

    log_fn(task_id, "Could not find submit button")
    return "failed", []


# ── Toggle handler — the core Ashby challenge ───────────────


def _handle_ashby_toggles(driver, settings, prefilled, unknown, log_fn, task_id, ollama):
    """Find and answer Ashby's toggle-style Yes/No questions.

    BRUTE FORCE approach: Instead of trying to detect "toggle groups" by
    DOM structure, we find ALL visible text on the page that looks like a
    question (contains '?'), then look for nearby clickable elements with
    short text like "Yes"/"No". This works regardless of Ashby's DOM
    structure, class names, or React component hierarchy.
    """
    # First, dump the page structure for debugging
    _dump_form_debug(driver, log_fn, task_id)

    # Use the brute-force question finder
    questions = _find_all_questions_with_options(driver)
    log_fn(task_id, f"  Found {len(questions)} toggle/choice question(s)")

    for q in questions:
        label = q["label"]
        option_texts = q["options"]

        if not label or not option_texts:
            continue

        if q.get("already_selected"):
            log_fn(task_id, f"  '{label[:50]}' already answered, skipping")
            continue

        # Determine the answer
        answer = _match_prefilled(label, prefilled)
        if not answer:
            answer = _infer_toggle_answer(label, option_texts, settings)
        if not answer and ollama:
            answer = _ai_pick_option(ollama, label, option_texts, settings)

        if answer:
            clicked = _click_option_by_text(driver, q, answer)
            if clicked:
                log_fn(task_id, f"  Answered '{answer}' for '{label[:60]}'")
                time.sleep(0.5)
            else:
                log_fn(task_id, f"  FAILED to click '{answer}' for '{label[:60]}'")
                unknown.append({"question": label, "type": "toggle", "options": option_texts})
        else:
            unknown.append({"question": label, "type": "toggle", "options": option_texts})


def _dump_form_debug(driver, log_fn, task_id):
    """Dump key page info for debugging toggle detection failures."""
    try:
        debug = driver.execute_script("""
            var info = [];
            // Find all elements with text "Yes" or "No"
            var walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_ELEMENT, null, false
            );
            var yesNoEls = [];
            while (walker.nextNode()) {
                var node = walker.currentNode;
                var text = node.innerText ? node.innerText.trim() : '';
                if (text === 'Yes' || text === 'No') {
                    yesNoEls.push({
                        tag: node.tagName,
                        text: text,
                        role: node.getAttribute('role') || '',
                        classes: (node.getAttribute('class') || '').substring(0, 80),
                        parent_tag: node.parentElement ? node.parentElement.tagName : '',
                        parent_classes: node.parentElement ?
                            (node.parentElement.getAttribute('class') || '').substring(0, 80) : ''
                    });
                }
            }
            info.push('Yes/No elements found: ' + yesNoEls.length);
            for (var i = 0; i < Math.min(yesNoEls.length, 10); i++) {
                var e = yesNoEls[i];
                info.push('  ' + e.tag + '.' + e.classes + ' text="' + e.text +
                    '" role=' + e.role + ' parent=' + e.parent_tag + '.' + e.parent_classes);
            }

            // Find all question-like text (contains ?)
            var questions = [];
            var allText = document.querySelectorAll('label, p, span, div, h1, h2, h3, h4, h5, h6');
            for (var j = 0; j < allText.length; j++) {
                var t = allText[j].innerText.trim();
                if (t.includes('?') && t.length > 10 && t.length < 300) {
                    questions.push(t.substring(0, 100));
                }
            }
            info.push('Questions found: ' + questions.length);
            for (var k = 0; k < Math.min(questions.length, 10); k++) {
                info.push('  Q: ' + questions[k]);
            }

            return info.join('\\n');
        """)
        if debug:
            for line in debug.split('\n'):
                log_fn(task_id, f"  [DEBUG] {line}")
    except Exception as e:
        log_fn(task_id, f"  [DEBUG] dump failed: {e}")


def _find_all_questions_with_options(driver) -> list[dict]:
    """Brute-force: find all question text + nearby clickable options.

    Returns list of {label, options: [str], elements_info: [...], already_selected}
    """
    try:
        results = driver.execute_script("""
        var found = [];

        // Step 1: Find ALL elements whose direct text content is exactly
        // "Yes" or "No" (or other short option-like text).
        // Use TreeWalker to get leaf-level elements.
        function getDirectText(el) {
            // Get only the element's own text, not children's text
            var text = '';
            for (var i = 0; i < el.childNodes.length; i++) {
                if (el.childNodes[i].nodeType === 3) { // TEXT_NODE
                    text += el.childNodes[i].textContent;
                }
            }
            return text.trim();
        }

        function getVisibleText(el) {
            return (el.innerText || el.textContent || '').trim();
        }

        // Find elements that are "Yes" or "No" buttons/options
        var optionEls = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var directText = getDirectText(el);
            var visibleText = getVisibleText(el);
            // Check if this element's text is a short option (Yes, No, etc.)
            var text = directText || visibleText;
            if (!text) continue;
            if (text.length > 20) continue;
            if (text.includes('\\n')) continue;

            // Is it "Yes" or "No" specifically?
            var isYesNo = (text === 'Yes' || text === 'No');
            if (!isYesNo) continue;

            // Is it visible?
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            optionEls.push({el: el, text: text, rect: rect});
        }

        // Step 2: Group option elements that are siblings or near each other
        var used = new Set();
        for (var i = 0; i < optionEls.length; i++) {
            if (used.has(i)) continue;
            var a = optionEls[i];

            // Find a partner: another option element that is a sibling or
            // vertically close (within 5px Y difference, within 300px X)
            var group = [a];
            used.add(i);

            for (var j = i + 1; j < optionEls.length; j++) {
                if (used.has(j)) continue;
                var b = optionEls[j];

                // Check if they're siblings
                var areSiblings = (a.el.parentElement === b.el.parentElement);

                // Check if they're visually adjacent (same row)
                var yDiff = Math.abs(a.rect.top - b.rect.top);
                var xDiff = Math.abs(a.rect.left - b.rect.left);
                var visuallyClose = (yDiff < 10 && xDiff < 400);

                if (areSiblings || visuallyClose) {
                    group.push(b);
                    used.add(j);
                }
            }

            if (group.length < 2) continue;

            // Step 3: Find the question label for this group
            // Look above the group for text containing '?'
            var groupTop = Math.min.apply(null, group.map(function(g) { return g.rect.top; }));
            var groupLeft = Math.min.apply(null, group.map(function(g) { return g.rect.left; }));

            var label = '';

            // Strategy A: Walk up from the first option's parent to find question text
            var searchEl = group[0].el.parentElement;
            for (var up = 0; up < 10 && searchEl; up++) {
                // Check preceding siblings of this element
                var prev = searchEl.previousElementSibling;
                while (prev) {
                    var prevText = getVisibleText(prev);
                    if (prevText && prevText.length > 10 && prevText.length < 500) {
                        label = prevText;
                        break;
                    }
                    prev = prev.previousElementSibling;
                }
                if (label) break;

                // Check if parent itself contains a label before the options
                var parentText = '';
                var children = searchEl.children;
                for (var ci = 0; ci < children.length; ci++) {
                    var child = children[ci];
                    // Stop if we hit one of our option elements
                    var isOption = group.some(function(g) {
                        return child === g.el || child.contains(g.el);
                    });
                    if (isOption) break;
                    var ct = getVisibleText(child);
                    if (ct && ct.length > 10 && ct.length < 500) {
                        parentText = ct;
                    }
                }
                if (parentText) {
                    label = parentText;
                    break;
                }

                searchEl = searchEl.parentElement;
            }

            // Strategy B: Find the closest text element above the group by position
            if (!label) {
                var allTextEls = document.querySelectorAll('label, p, span, div, h3, h4, h5');
                var bestDist = 999999;
                for (var ti = 0; ti < allTextEls.length; ti++) {
                    var te = allTextEls[ti];
                    var tt = getVisibleText(te);
                    if (!tt || tt.length < 10 || tt.length > 500) continue;
                    if (tt === 'Yes' || tt === 'No') continue;
                    var tr = te.getBoundingClientRect();
                    // Must be above the group
                    if (tr.bottom > groupTop + 5) continue;
                    // Must be roughly aligned horizontally
                    if (Math.abs(tr.left - groupLeft) > 200) continue;
                    var dist = groupTop - tr.bottom;
                    if (dist < bestDist && dist >= 0) {
                        bestDist = dist;
                        label = tt;
                    }
                }
            }

            // Check if already selected
            var alreadySelected = false;
            for (var gi = 0; gi < group.length; gi++) {
                var gel = group[gi].el;
                var ap = gel.getAttribute('aria-pressed');
                var ds = gel.getAttribute('data-state');
                var cls = (gel.getAttribute('class') || '').toLowerCase();
                if (ap === 'true' || ds === 'on' || ds === 'active' ||
                    cls.includes('selected') || cls.includes('active')) {
                    alreadySelected = true;
                    break;
                }
            }

            // Tag each option element so we can find it later
            var groupId = 'ashby_q_' + found.length;
            for (var gi2 = 0; gi2 < group.length; gi2++) {
                group[gi2].el.setAttribute('data-ashby-opt-id', groupId + '_' + gi2);
            }

            found.push({
                label: label,
                options: group.map(function(g) { return g.text; }),
                group_id: groupId,
                count: group.length,
                already_selected: alreadySelected
            });
        }

        return found;
        """)
        return results or []
    except Exception as e:
        logger.warning("Question discovery failed: %s", e)
        return []


def _click_option_by_text(driver, question: dict, answer: str) -> bool:
    """Click the option element matching the answer text."""
    group_id = question.get("group_id", "")
    options = question.get("options", [])
    answer_lower = answer.lower().strip()

    target_idx = None
    for i, opt in enumerate(options):
        if answer_lower == opt.lower().strip():
            target_idx = i
            break
    if target_idx is None:
        for i, opt in enumerate(options):
            if answer_lower in opt.lower() or opt.lower() in answer_lower:
                target_idx = i
                break

    if target_idx is None:
        return False

    opt_id = f"{group_id}_{target_idx}"

    try:
        # Try multiple click strategies
        clicked = driver.execute_script("""
            var el = document.querySelector('[data-ashby-opt-id="' + arguments[0] + '"]');
            if (!el) return 'not_found';

            // Strategy 1: Direct click
            try { el.click(); } catch(e) {}

            // Strategy 2: Dispatch mouse events
            try {
                el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
                el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
                el.dispatchEvent(new MouseEvent('click', {bubbles: true}));
            } catch(e) {}

            // Strategy 3: Focus + Enter
            try {
                el.focus();
                el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
                el.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', bubbles: true}));
            } catch(e) {}

            return 'clicked';
        """, opt_id)
        return clicked == 'clicked'
    except Exception as e:
        logger.warning("Option click failed: %s", e)

    # Fallback: use Selenium click
    try:
        el = driver.find_element(By.CSS_SELECTOR, f'[data-ashby-opt-id="{opt_id}"]')
        el.click()
        return True
    except Exception:
        pass

    return False


# ── Smart inference for common Yes/No questions ──────────────


def _infer_toggle_answer(label: str, options: list[str], settings: dict) -> str | None:
    """Answer common Yes/No questions without AI, using user profile data.

    Handles the most frequent screening questions on Ashby forms.
    """
    label_lower = label.lower()
    opt_lower = [o.lower().strip() for o in options]

    has_yes = any(o == "yes" for o in opt_lower)
    has_no = any(o == "no" for o in opt_lower)
    if not (has_yes and has_no):
        return None  # Not a Yes/No toggle — let AI handle

    yes_text = next((o for o in options if o.lower().strip() == "yes"), "Yes")
    no_text = next((o for o in options if o.lower().strip() == "no"), "No")

    city = (settings.get("city") or "").lower()
    country = (settings.get("country") or "").lower()

    # Detect if user is in Canada
    canadian_indicators = [
        "canada", "ontario", "quebec", "british columbia", "alberta",
        "ottawa", "toronto", "vancouver", "montreal", "calgary",
        "edmonton", "winnipeg", "halifax",
    ]
    is_canadian = any(ind in city or ind in country for ind in canadian_indicators)

    # Detect if user is in the US
    us_indicators = ["united states", "usa", "u.s.", "us"]
    is_us = any(ind in country for ind in us_indicators)

    # ── "Are you based in the United States?" ──
    if any(kw in label_lower for kw in ["based in", "located in", "reside in",
                                         "live in", "currently in"]):
        if "united states" in label_lower or "u.s." in label_lower or "usa" in label_lower:
            return yes_text if is_us else no_text
        if "canada" in label_lower:
            return yes_text if is_canadian else no_text
        # Generic location question — check if the mentioned place matches user
        if city and city in label_lower:
            return yes_text
        return None  # Ambiguous — let AI handle

    # ── "Do you require employment sponsorship?" ──
    if any(kw in label_lower for kw in ["sponsorship", "sponsor", "visa",
                                         "require employment", "require work"]):
        needs = settings.get("needs_sponsorship")
        if needs is not None:
            return yes_text if needs else no_text
        # Default: no sponsorship needed (citizen/PR assumption)
        return no_text

    # ── "Are you legally authorized to work?" ──
    if any(kw in label_lower for kw in ["legally authorized", "authorized to work",
                                         "eligible to work", "right to work",
                                         "legally eligible"]):
        return yes_text

    # ── "Are you 18 years or older?" ──
    if any(kw in label_lower for kw in ["18 years", "18 or older", "legal age",
                                         "age of majority"]):
        return yes_text

    # ── "Are you willing to relocate?" ──
    if "relocat" in label_lower:
        willing = settings.get("willing_to_relocate")
        if willing is not None:
            return yes_text if willing else no_text

    # ── "Do you have a valid driver's license?" ──
    if "driver" in label_lower and "licen" in label_lower:
        has_license = settings.get("has_drivers_license")
        if has_license is not None:
            return yes_text if has_license else no_text

    # ── "Have you previously worked at [company]?" ──
    if "previously worked" in label_lower or "worked at" in label_lower:
        return no_text  # Safe default

    # ── "Are you comfortable working [remote/onsite/hybrid]?" ──
    if "comfortable" in label_lower and any(kw in label_lower for kw in ["remote", "onsite", "hybrid", "office"]):
        return yes_text  # Applying means you're interested

    return None  # Unknown question — let AI handle


# ── Standard form element handlers ───────────────────────────


def _handle_selects(driver, prefilled, unknown, log_fn, task_id, ollama, settings):
    """Handle <select> dropdowns."""
    from selenium.webdriver.support.ui import Select
    for sel_el in driver.find_elements(By.TAG_NAME, "select"):
        try:
            if not sel_el.is_displayed():
                continue
            if sel_el.get_attribute("value"):
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


def _handle_custom_text_inputs(driver, prefilled, unknown, log_fn, task_id, ollama, settings):
    """Handle text inputs for custom questions (excluding standard fields)."""
    skip = ["name", "first", "last", "email", "phone", "linkedin",
            "website", "portfolio", "github", "location", "city"]
    for inp in driver.find_elements(By.CSS_SELECTOR, 'input[type="text"], input:not([type])'):
        try:
            if not inp.is_displayed() or (inp.get_attribute("value") or "").strip():
                continue
            combined = " ".join(filter(None, [
                inp.get_attribute("name"), inp.get_attribute("placeholder"), inp.get_attribute("id")
            ])).lower()
            if any(s in combined for s in skip):
                continue
            label = _get_nearby_label(driver, inp)
            if not label:
                continue
            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_answer_text(ollama, label, settings)
            if answer:
                inp.clear(); inp.send_keys(answer)
                log_fn(task_id, f"  Filled '{label}'")
            else:
                unknown.append({"question": label, "type": "text", "options": []})
        except Exception:
            continue


def _handle_textareas(driver, prefilled, unknown, log_fn, task_id, ollama, settings):
    """Handle textarea fields."""
    for ta in driver.find_elements(By.TAG_NAME, "textarea"):
        try:
            if not ta.is_displayed() or (ta.get_attribute("value") or "").strip():
                continue
            label = _get_nearby_label(driver, ta)
            if not label:
                continue
            if "cover letter" in label.lower():
                continue
            answer = _match_prefilled(label, prefilled)
            if not answer and ollama:
                answer = _ai_answer_text(ollama, label, settings)
            if answer:
                ta.clear(); ta.send_keys(answer)
                log_fn(task_id, f"  Filled textarea '{label}'")
            else:
                unknown.append({"question": label, "type": "text", "options": []})
        except Exception:
            continue


# ── Helper functions ─────────────────────────────────────────


def _find_submit_button(driver: WebDriver):
    """Locate the submit button on an Ashby form."""
    for sel in [
        (By.CSS_SELECTOR, 'button[type="submit"]'),
        (By.CSS_SELECTOR, 'input[type="submit"]'),
        (By.CSS_SELECTOR, '[data-testid*="submit"]'),
    ]:
        try:
            btn = driver.find_element(*sel)
            if btn.is_displayed():
                return btn
        except Exception:
            continue
    # Fallback: find by text
    for text in ["Submit", "Submit Application", "Apply", "Send Application"]:
        try:
            btn = driver.find_element(By.XPATH,
                f"//button[contains(translate(text(),"
                f"'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),"
                f"'{text.lower()}')]")
            if btn.is_displayed():
                return btn
        except Exception:
            continue
    return None


def _fill_input(driver, css_selectors: str, value: str, label: str, log_fn, task_id: str):
    """Fill an input field if it exists and is empty."""
    if not value:
        return
    for sel in css_selectors.split(","):
        sel = sel.strip()
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            if el.is_displayed() and not (el.get_attribute("value") or "").strip():
                el.clear(); el.send_keys(value)
                log_fn(task_id, f"  Filled {label}")
                return
        except Exception:
            continue


def _get_nearby_label(driver, element) -> str:
    """Find the label text for a form element."""
    el_id = element.get_attribute("id")
    if el_id:
        try:
            return driver.find_element(By.CSS_SELECTOR, f'label[for="{el_id}"]').text.strip()
        except Exception:
            pass
    for attr in ["aria-label", "placeholder"]:
        val = element.get_attribute(attr)
        if val:
            return val
    try:
        return driver.execute_script("""
            var el = arguments[0];
            for (var i = 0; i < 5; i++) {
                el = el.parentElement;
                if (!el) break;
                var lbl = el.querySelector('label, [class*="label"], [class*="Label"], legend');
                if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
            }
            return '';
        """, element) or ""
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
        if len(set(q_lower.split()) & set(label_lower.split())) >= 2:
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
    return asyncio.run(coro)


def _ai_pick_option(ollama, question: str, options: list[str], settings: dict) -> str | None:
    """Use AI to pick the best option from a list."""
    if not options:
        return None
    try:
        resume_text = settings.get("_resume_text", "")
        ctx = (f"Question: {question}\nOptions: {', '.join(options)}\n\n"
               f"Pick the single best option. Reply with ONLY the option text.\n\n"
               f"Applicant context:\n{resume_text[:3000]}")
        answer = _run_async(ollama.answer_question(question, ctx)).strip()
        for opt in options:
            if opt.lower() == answer.lower() or answer.lower() in opt.lower() or opt.lower() in answer.lower():
                return opt
    except Exception as e:
        logger.warning("AI option pick failed for '%s': %s", question, e)
    return None


def _ai_answer_text(ollama, question: str, settings: dict) -> str | None:
    """Use AI to generate a free-text answer."""
    try:
        resume_text = settings.get("_resume_text", "")
        answer = _run_async(ollama.answer_question(question, resume_text[:3000])).strip()
        return answer if answer else None
    except Exception as e:
        logger.warning("AI text answer failed for '%s': %s", question, e)
    return None
