"""
Smart Form Filler — reads form fields, fills from profile data or AI.

For known fields (name, email, phone, address): fills from user profile.
For custom questions: sends to Ollama/Llama to generate answers from resume.
"""

import time
import json
import logging
import urllib.request

logger = logging.getLogger(__name__)

# User profile — will be loaded from settings
DEFAULT_PROFILE = {
    "first_name": "Fahad",
    "last_name": "Aba-Alkhail",
    "email": "fahadabraar@gmail.com",
    "phone": "6133168025",
    "phone_country_code": "Canada (+1)",
    "address": "123 Main Street",
    "city": "Ottawa",
    "state": "Ontario",
    "postal": "K1A 0A6",
    "country": "Canada",
    "linkedin_url": "",
    "website": "",
}

# Field label → profile key mapping (case-insensitive matching)
FIELD_MAP = {
    "first name": "first_name",
    "last name": "last_name",
    "full name": lambda p: f"{p['first_name']} {p['last_name']}",
    "name": lambda p: f"{p['first_name']} {p['last_name']}",
    "email address": "email",
    "e-mail address": "email",
    "email": "email",
    "e-mail": "email",
    "phone": "phone",
    "mobile phone": "phone",
    "mobile phone number": "phone",
    "phone number": "phone",
    "phone country code": "phone_country_code",
    "street address": "address",
    "address": "address",
    "city": "city",
    "state": "state",
    "province": "state",
    "state/province": "state",
    "postal": "postal",
    "postal code": "postal",
    "zip": "postal",
    "zip code": "postal",
    "country": "country",
    "linkedin": "linkedin_url",
    "linkedin url": "linkedin_url",
    "linkedin profile": "linkedin_url",
    "website": "website",
    "portfolio": "website",
}


def get_profile_value(label: str, profile: dict) -> str | None:
    """Match a form field label to a profile value.
    
    Prefers exact matches, then longer key matches to avoid
    'address' matching 'email address' before 'address'.
    """
    label_lower = label.lower().strip().rstrip("*").strip()
    
    # Pass 1: exact match
    for key, val in FIELD_MAP.items():
        if key == label_lower:
            if callable(val):
                return val(profile)
            return profile.get(val, "")
    
    # Pass 2: key in label (longer keys first to prefer specific matches)
    sorted_keys = sorted(FIELD_MAP.keys(), key=len, reverse=True)
    for key in sorted_keys:
        if key in label_lower:
            val = FIELD_MAP[key]
            if callable(val):
                return val(profile)
            return profile.get(val, "")
    
    # Pass 3: label in key (for partial labels like "zip" matching "zip code")
    for key in sorted_keys:
        if label_lower in key:
            val = FIELD_MAP[key]
            if callable(val):
                return val(profile)
            return profile.get(val, "")
    
    return None


def ask_ollama(question: str, resume_text: str, job_description: str = "") -> str:
    """Ask Ollama/Llama to answer a custom application question using the resume."""
    prompt = f"""You are filling out a job application. Answer the following question concisely and professionally.
Use information from the resume below. If the resume doesn't have the answer, give a reasonable professional response.
Keep answers brief — 1-3 sentences max for text fields, single word/phrase for simple questions.

Resume:
{resume_text[:3000]}

{f"Job Description: {job_description[:1000]}" if job_description else ""}

Question: {question}

Answer (be concise):"""

    try:
        data = json.dumps({
            "model": "llama3.2",
            "prompt": prompt,
            "stream": False,
        }).encode()
        req = urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read().decode())
        answer = result.get("response", "").strip()
        # Clean up — remove quotes, extra whitespace
        answer = answer.strip('"\'').strip()
        return answer
    except Exception as e:
        logger.warning("Ollama error: %s", e)
        return ""


