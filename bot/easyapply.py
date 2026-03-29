"""
Test: Full Easy Apply flow using local Chrome.
Logs in, navigates to a job, clicks Apply, fills the form.
"""
import os
import time
import random
import pickle
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium_stealth import stealth

# --- Config ---
LINKEDIN_EMAIL = ""  # Leave empty to log in manually
LINKEDIN_PASSWORD = ""
JOB_URL = "https://www.linkedin.com/jobs/view/4364166843/"
COOKIES_PATH = "data/cookies_local.pkl"
DRY_RUN = True  # Set False to actually submit

# --- Browser Setup ---
def create_driver():
    options = Options()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-extensions")
    options.add_argument("--window-size=1280,900")
    options.add_experimental_option("useAutomationExtension", False)
    options.add_experimental_option("excludeSwitches", ["enable-automation"])

    driver = webdriver.Chrome(options=options)
    stealth(driver,
        languages=["en-US", "en"],
        vendor="Google Inc.",
        platform="Win32",
        webgl_vendor="Intel Inc.",
        renderer="Intel Iris OpenGL Engine",
        fix_hairline=True)
    return driver

# --- Cookie Management ---
def save_cookies(driver):
    os.makedirs(os.path.dirname(COOKIES_PATH), exist_ok=True)
    with open(COOKIES_PATH, "wb") as f:
        pickle.dump(driver.get_cookies(), f)
    print("💾 Cookies saved")

def load_cookies(driver):
    if not os.path.exists(COOKIES_PATH):
        return False
    try:
        with open(COOKIES_PATH, "rb") as f:
            cookies = pickle.load(f)
        driver.delete_all_cookies()
        for c in cookies:
            try:
                driver.add_cookie(c)
            except Exception:
                pass
        print(f"🍪 Loaded {len(cookies)} cookies")
        return True
    except Exception:
        return False

# --- Login ---
def ensure_logged_in(driver):
    driver.get("https://www.linkedin.com")
    time.sleep(2)

    # Try cookies first
    if load_cookies(driver):
        driver.get("https://www.linkedin.com/feed")
        time.sleep(3)
        if "/feed" in driver.current_url:
            print("✅ Logged in via cookies!")
            return True

    # Try credentials
    if LINKEDIN_EMAIL and LINKEDIN_PASSWORD:
        driver.get("https://www.linkedin.com/login")
        time.sleep(2)
        try:
            driver.find_element(By.ID, "username").send_keys(LINKEDIN_EMAIL)
            time.sleep(1)
            driver.find_element(By.ID, "password").send_keys(LINKEDIN_PASSWORD)
            time.sleep(1)
            driver.find_element(By.XPATH, '//button[@type="submit"]').click()
            print("⏳ Submitted credentials, waiting 30s for 2FA...")
            time.sleep(30)
        except Exception as e:
            print(f"Login form error: {e}")

    # Manual login fallback
    if "/feed" not in driver.current_url:
        print("⚠️  Please log in manually in the browser window...")
        for i in range(120):
            time.sleep(1)
            if "/feed" in driver.current_url:
                break
        else:
            print("❌ Login timeout")
            return False

    print("✅ Logged in!")
    save_cookies(driver)
    return True

# --- Easy Apply ---
def find_easy_apply_button(driver):
    """Find the Easy Apply button — LinkedIn uses obfuscated class names,
    so we find it by text content and the LinkedIn SVG icon."""
    # Method 1: Find span with "Apply" text and look for its parent button
    try:
        spans = driver.find_elements(By.XPATH, "//span[text()='Apply']")
        for span in spans:
            # Walk up to find the button ancestor
            parent = span
            for _ in range(5):
                parent = parent.find_element(By.XPATH, "..")
                if parent.tag_name == "button" and parent.is_displayed():
                    return parent
    except Exception:
        pass

    # Method 2: Find button containing "Easy Apply" text
    try:
        spans = driver.find_elements(By.XPATH, "//span[text()='Easy Apply']")
        for span in spans:
            parent = span
            for _ in range(5):
                parent = parent.find_element(By.XPATH, "..")
                if parent.tag_name == "button" and parent.is_displayed():
                    return parent
    except Exception:
        pass

    # Method 3: Old selectors (fallback)
    try:
        btn = driver.find_element(By.XPATH,
            "//div[contains(@class,'jobs-apply-button--top-card')]"
            "//button[contains(@class, 'jobs-apply-button')]")
        if btn.is_displayed():
            return btn
    except Exception:
        pass

    # Method 4: Any visible button with Apply in its text
    for btn in driver.find_elements(By.TAG_NAME, "button"):
        try:
            txt = btn.text.strip()
            if txt in ("Apply", "Easy Apply"):
                # Try to scroll to it
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", btn)
                time.sleep(0.5)
                if btn.is_displayed():
                    return btn
        except Exception:
            pass

    return None


