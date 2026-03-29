"""
Persistent browser session using Selenium with stealth options.
Based on the proven EasyApplyJobsBot approach.

Cookie persistence via pickle — saves/loads between sessions.
2FA relay: when LinkedIn presents a checkpoint/challenge, a PendingQuestion
with job_id=0 is created so the Dashboard can prompt the user for the code.
"""

import os
import time
import random
import pickle
import hashlib
import logging
import threading
import datetime

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service

try:
    from selenium_stealth import stealth
    STEALTH_AVAILABLE = True
except ImportError:
    STEALTH_AVAILABLE = False

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_instance = None


def chrome_options():
    """Chrome options with anti-detection, matching EasyApplyJobsBot."""
    options = webdriver.ChromeOptions()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-blink-features")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--window-size=1280,800")
    options.add_argument("--lang=en-US")
    options.add_experimental_option("useAutomationExtension", False)
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    return options


class BrowserSession:
    """Singleton browser session with cookie persistence."""

    def __init__(self):
        self._driver = None
        self._logged_in = False

    @classmethod
    def get(cls) -> "BrowserSession":
        global _instance
        with _lock:
            if _instance is None:
                _instance = cls()
            return _instance

    @property
    def driver(self):
        if self._driver is None:
            self._launch()
        return self._driver

    @property
    def is_logged_in(self) -> bool:
        return self._logged_in

    def _launch(self) -> None:
        logger.info("Launching Chrome session...")
        options = chrome_options()

        # Try to find Chrome/Chromium binary (local macOS first, then Docker paths)
        local_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        docker_paths = [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
        ]
        for binary in local_paths + docker_paths:
            if os.path.exists(binary):
                options.binary_location = binary
                break

        # Try to find chromedriver (local first, then Docker paths)
        driver_path = None
        for dp in ["/usr/local/bin/chromedriver", "/opt/homebrew/bin/chromedriver",
                    "/usr/bin/chromedriver", "/usr/lib/chromium/chromedriver"]:
            if os.path.exists(dp):
                driver_path = dp
                break

        if driver_path:
            self._driver = webdriver.Chrome(service=Service(driver_path), options=options)
        else:
            self._driver = webdriver.Chrome(options=options)

        # Apply stealth
        if STEALTH_AVAILABLE:
            try:
                stealth(self._driver,
                    languages=["en-US", "en"],
                    vendor="Google Inc.",
                    platform="Win32",
                    webgl_vendor="Intel Inc.",
                    renderer="Intel Iris OpenGL Engine",
                    fix_hairline=True)
                logger.info("Stealth mode applied")
            except Exception as e:
                logger.info("Could not apply stealth: %s", e)

        self._logged_in = False
        logger.info("Chrome session launched")

    def _cookies_path(self, email: str) -> str:
        h = hashlib.md5(email.encode("utf-8")).hexdigest()
        os.makedirs("data/cookies", exist_ok=True)
        return f"data/cookies/{h}.pkl"

    def _load_cookies(self, email: str) -> None:
        path = self._cookies_path(email)
        if os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    cookies = pickle.load(f)
                self.driver.delete_all_cookies()
                for cookie in cookies:
                    try:
                        self.driver.add_cookie(cookie)
                    except Exception:
                        pass
                logger.info("Loaded %d cookies from disk", len(cookies))
            except Exception as e:
                logger.info("Could not load cookies: %s", e)

    def _save_cookies(self, email: str) -> None:
        path = self._cookies_path(email)
        try:
            with open(path, "wb") as f:
                pickle.dump(self.driver.get_cookies(), f)
            logger.info("Saved cookies to disk")
        except Exception as e:
            logger.info("Could not save cookies: %s", e)

    def _is_logged_in(self) -> bool:
        try:
            self.driver.get("https://www.linkedin.com/feed")
            time.sleep(3)
            return "/feed" in self.driver.current_url
        except Exception:
            return False

    def ensure_logged_in(self, settings: dict) -> None:
        if self._logged_in and self._is_logged_in():
            logger.info("Session still valid")
            return
        self._logged_in = False
        self._do_login(settings)

    def _do_login(self, settings: dict) -> None:
        d = self.driver
        email = settings.get("linkedin_email", "")

        # Step 1: Try saved cookies
        d.get("https://www.linkedin.com")
        time.sleep(2)
        self._load_cookies(email)
        d.get("https://www.linkedin.com/feed")
        time.sleep(3)
        if "/feed" in d.current_url:
            logger.info("Cookie login successful!")
            self._logged_in = True
            return

        # Step 2: Try li_at cookie from settings
        li_at = settings.get("linkedin_cookie", "").strip()
        if li_at:
            logger.info("Trying li_at cookie...")
            d.get("https://www.linkedin.com")
            time.sleep(1)
            d.add_cookie({"name": "li_at", "value": li_at, "domain": ".linkedin.com", "path": "/"})
            d.get("https://www.linkedin.com/feed")
            time.sleep(3)
            if "/feed" in d.current_url:
                logger.info("li_at cookie login successful!")
                self._save_cookies(email)
                self._logged_in = True
                return

        # Step 3: Credential login
        password = settings.get("linkedin_password", "")
        if not email or not password:
            screenshot = self.take_screenshot("login_failure")
            raise RuntimeError(
                f"LinkedIn credentials not configured. Debug screenshot: {screenshot}"
            )

        logger.info("Logging in with credentials...")
        d.get("https://www.linkedin.com/login")
        time.sleep(random.uniform(2, 4))

        if "/feed" in d.current_url:
            self._logged_in = True
            self._save_cookies(email)
            return

        try:
            d.find_element(By.ID, "username").send_keys(email)
            time.sleep(1)
            d.find_element(By.ID, "password").send_keys(password)
            time.sleep(1)
            d.find_element(By.XPATH, '//button[@type="submit"]').click()
            time.sleep(30)  # Wait for 2FA/manual approval like EasyApplyJobsBot
        except Exception as e:
            screenshot = self.take_screenshot("login_failure")
            logger.warning("Login form issue: %s (screenshot: %s)", e, screenshot)

        self._save_cookies(email)

        if "/feed" in d.current_url:
            logger.info("Login successful!")
            self._logged_in = True
            return

        if "checkpoint" in d.current_url or "challenge" in d.current_url:
            self.take_screenshot("login_2fa_challenge")
            logger.info("2FA/security challenge detected, requesting code from user...")
            self._handle_2fa_challenge(d, email)
            return

        screenshot = self.take_screenshot("login_failure")
        raise RuntimeError(
            f"Login failed. Current page: {d.current_url}. "
            f"Debug screenshot: {screenshot}"
        )

    def _handle_2fa_challenge(self, driver, email: str) -> None:
        """Create a PendingQuestion for the 2FA code and wait for the user to answer it."""
        from backend.db.database import SessionLocal
        from backend.db.models import PendingQuestion

        db = SessionLocal()
        try:
            # Clean up any stale 2FA questions from previous attempts
            db.query(PendingQuestion).filter(
                PendingQuestion.job_id == 0,
                PendingQuestion.answer.is_(None),
            ).delete()
            db.commit()

            # Create a new PendingQuestion for the verification code
            pq = PendingQuestion(
                job_id=0,
                task_id=None,
                question="LinkedIn requires a verification code. Please enter the code sent to your email or phone.",
                field_type="text",
                options=[],
                answer=None,
            )
            db.add(pq)
            db.commit()
            db.refresh(pq)
            question_id = pq.id
            logger.info("Created 2FA PendingQuestion id=%d, waiting for user input...", question_id)

            # Poll DB for the user's answer (up to 5 minutes, check every 5 seconds)
            max_wait = 300
            poll_interval = 5
            elapsed = 0
            code = None

            while elapsed < max_wait:
                time.sleep(poll_interval)
                elapsed += poll_interval
                db.expire_all()
                pq = db.query(PendingQuestion).filter(PendingQuestion.id == question_id).first()
                if pq and pq.answer:
                    code = pq.answer.strip()
                    logger.info("Received 2FA code from user")
                    break

            if not code:
                screenshot = self.take_screenshot("login_failure_2fa_timeout")
                raise RuntimeError(
                    f"2FA verification timed out — no code received within 5 minutes. "
                    f"Debug screenshot: {screenshot}"
                )

            # Find the verification input field and submit the code
            self._submit_2fa_code(driver, code)

            # Verify login succeeded
            time.sleep(5)
            if "/feed" in driver.current_url:
                logger.info("2FA login successful!")
                self._save_cookies(email)
                self._logged_in = True
                return

            # Sometimes LinkedIn redirects through an intermediate page
            driver.get("https://www.linkedin.com/feed")
            time.sleep(3)
            if "/feed" in driver.current_url:
                logger.info("2FA login successful after redirect!")
                self._save_cookies(email)
                self._logged_in = True
                return

            driver.save_screenshot("data/linkedin_2fa_failed.png")
            screenshot = self.take_screenshot("login_failure_2fa")
            raise RuntimeError(
                f"2FA code submitted but login still failed. "
                f"Debug screenshot: {screenshot}"
            )

        finally:
            db.close()

    def _submit_2fa_code(self, driver, code: str) -> None:
        """Find the verification code input on the challenge page and submit it."""
        # LinkedIn uses various input selectors for verification codes
        input_selectors = [
            (By.ID, "input__email_verification_pin"),
            (By.ID, "input__phone_verification_pin"),
            (By.NAME, "pin"),
            (By.CSS_SELECTOR, "input[name='pin']"),
            (By.CSS_SELECTOR, "input#input__email_verification_pin"),
            (By.CSS_SELECTOR, "input[type='text']"),
        ]

        code_input = None
        for by, selector in input_selectors:
            try:
                code_input = driver.find_element(by, selector)
                if code_input.is_displayed():
                    break
                code_input = None
            except Exception:
                continue

        if not code_input:
            screenshot = self.take_screenshot("login_failure_2fa_no_input")
            raise RuntimeError(
                f"Could not find verification code input field on the challenge page. "
                f"Debug screenshot: {screenshot}"
            )

        code_input.clear()
        code_input.send_keys(code)
        time.sleep(1)

        # Click the submit/verify button
        submit_selectors = [
            (By.ID, "two-step-submit-button"),
            (By.CSS_SELECTOR, "button[type='submit']"),
            (By.XPATH, "//button[contains(text(), 'Submit')]"),
            (By.XPATH, "//button[contains(text(), 'Verify')]"),
            (By.XPATH, "//button[contains(@aria-label, 'Submit')]"),
        ]

        for by, selector in submit_selectors:
            try:
                btn = driver.find_element(by, selector)
                if btn.is_displayed():
                    btn.click()
                    logger.info("Clicked 2FA submit button")
                    return
            except Exception:
                continue

        # Fallback: press Enter on the input
        from selenium.webdriver.common.keys import Keys
        code_input.send_keys(Keys.RETURN)
        logger.info("Pressed Enter to submit 2FA code (no submit button found)")

    def keep_alive(self) -> None:
        """Execute a minor JS action to prevent LinkedIn session timeout.

        Performs a small random scroll and synthetic mouse-move event.
        Intended to be called every ~5 minutes during long-running tasks.
        """
        if self._driver is None:
            return
        try:
            scroll_y = random.randint(50, 200)
            direction = random.choice([1, -1])
            self._driver.execute_script(
                f"window.scrollBy(0, {scroll_y * direction});"
            )
            # Dispatch a synthetic mousemove event at a random position
            self._driver.execute_script("""
                document.dispatchEvent(new MouseEvent('mousemove', {
                    clientX: Math.floor(Math.random() * 800) + 100,
                    clientY: Math.floor(Math.random() * 600) + 100,
                    bubbles: true
                }));
            """)
            logger.debug("keep_alive: scrolled %+d px, dispatched mousemove", scroll_y * direction)
        except Exception as e:
            logger.warning("keep_alive failed: %s", e)

    def is_session_valid(self) -> bool:
        """Quick check whether the browser is still on a logged-in LinkedIn page.

        Unlike ``_is_logged_in`` this does NOT navigate — it only inspects the
        current URL for ``/feed`` or other authenticated LinkedIn paths.
        """
        if self._driver is None:
            return False
        try:
            url = self._driver.current_url or ""
            return any(p in url for p in ["/feed", "/jobs", "/messaging", "/mynetwork", "/in/"])
        except Exception:
            return False

    def take_screenshot(self, name: str) -> str:
        """Save a screenshot to data/ with timestamp, return file path."""
        os.makedirs("data", exist_ok=True)
        ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        path = f"data/{name}_{ts}.png"
        try:
            self.driver.save_screenshot(path)
            logger.info("Screenshot saved: %s", path)
        except Exception as e:
            logger.warning("Failed to save screenshot: %s", e)
            path = ""
        return path

    def close(self) -> None:
        global _instance
        with _lock:
            if self._driver:
                try:
                    self._driver.quit()
                except Exception:
                    pass
            self._driver = None
            self._logged_in = False
            _instance = None
            logger.info("Browser session closed")