# JavaScript to extract all form fields from the current page/iframe
# Scoped to the Easy Apply modal when present, falls back to full page
EXTRACT_FIELDS_JS = """
    const fields = [];

    // Scope to the Easy Apply modal if it exists, otherwise full document
    const modal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal, [role="dialog"], .jobs-easy-apply-content');
    const root = modal || document;

    // Text inputs, email, tel, number
    root.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type])').forEach(inp => {
        // Use getBoundingClientRect instead of offsetParent for modal elements
        const rect = inp.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const label = _getLabel(inp);
        fields.push({
            type: 'input',
            inputType: inp.type || 'text',
            label: label,
            value: inp.value,
            id: inp.id,
            name: inp.name,
            required: inp.required || inp.getAttribute('aria-required') === 'true',
        });
    });

    // Textareas
    root.querySelectorAll('textarea').forEach(ta => {
        const rect = ta.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const label = _getLabel(ta);
        fields.push({
            type: 'textarea',
            label: label,
            value: ta.value,
            id: ta.id,
            name: ta.name,
            required: ta.required,
        });
    });

    // Selects
    root.querySelectorAll('select').forEach(sel => {
        const rect = sel.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const label = _getLabel(sel);
        const options = Array.from(sel.options).map(o => o.text.trim()).filter(t => t);
        fields.push({
            type: 'select',
            label: label,
            value: sel.value,
            options: options,
            id: sel.id,
            name: sel.name,
            required: sel.required,
        });
    });

    // Radio groups
    const radioGroups = {};
    root.querySelectorAll('input[type="radio"]').forEach(r => {
        const rect = r.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const name = r.name;
        if (!radioGroups[name]) {
            radioGroups[name] = {options: [], checked: null, label: ''};
            const fieldset = r.closest('fieldset');
            if (fieldset) {
                const legend = fieldset.querySelector('legend');
                if (legend) radioGroups[name].label = legend.textContent.trim();
            }
            if (!radioGroups[name].label) {
                radioGroups[name].label = _getLabel(r);
            }
        }
        const rLabel = document.querySelector('label[for="' + r.id + '"]');
        radioGroups[name].options.push(rLabel ? rLabel.textContent.trim() : r.value);
        if (r.checked) radioGroups[name].checked = r.value;
    });
    for (const [name, group] of Object.entries(radioGroups)) {
        fields.push({
            type: 'radio',
            label: group.label,
            options: group.options,
            value: group.checked,
            name: name,
        });
    }

    // Checkboxes (LinkedIn uses these for "I agree" type fields)
    root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const label = _getLabel(cb);
        if (label) {
            fields.push({
                type: 'checkbox',
                label: label,
                value: cb.checked ? 'true' : '',
                id: cb.id,
                name: cb.name,
            });
        }
    });

    // File upload inputs
    root.querySelectorAll('input[type="file"]').forEach(fi => {
        const label = _getLabel(fi);
        fields.push({
            type: 'file',
            label: label || 'Resume upload',
            value: fi.value,
            id: fi.id,
            name: fi.name,
        });
    });

    function _getLabel(el) {
        // By for attribute
        if (el.id) {
            const lbl = document.querySelector('label[for="' + el.id + '"]');
            if (lbl) return lbl.textContent.trim();
        }
        // By aria-label
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        // By aria-labelledby
        if (el.getAttribute('aria-labelledby')) {
            const lblEl = document.getElementById(el.getAttribute('aria-labelledby'));
            if (lblEl) return lblEl.textContent.trim();
        }
        // By placeholder
        if (el.placeholder) return el.placeholder;
        // By parent label
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim();
        // By closest form group div with a label/span child
        const formGroup = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping, [data-test-form-element]');
        if (formGroup) {
            const lbl = formGroup.querySelector('label, span.fb-dash-form-element__label, .artdeco-text-input--label');
            if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
        }
        // By preceding sibling or nearby text
        const prev = el.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
            return prev.textContent.trim();
        }
        return '';
    }

    return JSON.stringify(fields);
"""


def fill_form_fields(driver, profile: dict, resume_text: str = "", job_desc: str = "", prefilled: dict = None):
    """
    Extract all form fields, fill them intelligently.
    IMPORTANT: Assumes driver is already switched into the correct context (iframe or main page).
    Does NOT switch iframes — caller is responsible for that.
    Returns list of fields that couldn't be filled.
    """
    prefilled = prefilled or {}
    unfilled = []

    # Extract fields via JavaScript
    fields_json = driver.execute_script(EXTRACT_FIELDS_JS)
    fields = json.loads(fields_json)

    print(f"📝 Found {len(fields)} form fields")

    for field in fields:
        label = field.get("label", "")
        ftype = field.get("type", "")
        value = field.get("value", "")
        field_id = field.get("id", "")
        field_name = field.get("name", "")

        if not label:
            continue

        # Skip already filled fields
        if value and value.strip():
            print(f"   ✓ '{label}' already filled: {value[:30]}")
            continue

        # 1) Try profile mapping
        profile_val = get_profile_value(label, profile)
        if profile_val:
            _fill_field(driver, field, profile_val)
            print(f"   ✓ '{label}' → profile: {profile_val[:30]}")
            continue

        # 2) Try prefilled answers
        matched = _match_prefilled(label, prefilled)
        if matched:
            _fill_field(driver, field, matched)
            print(f"   ✓ '{label}' → prefilled: {matched[:30]}")
            continue

        # 3) Try AI (Ollama) for custom questions
        if resume_text and ftype in ("input", "textarea"):
            ai_answer = ask_ollama(label, resume_text, job_desc)
            if ai_answer:
                _fill_field(driver, field, ai_answer)
                print(f"   🤖 '{label}' → AI: {ai_answer[:50]}")
                continue

        # 4) For selects/radios, try to pick the best option with AI
        if ftype in ("select", "radio") and field.get("options"):
            options = field["options"]
            if resume_text:
                ai_answer = ask_ollama(
                    f"{label}\nOptions: {', '.join(options)}\nPick the best option.",
                    resume_text, job_desc
                )
                if ai_answer:
                    best = _find_best_option(ai_answer, options)
                    if best:
                        _select_option(driver, field, best)
                        print(f"   🤖 '{label}' → AI selected: {best}")
                        continue

        unfilled.append(field)
        print(f"   ❌ '{label}' — couldn't fill")

    return unfilled