def choose_resume(driver):
    """Select resume if prompted (from EasyApplyJobsBot)."""
    try:
        driver.find_element(By.CLASS_NAME, "jobs-document-upload__title--is-required")
        resumes = driver.find_elements(By.XPATH,
            "//div[contains(@class, 'ui-attachment--pdf')]")
        if resumes:
            for r in resumes:
                if r.get_attribute("aria-label") == "Select this resume":
                    r.click()
                    print("📄 Selected resume")
                    time.sleep(1)
                    break
    except Exception:
        pass


def fill_phone(driver):
    """Fill phone number if field exists and is empty."""
    try:
        for inp in driver.find_elements(By.CSS_SELECTOR, "input[type='tel']"):
            if inp.is_displayed() and not inp.get_attribute("value"):
                inp.send_keys("6136316025")  # Your phone
                print("📱 Filled phone number")
                time.sleep(0.5)
                break
    except Exception:
        pass


FORM_BUTTON_JS = """
    function findButtonByText(texts) {
        // Check all buttons directly (handles both regular DOM and iframe context)
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
            const txt = btn.textContent.trim();
            for (const t of texts) {
                if (txt === t || txt.includes(t)) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return {text: t, found: true, el: btn};
                    }
                }
            }
        }
        // Also check spans walking up to parent button
        const allSpans = document.querySelectorAll('span');
        for (const span of allSpans) {
            const txt = span.textContent.trim();
            if (texts.includes(txt)) {
                let el = span;
                for (let i = 0; i < 10; i++) {
                    el = el.parentElement;
                    if (!el) break;
                    if (el.tagName === 'BUTTON') {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return {text: txt, found: true, el: el};
                        }
                    }
                }
            }
        }
        // Also check input[type=submit] and a tags styled as buttons
        const inputs = document.querySelectorAll('input[type="submit"], input[type="button"], a[role="button"], a.btn');
        for (const el of inputs) {
            const txt = (el.value || el.textContent || '').trim();
            for (const t of texts) {
                if (txt === t || txt.includes(t)) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return {text: t, found: true, el: el};
                    }
                }
            }
        }
        return {found: false};
    }

    // Try Submit first
    let r = findButtonByText(['Submit application', 'Submit']);
    if (r.found) { r.el.click(); return 'submit:' + r.text; }

    // Try Review
    r = findButtonByText(['Review', 'Review your application']);
    if (r.found) { r.el.click(); return 'review:' + r.text; }

    // Try Next
    r = findButtonByText(['Next', 'Continue']);
    if (r.found) { r.el.click(); return 'next:' + r.text; }

    return 'none';
"""

DEEP_FIND_JS = """
    function deepFind(root, texts) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;
            if (el.shadowRoot) {
                const found = deepFind(el.shadowRoot, texts);
                if (found) return found;
            }
            const txt = el.textContent.trim();
            for (const t of texts) {
                if (txt === t && (el.tagName === 'BUTTON' || el.tagName === 'SPAN' || el.tagName === 'A' || el.tagName === 'INPUT')) {
                    return el;
                }
            }
        }
        return null;
    }
    const texts = ['Next', 'Submit', 'Review', 'Continue', 'Submit application'];
    const el = deepFind(document, texts);
    if (el) { el.click(); return 'deep:' + el.textContent.trim(); }
    return 'none';
"""