def fill_form_fields_sendkeys(driver, profile: dict):
    """
    Robust form filler that finds all visible inputs in the CURRENT driver context
    and fills them using send_keys() for React/JazzHR compatibility.

    IMPORTANT: Assumes driver is already switched into the correct iframe.
    Does NOT switch iframes itself.

    Uses label detection (label[for], aria-label, placeholder, nearby text)
    to match inputs to profile data.
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    # Map of label keywords → profile keys
    label_to_key = {
        "address": "address",
        "street": "address",
        "city": "city",
        "state": "state",
        "province": "state",
        "postal": "postal",
        "zip": "postal",
        "phone": "phone",
        "mobile": "phone",
        "first name": "first_name",
        "last name": "last_name",
        "email": "email",
        "country": "country",
        "linkedin": "linkedin_url",
        "website": "website",
    }

    # Get label text for an input using JS (runs in current context)
    GET_LABEL_JS = """
        const inp = arguments[0];
        let label = '';
        // 1) label[for=id]
        if (inp.id) {
            const lbl = document.querySelector('label[for="' + inp.id + '"]');
            if (lbl) label = lbl.textContent.trim();
        }
        // 2) aria-label
        if (!label && inp.getAttribute('aria-label')) label = inp.getAttribute('aria-label');
        // 3) placeholder
        if (!label && inp.placeholder) label = inp.placeholder;
        // 4) parent label element
        if (!label) {
            const parentLabel = inp.closest('label');
            if (parentLabel) label = parentLabel.textContent.trim();
        }
        // 5) preceding sibling (label, span, div)
        if (!label) {
            const prev = inp.previousElementSibling;
            if (prev && ['LABEL','SPAN','DIV'].includes(prev.tagName)) {
                label = prev.textContent.trim();
            }
        }
        // 6) parent's label/span child (but not the input itself)
        if (!label) {
            const parent = inp.parentElement;
            if (parent) {
                const lbl = parent.querySelector('label, span.label, span');
                if (lbl && lbl !== inp) label = lbl.textContent.trim();
            }
        }
        // 7) aria-labelledby
        if (!label && inp.getAttribute('aria-labelledby')) {
            const lblEl = document.getElementById(inp.getAttribute('aria-labelledby'));
            if (lblEl) label = lblEl.textContent.trim();
        }
        return label;
    """

    # Find all visible input/textarea elements in current context
    inputs = driver.find_elements(By.CSS_SELECTOR, "input, textarea")
    filled_count = 0

    for inp in inputs:
        try:
            # Skip hidden, disabled, or already-filled inputs
            if not inp.is_displayed():
                continue
            input_type = (inp.get_attribute("type") or "text").lower()
            if input_type in ("hidden", "submit", "button", "checkbox", "radio", "file"):
                continue
            current_val = inp.get_attribute("value") or ""
            if current_val.strip():
                continue

            # Get the label for this input
            label_text = driver.execute_script(GET_LABEL_JS, inp)
            if not label_text:
                continue

            label_lower = label_text.lower().strip().rstrip("*").strip()
            print(f"   🔎 Found empty field: '{label_text}'")

            # Match label to profile data
            matched_value = None
            for keyword, profile_key in label_to_key.items():
                if keyword in label_lower or label_lower in keyword:
                    matched_value = profile.get(profile_key, "")
                    break

            if not matched_value:
                # Also try the generic get_profile_value
                matched_value = get_profile_value(label_text, profile)

            if matched_value:
                inp.click()
                time.sleep(0.2)
                inp.clear()
                time.sleep(0.1)
                inp.send_keys(matched_value)
                time.sleep(0.3)
                inp.send_keys(Keys.TAB)
                time.sleep(0.2)
                filled_count += 1
                print(f"   ✅ Filled '{label_text}' → '{matched_value}'")
            else:
                print(f"   ⚠️  No profile match for '{label_text}'")

        except Exception as e:
            logger.debug("Error filling input: %s", e)
            continue

    print(f"📝 Filled {filled_count} fields via send_keys")
    return filled_count


def _fill_field(driver, field: dict, value: str):
    """Fill a form field by simulating real keyboard input."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    ftype = field.get("type", "")
    field_id = field.get("id", "")
    field_name = field.get("name", "")

    if ftype in ("input", "textarea"):
        el = None
        try:
            if field_id:
                el = driver.find_element(By.ID, field_id)
            elif field_name:
                el = driver.find_element(By.NAME, field_name)
        except Exception:
            pass

        if el:
            try:
                el.click()
                time.sleep(0.2)
                el.clear()
                time.sleep(0.1)
                # Type character by character for React compatibility
                el.send_keys(value)
                time.sleep(0.5)

                # Handle LinkedIn typeahead/autocomplete dropdowns
                # These appear for City, State, Postal fields
                _try_select_typeahead(driver, el, value)

                # Tab out to trigger validation
                el.send_keys(Keys.TAB)
                time.sleep(0.2)
            except Exception as e:
                # Fallback to JavaScript
                driver.execute_script("""
                    const el = arguments[0];
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(el, arguments[1]);
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                """, el, value)

    elif ftype == "select":
        _select_option(driver, field, value)


def _try_select_typeahead(driver, element, value):
    """Handle LinkedIn's typeahead/autocomplete dropdowns.
    
    After typing a value, LinkedIn shows a dropdown list. We need to
    click the first matching option to make the value stick.
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    try:
        time.sleep(0.8)  # Wait for dropdown to appear

        # LinkedIn typeahead uses various selectors for the dropdown
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
                    # Click the first visible option
                    for opt in options:
                        if opt.is_displayed():
                            opt_text = opt.text.strip()
                            if opt_text:
                                opt.click()
                                logger.info("Selected typeahead option: %s", opt_text[:50])
                                print(f"      ↳ Selected typeahead: '{opt_text[:50]}'")
                                time.sleep(0.3)
                                return
            except Exception:
                continue

        # Fallback: try pressing Down arrow + Enter to select first option
        try:
            element.send_keys(Keys.ARROW_DOWN)
            time.sleep(0.3)
            element.send_keys(Keys.ENTER)
            time.sleep(0.3)
        except Exception:
            pass

    except Exception as e:
        logger.debug("Typeahead selection failed: %s", e)


def _select_option(driver, field: dict, value: str):
    """Select an option in a dropdown or radio group."""
    ftype = field.get("type", "")
    field_id = field.get("id", "")
    field_name = field.get("name", "")

    if ftype == "select":
        selector = ""
        if field_id:
            selector = f'#{field_id}'
        elif field_name:
            selector = f'select[name="{field_name}"]'
        if selector:
            driver.execute_script(f"""
                const sel = document.querySelector('{selector}');
                if (sel) {{
                    const options = Array.from(sel.options);
                    const match = options.find(o => o.text.trim().toLowerCase().includes(arguments[0].toLowerCase()));
                    if (match) {{
                        sel.value = match.value;
                        sel.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }}
                }}
            """, value)
            time.sleep(0.3)

    elif ftype == "radio":
        driver.execute_script(f"""
            const radios = document.querySelectorAll('input[name="{field_name}"]');
            for (const r of radios) {{
                const label = document.querySelector('label[for="' + r.id + '"]');
                const txt = label ? label.textContent.trim() : r.value;
                if (txt.toLowerCase().includes(arguments[0].toLowerCase())) {{
                    r.click();
                    break;
                }}
            }}
        """, value)
        time.sleep(0.3)


def _match_prefilled(label: str, prefilled: dict) -> str | None:
    """Fuzzy match a field label against prefilled answers."""
    if not label or not prefilled:
        return None
    label_lower = label.lower().strip()
    for question, answer in prefilled.items():
        if question.lower().strip() in label_lower or label_lower in question.lower().strip():
            return str(answer)
    return None


def _find_best_option(ai_answer: str, options: list) -> str | None:
    """Find the best matching option from AI's answer."""
    ai_lower = ai_answer.lower().strip()
    for opt in options:
        if opt.lower().strip() in ai_lower or ai_lower in opt.lower().strip():
            return opt
    # Partial match
    for opt in options:
        words = ai_lower.split()
        for word in words:
            if len(word) > 3 and word in opt.lower():
                return opt
    return options[0] if options else None