def _try_find_button_in_iframes(driver):
    """Try switching into each iframe and look for form buttons.
    Returns (result_string, switched_to_iframe) or (None, False) if not found."""
    driver.switch_to.default_content()
    iframes = driver.find_elements(By.TAG_NAME, "iframe")
    print(f"🔍 Found {len(iframes)} iframes, checking each...")
    for idx, iframe in enumerate(iframes):
        try:
            if not iframe.is_displayed():
                continue
            src = iframe.get_attribute("src") or "(no src)"
            driver.switch_to.default_content()
            driver.switch_to.frame(iframe)
            # Check if this iframe has any form buttons
            result = driver.execute_script(FORM_BUTTON_JS)
            if result != "none":
                print(f"✅ Found button in iframe #{idx}: {src[:80]}")
                return result, True
            # Also list what buttons exist in this iframe for debugging
            btns = driver.execute_script("""
                const found = [];
                document.querySelectorAll('button, input[type="submit"], a[role="button"]').forEach(b => {
                    const txt = (b.textContent || b.value || '').trim();
                    if (txt.length > 0 && txt.length < 50) found.push(txt);
                });
                return found;
            """)
            if btns:
                print(f"   iframe #{idx} buttons: {btns}")
        except Exception as e:
            print(f"   iframe #{idx} error: {e}")
    driver.switch_to.default_content()
    return None, False


def do_easy_apply(driver, already_in_iframe=False):
    """Handle the multi-step Easy Apply form using JavaScript to find buttons.
    Searches the current context, all iframes, and shadow DOM."""
    for step in range(10):
        time.sleep(random.uniform(2, 3))

        choose_resume(driver)

        # Smart form filler — try all iframes to find the form
        from smart_form_filler import fill_form_fields, DEFAULT_PROFILE

        # Try to fill in every iframe context
        driver.switch_to.default_content()
        filled_any = False

        # First try main page
        try:
            unfilled = fill_form_fields(driver, DEFAULT_PROFILE)
            if unfilled is not None and len(unfilled) < 10:
                filled_any = True
        except Exception:
            pass

        # Then try each iframe
        if not filled_any:
            iframes = driver.find_elements(By.TAG_NAME, "iframe")
            for idx, iframe in enumerate(iframes):
                try:
                    driver.switch_to.default_content()
                    driver.switch_to.frame(iframe)
                    unfilled = fill_form_fields(driver, DEFAULT_PROFILE)
                    print(f"   📋 iframe #{idx}: filled fields")
                    filled_any = True

                    # Also check nested iframes
                    nested = driver.find_elements(By.TAG_NAME, "iframe")
                    for nidx, niframe in enumerate(nested):
                        try:
                            driver.switch_to.frame(niframe)
                            unfilled2 = fill_form_fields(driver, DEFAULT_PROFILE)
                            print(f"   📋 nested iframe #{nidx}: filled fields")
                            driver.switch_to.parent_frame()
                        except Exception:
                            try:
                                driver.switch_to.parent_frame()
                            except Exception:
                                pass
                except Exception as e:
                    pass

        driver.switch_to.default_content()

        # 1) Try finding buttons in current context (main page or already-switched iframe)
        result = driver.execute_script(FORM_BUTTON_JS)

        # 2) If not found and we're in main content, try each iframe
        if result == "none" and not already_in_iframe:
            iframe_result, switched = _try_find_button_in_iframes(driver)
            if iframe_result:
                result = iframe_result
                already_in_iframe = switched

        # 3) If still not found, try deep search through shadow DOM
        if result == "none":
            if already_in_iframe:
                driver.switch_to.default_content()
                already_in_iframe = False
            try:
                result = driver.execute_script(DEEP_FIND_JS)
            except Exception as e:
                print(f"   Shadow DOM search error: {e}")

        if result.startswith("submit"):
            if DRY_RUN:
                print(f"🧪 DRY RUN — would click '{result.split(':')[1]}'")
                if already_in_iframe:
                    driver.switch_to.default_content()
                return "dry_run"
            print(f"🎉 Clicked '{result.split(':')[1]}' — Application submitted!")
            time.sleep(3)
            if already_in_iframe:
                driver.switch_to.default_content()
            return "done"
        elif result.startswith("review") or result.startswith("deep:Review"):
            print(f"📋 Step {step + 1}: Clicked '{result.split(':')[1]}'")
            continue
        elif result.startswith("next") or result.startswith("deep:"):
            print(f"➡️  Step {step + 1}: Clicked '{result.split(':')[1]}'")
            continue
        else:
            # Debug: list all visible button texts in current context
            btns = driver.execute_script("""
                const found = [];
                document.querySelectorAll('button').forEach(b => {
                    if (b.offsetParent !== null && b.textContent.trim().length < 30) {
                        found.push(b.textContent.trim());
                    }
                });
                return found;
            """)
            print(f"❓ No next/submit found. Visible buttons: {btns}")
            if already_in_iframe:
                driver.switch_to.default_content()
            return "stuck"

    if already_in_iframe:
        driver.switch_to.default_content()
    return "failed"


# --- Main ---
def main():
    print("🚀 Starting Easy Apply Bot (Local Chrome)\n")

    driver = create_driver()

    try:
        if not ensure_logged_in(driver):
            return

        print(f"\n📌 Navigating to job: {JOB_URL}")
        driver.get(JOB_URL)
        time.sleep(random.uniform(5, 8))

        # Scroll to top to ensure Apply button is visible
        driver.execute_script("window.scrollTo(0, 0)")
        time.sleep(2)

        print(f"📄 Page: {driver.current_url}")
        print(f"📄 Source length: {len(driver.page_source)}")

        # Check if 'apply-button' class exists in source
        if 'apply-button' in driver.page_source:
            print("✅ 'apply-button' found in page source!")

        # Find Apply button — check ALL elements, not just visible ones
        btn = find_easy_apply_button(driver)

        if not btn:
            # Try scrolling and using JavaScript to find it
            print("🔍 Trying JavaScript to find Apply button...")
            try:
                btn_el = driver.execute_script("""
                    // Find any element with text 'Apply' that looks like a button
                    const spans = document.querySelectorAll('span');
                    for (const span of spans) {
                        if (span.textContent.trim() === 'Apply') {
                            let el = span;
                            for (let i = 0; i < 10; i++) {
                                el = el.parentElement;
                                if (!el) break;
                                if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.role === 'button') {
                                    el.scrollIntoView({block: 'center'});
                                    return el;
                                }
                            }
                        }
                    }
                    return null;
                """)
                if btn_el:
                    btn = btn_el
                    print("✅ Found Apply button via JavaScript!")
                    time.sleep(1)
            except Exception as e:
                print(f"JS search error: {e}")

        if btn:
            print(f"✅ Apply button found! Clicking...")
            driver.execute_script("arguments[0].click();", btn)
            print("🖱️  Clicked Apply!")
            time.sleep(random.uniform(4, 6))

            # Take a debug screenshot after clicking Apply
            driver.save_screenshot("data/test_after_apply_click.png")

            # Try to find the form — could be in an iframe, shadow DOM, or regular DOM.
            # First, try all iframes (the JazzHR modal is typically in one)
            iframe_result, switched = _try_find_button_in_iframes(driver)
            if iframe_result:
                print(f"✅ Found form in iframe! Starting form fill...")
                # We're already in the right iframe, continue from here
                result = do_easy_apply(driver, already_in_iframe=True)
            else:
                # Not in an iframe — try main page (LinkedIn native Easy Apply)
                # or shadow DOM (some ATS embed via web components)
                print("📋 No form found in iframes, trying main page + shadow DOM...")
                driver.switch_to.default_content()
                result = do_easy_apply(driver, already_in_iframe=False)

            print(f"\n📊 Result: {result}")
        else:
            print("❌ No Apply button found")
            driver.save_screenshot("data/no_apply_button.png")

        input("\nPress Enter to close...")

    finally:
        driver.quit()


if __name__ == "__main__":
    main()
