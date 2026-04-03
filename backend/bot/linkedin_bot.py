"""
LinkedInBot — scrape via public API, apply via persistent browser session.

Scrape: uses LinkedIn's guest API (no browser needed).
Apply: reuses a single browser session across all applications.
Supports both Easy Apply and external ATS forms (Greenhouse, Lever, etc.).
"""

import os
import json
import time
import random
import re
import logging
import datetime

import httpx
from html.parser import HTMLParser
from backend.db.database import SessionLocal
from backend.db.models import (
    ScrapedJob, PendingQuestion, ApplicationRecord,
    ApplicationStatus, JobStatus, UserSettings, ResumeProfileDB,
)
from backend.services.crypto import decrypt
from backend.services.browser_pool import BrowserSession

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Human-like behaviour helpers (Req 17.3, 17.4, 17.5)
# ---------------------------------------------------------------------------

_last_keep_alive: float = 0.0  # epoch timestamp of last keep_alive call


def human_delay(lo: float = 2.0, hi: float = 8.0) -> None:
    """Sleep for a random duration between *lo* and *hi* seconds.

    Used between page navigations to mimic human browsing cadence.
    """
    time.sleep(random.uniform(lo, hi))


def smooth_scroll(driver, settings: dict | None = None) -> None:
    """Incrementally scroll the page with randomised distances and pauses.

    Only runs when ``smooth_scrolling`` is enabled in *settings*.  Falls back
    to a no-op when the setting is missing or falsy.
    """
    if not (settings or {}).get("smooth_scrolling"):
        return
    try:
        steps = random.randint(3, 7)
        for _ in range(steps):
            distance = random.randint(80, 300)
            direction = random.choice([1, -1])
            driver.execute_script(f"window.scrollBy(0, {distance * direction});")
            time.sleep(random.uniform(0.3, 1.0))
    except Exception as exc:
        logger.debug("smooth_scroll error: %s", exc)


def maybe_keep_alive(session: BrowserSession) -> None:
    """Call ``session.keep_alive()`` if ≥ 5 minutes since the last call.

    Safe to call frequently — it short-circuits when the interval hasn't
    elapsed yet.
    """
    global _last_keep_alive
    now = time.monotonic()
    if now - _last_keep_alive >= 300:
        session.keep_alive()
        _last_keep_alive = now


EXPERIENCE_LEVEL_CODES = {
    "intern": "1", "entry": "2", "mid": "3", "senior": "4",
    "director": "5", "executive": "6",
}
WORK_TYPE_CODES = {"onsite": "1", "remote": "2", "hybrid": "3"}


def _load_settings() -> dict:
    """Load user settings from DB."""
    db = SessionLocal()
    try:
        s = db.query(UserSettings).filter(UserSettings.id == 1).first()
        if s:
            # Load settings from DB - don't require linkedin_email to be set
            return {
                "linkedin_email": s.linkedin_email or "",
                "linkedin_password": decrypt(s.linkedin_password_encrypted) if s.linkedin_password_encrypted else "",
                "linkedin_cookie": decrypt(s.linkedin_cookies) if s.linkedin_cookies else "",
                "first_name": s.first_name or "",
                "last_name": s.last_name or "",
                "email": s.email or "",
                "phone": s.phone or "",
                "city": s.city or "",
                "country": getattr(s, "country", "") or "",  # For location filtering
                "linkedin_url": s.linkedin_url or "",
                "website": s.website or "",
                "job_title": s.job_title or "Software Engineer",
                "location": s.location or "Canada",  # Default to Canada instead of US
                "experience_levels": [x for x in (s.experience_levels or "").split(",") if x],
                "work_type": s.work_type or "",
                "regions": [x for x in (s.regions or "").split(",") if x],
                "resume_file_path": s.resume_file_path or "",
                "max_applications_per_run": s.max_applications_per_run or 25,
                "prefilled_answers": s.prefilled_answers or {},
                "pause_before_submit": bool(getattr(s, "pause_before_submit", 0)),
                "follow_companies": bool(getattr(s, "follow_companies", 0)),
                "company_blacklist": s.company_blacklist or [],
                "keyword_blacklist": s.keyword_blacklist or [],
                "min_salary": s.min_salary,
                "max_salary": s.max_salary,
                "min_experience_years": s.min_experience_years,
                "max_experience_years": s.max_experience_years,
                "autopilot_enabled": bool(getattr(s, "autopilot_enabled", 0)),
                "daily_apply_limit": s.daily_apply_limit or 50,
                "weekly_apply_limit": s.weekly_apply_limit or 200,
                "apply_delay_min": s.apply_delay_min or 30.0,
                "apply_delay_max": s.apply_delay_max or 120.0,
            }
    finally:
        db.close()
    # No settings in DB - return defaults
    logger.warning("No settings found in database, using defaults")
    return {
        "linkedin_email": os.getenv("LINKEDIN_EMAIL", ""),
        "linkedin_password": os.getenv("LINKEDIN_PASSWORD", ""),
        "first_name": "", "last_name": "", "email": "", "phone": "",
        "city": "", "country": "", "linkedin_url": "", "website": "",
        "job_title": "Software Engineer", "location": "Canada",  # Default to Canada
        "experience_levels": [], "work_type": "", "regions": [],
        "resume_file_path": "", "max_applications_per_run": 25,
        "prefilled_answers": {},
        "pause_before_submit": False, "follow_companies": False,
        "company_blacklist": [], "keyword_blacklist": [],
        "min_salary": None, "max_salary": None,
        "min_experience_years": None, "max_experience_years": None,
        "autopilot_enabled": False,
        "daily_apply_limit": 50, "weekly_apply_limit": 200,
        "apply_delay_min": 30.0, "apply_delay_max": 120.0,
    }


def _publish(task_id: str, msg: str):
    """Log and publish to SSE."""
    logger.info("[%s] %s", task_id, msg)
    from backend.services.task_runner import publish_log
    publish_log(task_id, msg)


# ============================================================
# SCRAPE — uses public guest API, no browser needed
# ============================================================

def scrape_jobs(task_id: str) -> None:
    """Scrape jobs using LinkedIn's public guest API."""
    settings = _load_settings()
    title = settings.get("job_title", "Software Engineer")
    regions = settings.get("regions") or [settings.get("location", "United States")]

    # Log the settings being used for debugging
    _publish(task_id, f"Using settings: job_title='{title}', regions={regions}")
    logger.info("Scrape settings: job_title=%s, location=%s, regions=%s", 
                title, settings.get("location"), regions)

    exp_param = ""
    exp_levels = settings.get("experience_levels", [])
    if exp_levels:
        codes = [EXPERIENCE_LEVEL_CODES[l] for l in exp_levels if l in EXPERIENCE_LEVEL_CODES]
        if codes:
            exp_param = "&f_E=" + ",".join(codes)

    wt_param = ""
    wt = settings.get("work_type", "")
    if wt and wt in WORK_TYPE_CODES:
        wt_param = f"&f_WT={WORK_TYPE_CODES[wt]}"

    db = SessionLocal()
    total = 0
    new_ids = []
    max_new = settings.get("max_applications_per_run", 25)

    try:
        for region in regions:
            if total >= max_new:
                break
            _publish(task_id, f"Searching: {title} in {region}...")

            url = (
                f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
                f"?keywords={title.replace(' ', '%20')}"
                f"&location={region.replace(' ', '%20')}"
                f"&f_AL=true{exp_param}{wt_param}&start=0"
            )
            try:
                # Exponential backoff on HTTP 429 (Req 21.7)
                resp = None
                for _attempt in range(3):  # initial + 2 retries
                    r = httpx.get(url, timeout=15, headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    })
                    if r.status_code == 429:
                        wait = min(2 * (2 ** _attempt), 60)
                        _publish(task_id, f"Rate-limited (429), retrying in {wait:.0f}s...")
                        time.sleep(wait)
                        continue
                    resp = r
                    break
                if resp is None or resp.status_code != 200:
                    continue

                jobs = _parse_guest_html(resp.text)
                _publish(task_id, f"Found {len(jobs)} jobs")

                for j in jobs:
                    if total >= max_new:
                        break
                    if db.query(ScrapedJob).filter(ScrapedJob.url == j["url"]).first():
                        continue
                    job = ScrapedJob(
                        title=j["title"], company=j["company"],
                        location=j["location"], url=j["url"],
                        description="", easy_apply=1,
                        company_logo=j.get("logo", ""),
                    )
                    db.add(job)
                    db.commit()
                    db.refresh(job)
                    new_ids.append(job.id)
                    total += 1
                    _publish(task_id, f"  Saved: {j['title']} at {j['company']}")
            except Exception as e:
                _publish(task_id, f"Error: {e}")
            time.sleep(1)

        if new_ids:
            _publish(task_id, f"Fetching descriptions for {len(new_ids)} jobs...")
            # Keep session alive during long scrape runs (Req 17.6)
            try:
                maybe_keep_alive(BrowserSession.get())
            except Exception:
                pass  # Browser not needed for guest API scraping
            _fetch_descriptions(db, new_ids, task_id)

        if new_ids:
            _publish(task_id, f"Analyzing {len(new_ids)} jobs against your resume...")
            try:
                maybe_keep_alive(BrowserSession.get())
            except Exception:
                pass  # Browser not needed for analysis
            _analyze_matches(db, new_ids, task_id)

    finally:
        db.close()

    _publish(task_id, f"Done! {total} new jobs found")


def _parse_guest_html(html: str) -> list[dict]:
    """Parse LinkedIn guest API HTML into job dicts with company logos."""
    jobs = []

    class P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.cur = {}
            self.in_title = self.in_company = self.in_loc = False

        def handle_starttag(self, tag, attrs):
            d = dict(attrs)
            cls = d.get("class", "")
            if tag == "a" and "base-card__full-link" in cls:
                href = d.get("href", "").split("?")[0].strip()
                if "/jobs/view/" in href:
                    self.cur["url"] = href
            if tag == "img" and "artdeco-entity-image" in cls:
                src = d.get("data-delayed-url", "") or d.get("src", "")
                if src and ("logo" in src.lower() or "company" in cls.lower()):
                    self.cur["logo"] = src
            if tag == "img" and not self.cur.get("logo"):
                src = d.get("data-delayed-url", "") or d.get("src", "")
                if src and ("media.licdn" in src or "static.licdn" in src):
                    self.cur["logo"] = src
            if "base-search-card__title" in cls:
                self.in_title = True
            if "base-search-card__subtitle" in cls:
                self.in_company = True
            if "job-search-card__location" in cls:
                self.in_loc = True

        def handle_data(self, data):
            t = data.strip()
            if not t:
                return
            if self.in_title:
                self.cur["title"] = t; self.in_title = False
            if self.in_company:
                self.cur["company"] = t; self.in_company = False
            if self.in_loc:
                self.cur["location"] = t; self.in_loc = False

        def handle_endtag(self, tag):
            if tag == "div" and self.cur.get("url") and self.cur.get("title"):
                jobs.append(dict(self.cur)); self.cur = {}

    p = P()
    p.feed(html)
    if p.cur.get("url") and p.cur.get("title"):
        jobs.append(p.cur)

    seen = set()
    unique = []
    for j in jobs:
        if j["url"] not in seen:
            seen.add(j["url"])
            j.setdefault("company", "")
            j.setdefault("location", "")
            unique.append(j)
    return unique


def _fetch_descriptions(db, job_ids, task_id):
    """Fetch job descriptions and detect ATS type with smart retry on rate limits."""
    remaining = list(job_ids)
    delay = 2.0
    max_retries = 2

    for attempt in range(max_retries + 1):
        if not remaining:
            break
        if attempt > 0:
            wait = min(delay * (2 ** attempt), 60)
            _publish(task_id, f"Retry {attempt}: waiting {wait:.0f}s for rate limit cooldown...")
            time.sleep(wait)

        still_failed = []
        for jid in remaining:
            job = db.query(ScrapedJob).filter(ScrapedJob.id == jid).first()
            if not job or job.description:
                continue
            try:
                r = httpx.get(job.url, timeout=10, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                })
                if r.status_code == 429:
                    still_failed.append(jid)
                    continue
                if r.status_code == 200:
                    html = r.text

                    # Extract description
                    if "show-more-less-html__markup" in html:
                        start = html.find("show-more-less-html__markup")
                        cs = html.find(">", start) + 1
                        ce = html.find("</div>", cs)
                        if ce > cs:
                            desc = re.sub(r"<[^>]+>", " ", html[cs:ce]).strip()
                            desc = re.sub(r"\s+", " ", desc)[:2000]
                            if desc:
                                job.description = desc

                    # Detect ATS type by following the apply URL redirect
                    ats_type = _detect_ats_from_apply_url(job.url, html)
                    job.ats_type = ats_type

                    db.commit()
            except Exception:
                still_failed.append(jid)
            time.sleep(delay)

        remaining = still_failed
        if remaining:
            _publish(task_id, f"{len(remaining)} descriptions still rate-limited, will retry...")

    fetched = len(job_ids) - len(remaining)
    _publish(task_id, f"Fetched {fetched}/{len(job_ids)} descriptions")


# All known ATS domain fragments for detection (Req 21.5, 21.6)
_ATS_DOMAIN_MAP: list[tuple[list[str], str]] = [
    (["greenhouse.io", "boards.greenhouse", "grnh.se"], "greenhouse"),
    (["lever.co", "jobs.lever"], "lever"),
    (["myworkdayjobs", "workday.com"], "workday"),
    (["rippling.com"], "rippling"),
    (["icims.com", "icims."], "icims"),
    (["smartrecruiters.com", "smartrecruiters."], "smartrecruiters"),
    (["ashbyhq.com"], "ashby"),
    (["bamboohr.com"], "bamboohr"),
    (["jobvite.com"], "jobvite"),
    (["taleo.net", "taleo."], "taleo"),
    (["successfactors.com", "successfactors."], "successfactors"),
]

# Combined regex fragment for all ATS domains used in href scanning
_ATS_DOMAINS_RE = "|".join(
    re.escape(d)
    for domains, _ in _ATS_DOMAIN_MAP
    for d in domains
)


def _classify_url_as_ats(url: str) -> str:
    """Return the ATS type string for a URL, or 'external' if unrecognised."""
    url_lower = url.lower()
    for domains, ats_type in _ATS_DOMAIN_MAP:
        if any(d in url_lower for d in domains):
            return ats_type
    return "external"


def _detect_ats_from_apply_url(linkedin_job_url: str, html: str) -> str:
    """
    Detect ATS type from the LinkedIn job page HTML.

    Easy Apply jobs have 'apply-link-onsite' in the HTML.
    External jobs have 'apply-link-offsite' or 'offsite-apply'.
    For external jobs, extracts the apply URL from JSON fields or href
    attributes and classifies against all known ATS domains.
    """
    # Check for Easy Apply vs external based on LinkedIn's own CSS classes
    if "apply-link-onsite" in html:
        return "easy_apply"

    if "offsite-apply" not in html and "apply-link-offsite" not in html:
        # No apply link found at all — check for text hints
        if "Easy Apply" in html or "easyApply" in html:
            return "easy_apply"

    # It's an external application — try to extract the apply URL
    # 1. Try structured JSON fields first (most reliable)
    apply_url = ""
    json_patterns = [
        r'"applyUrl"\s*:\s*"([^"]+)"',
        r'"companyApplyUrl"\s*:\s*"([^"]+)"',
    ]
    for pattern in json_patterns:
        match = re.search(pattern, html)
        if match:
            apply_url = match.group(1)
            break

    # 2. If no JSON field, scan hrefs for any known ATS domain
    if not apply_url:
        href_pattern = r'href="(https?://[^"]*(?:' + _ATS_DOMAINS_RE + r')[^"]*)"'
        match = re.search(href_pattern, html, re.IGNORECASE)
        if match:
            apply_url = match.group(1)

    if not apply_url:
        return "external"

    return _classify_url_as_ats(apply_url)


def _analyze_matches(db, job_ids, task_id):
    """Use Ollama to score job matches."""
    import asyncio
    from backend.services.ollama_service import OllamaService

    resume = db.query(ResumeProfileDB).order_by(ResumeProfileDB.created_at.desc()).first()
    if not resume or not resume.raw_text:
        _publish(task_id, "No resume uploaded — skipping match analysis")
        return

    ollama = OllamaService()
    for jid in job_ids:
        job = db.query(ScrapedJob).filter(ScrapedJob.id == jid).first()
        if not job:
            continue
        try:
            _publish(task_id, f"Analyzing: {job.title} at {job.company}")
            loop = asyncio.new_event_loop()
            result = loop.run_until_complete(
                ollama.match_job(resume.raw_text, job.title, job.company, job.description)
            )

            # Extract years-of-experience requirement (Req 7.7)
            exp_years = None
            if job.description and job.experience_years_required is None:
                try:
                    exp_years = loop.run_until_complete(
                        ollama.extract_experience_years(job.description)
                    )
                except Exception as exc:
                    _publish(task_id, f"  → Experience extraction failed: {exc}")

            loop.close()

            job.match_score = result.get("match_score", 0)
            reqs = result.get("requirements", [])
            job.requirements_total = len(reqs)
            job.requirements_met = sum(1 for r in reqs if r.get("met"))
            job.requirements_detail = reqs
            job.match_summary = result.get("summary", "")
            job.salary_range = result.get("salary_range", "")
            job.company_size = result.get("company_size", "")
            job.company_description = result.get("company_description", "")
            if exp_years is not None:
                job.experience_years_required = exp_years

            db.commit()
            _publish(task_id, f"  → {job.match_score}% match ({job.requirements_met}/{job.requirements_total} reqs)")
        except Exception as e:
            _publish(task_id, f"  → Analysis failed: {e}")


# ============================================================
# APPLY HELPERS
# ============================================================


def _detect_already_applied(driver, job, db) -> bool:
    """Check if the user already applied to this job.

    Checks both the page UI (badge/text) and the ApplicationRecord table.
    Returns True if already applied (caller should skip).
    """
    from selenium.webdriver.common.by import By

    # Check page for "Applied" badge or "Already applied" text
    try:
        page_text = driver.find_element(By.TAG_NAME, "body").text
        for marker in ["Already applied", "Applied ", "You applied"]:
            if marker in page_text:
                job.status = JobStatus.SKIPPED
                job.skip_reason = "already_applied_badge"
                db.commit()
                return True
    except Exception:
        pass

    # Check ApplicationRecord by URL
    existing = db.query(ApplicationRecord).filter(
        ApplicationRecord.url == job.url
    ).first()
    if existing:
        job.status = JobStatus.SKIPPED
        job.skip_reason = "duplicate_url"
        db.commit()
        return True

    # Check by job_id FK
    existing = db.query(ApplicationRecord).filter(
        ApplicationRecord.job_id == job.id
    ).first()
    if existing:
        job.status = JobStatus.SKIPPED
        job.skip_reason = "duplicate_job_id"
        db.commit()
        return True

    return False


def _discard_modal(driver, job=None, db=None, reason="failed") -> None:
    """Close an Easy Apply modal after failure.

    Tries dismiss button, then ESC, then handles the "Discard application?"
    confirmation dialog. Switches back to default content afterwards.
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    # Try clicking the dismiss (X) button
    dismissed = False
    for sel in [
        "button[aria-label='Dismiss']",
        "button[aria-label='Close']",
        "button.artdeco-modal__dismiss",
    ]:
        try:
            btn = driver.find_element(By.CSS_SELECTOR, sel)
            if btn.is_displayed():
                btn.click()
                dismissed = True
                time.sleep(1)
                break
        except Exception:
            continue

    # Fallback: ESC key
    if not dismissed:
        try:
            driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
            time.sleep(1)
        except Exception:
            pass

    # Handle "Discard application?" confirmation
    try:
        for sel in [
            "button[data-control-name='discard_application_confirm_btn']",
            "//button[contains(@data-control-name, 'discard')]",
            "//button[contains(text(), 'Discard')]",
            "//button[span[text()='Discard']]",
        ]:
            try:
                if sel.startswith("//"):
                    btn = driver.find_element(By.XPATH, sel)
                else:
                    btn = driver.find_element(By.CSS_SELECTOR, sel)
                if btn.is_displayed():
                    btn.click()
                    time.sleep(1)
                    break
            except Exception:
                continue
    except Exception:
        pass

    # Ensure we're back to default content
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    # Update job status if provided
    if job and db:
        job.status = JobStatus.FAILED
        job.skip_reason = reason
        db.commit()


def _take_pre_submit_screenshot(driver, job_id) -> str:
    """Capture a screenshot before clicking Submit.

    Saves to data/screenshots/ and returns the file path.
    """
    os.makedirs("data/screenshots", exist_ok=True)
    ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    path = f"data/screenshots/pre_submit_{job_id}_{ts}.png"
    try:
        driver.save_screenshot(path)
        logger.info("Pre-submit screenshot saved: %s", path)
    except Exception as e:
        logger.warning("Failed to save pre-submit screenshot: %s", e)
        path = ""
    return path


def _follow_company(driver, settings) -> None:
    """Click the Follow button on the company page if enabled in settings."""
    if not settings.get("follow_companies"):
        return

    from selenium.webdriver.common.by import By

    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    # Look for Follow button — skip if already following
    for sel in [
        "//button[contains(@aria-label, 'Follow')]",
        "//button[contains(text(), 'Follow')]",
        "//button[span[text()='Follow']]",
    ]:
        try:
            btn = driver.find_element(By.XPATH, sel)
            label = (btn.get_attribute("aria-label") or btn.text or "").lower()
            # Skip if it says "Following" or "Unfollow"
            if "following" in label or "unfollow" in label:
                logger.info("Already following company, skipping")
                return
            if btn.is_displayed():
                human_delay(0.5, 1.5)
                btn.click()
                logger.info("Followed company")
                human_delay(1, 2)
                return
        except Exception:
            continue

    logger.info("Follow button not found, skipping")


# ============================================================
# APPLY — uses persistent browser session
# ============================================================

def apply_to_job(task_id: str, job_id: int) -> str:
    """
    Apply to a specific job using undetected Chrome.
    Returns 'done', 'waiting', or 'failed'.
    """
    settings = _load_settings()
    session = BrowserSession.get()

    _publish(task_id, "Checking LinkedIn session...")
    try:
        session.ensure_logged_in(settings)
        _publish(task_id, "Session active")
    except Exception as e:
        _publish(task_id, f"Login failed: {e}")
        return "failed"

    # Keep session alive during multi-application runs (Req 17.6)
    maybe_keep_alive(session)

    d = session.driver
    db = SessionLocal()
    try:
        job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
        if not job:
            _publish(task_id, f"Job #{job_id} not found")
            return "done"

        _publish(task_id, f"Applying to: {job.title} at {job.company}")

        # Smart filter evaluation (Req 7.11)
        from backend.bot.smart_filter import SmartFilter
        smart_filter = SmartFilter(settings)
        passes, skip_reason = smart_filter.evaluate(job, db)
        if not passes:
            job.status = JobStatus.SKIPPED
            job.skip_reason = skip_reason
            db.commit()
            _publish(task_id, f"Skipped: {job.title} — {skip_reason}")
            return "done"

        try:
            return _apply_to_job_inner(task_id, d, job, settings, db, session, job_id)
        except Exception as exc:
            # Screenshot on failure for any unhandled exception (Req 18.1–18.3)
            _publish(task_id, f"Unexpected error applying to {job.title}: {exc}")
            failure_ss = ""
            try:
                failure_ss = session.take_screenshot(f"apply_failure_{job.id}")
            except Exception:
                pass
            job.status = JobStatus.FAILED
            if failure_ss:
                db.add(ApplicationRecord(
                    platform="linkedin", company=job.company, role=job.title,
                    url=job.url, status=ApplicationStatus.FAILED, job_id=job_id,
                    failure_screenshot_path=failure_ss,
                    ats_type=job.ats_type or "easy_apply",
                ))
            db.commit()
            return "failed"

    finally:
        db.close()


def _apply_to_job_inner(task_id, d, job, settings, db, session, job_id):
    """Core apply logic extracted for screenshot-on-failure wrapping."""
    from selenium.webdriver.common.by import By

    # Already-applied detection (Req 3.1–3.4)
    import re as _re
    job_id_match = _re.search(r'-(\d+)$', job.url)
    if job_id_match:
        jid = job_id_match.group(1)
        # Use the jobs/view URL which shows the job in the full page view
        job_url = f"https://www.linkedin.com/jobs/view/{jid}/"
    else:
        job_url = job.url

    d.get(job_url)
    human_delay(5, 8)
    smooth_scroll(d, settings)

    d.save_screenshot("data/linkedin_apply_debug.png")
    _publish(task_id, f"Page loaded: {d.current_url[:80]}")

    # Check if already applied (Req 3.1–3.4)
    if _detect_already_applied(d, job, db):
        _publish(task_id, f"Already applied to {job.title} — skipping")
        return "done"

    # Find Easy Apply button — same selectors as EasyApplyJobsBot
    easy_btn = None
    try:
        easy_btn = d.find_element(By.XPATH,
            "//div[contains(@class,'jobs-apply-button--top-card')]//button[contains(@class, 'jobs-apply-button')]")
        if not easy_btn.is_displayed():
            easy_btn = None
    except Exception:
        pass

    if not easy_btn:
        # Fallback selectors
        for sel in [
            (By.CSS_SELECTOR, 'button.jobs-apply-button'),
            (By.CSS_SELECTOR, 'button[aria-label*="Easy Apply"]'),
            (By.XPATH, '//button[contains(text(), "Easy Apply")]'),
            (By.XPATH, '//button[contains(text(), "Apply")]'),
        ]:
            try:
                btn = d.find_element(*sel)
                if btn.is_displayed():
                    easy_btn = btn
                    break
            except Exception:
                continue

    if not easy_btn:
        # JavaScript text-content fallback (LinkedIn obfuscates CSS classes)
        try:
            easy_btn = d.execute_script("""
                const spans = document.querySelectorAll('span');
                for (const span of spans) {
                    const text = span.textContent.trim();
                    if (text === 'Easy Apply' || text === 'Apply') {
                        let el = span;
                        for (let i = 0; i < 10; i++) {
                            el = el.parentElement;
                            if (!el) break;
                            if (el.tagName === 'BUTTON') return el;
                        }
                    }
                }
                return null;
            """)
        except Exception:
            pass

    if easy_btn:
        _publish(task_id, "Found Easy Apply — clicking...")
        human_delay(1, 3)  # brief pause before clicking
        easy_btn.click()
        human_delay(3, 5)
        result = _do_easy_apply(task_id, d, job, settings, db)
    else:
        # No Easy Apply button — check for external ATS apply URL
        apply_url = _extract_external_apply_url(d)
        if apply_url:
            ats_label = job.ats_type or "external"
            _publish(task_id, f"External apply detected ({ats_label}) — navigating to {apply_url[:80]}...")
            result = _do_external_apply(task_id, d, job, settings, db, apply_url)
        else:
            d.save_screenshot("data/linkedin_apply_debug.png")
            _publish(task_id, "No apply button found — skipping.")
            job.status = JobStatus.SKIPPED
            db.commit()
            return "done"

    # Update job status and store enriched ApplicationRecord
    meta = getattr(job, "_apply_meta", {})
    if result == "waiting":
        job.status = JobStatus.WAITING_ANSWER
    elif result == "done":
        job.status = JobStatus.APPLIED
        db.add(ApplicationRecord(
            platform="linkedin", company=job.company, role=job.title,
            url=job.url, status=ApplicationStatus.APPLIED, job_id=job_id,
            screenshot_path=meta.get("screenshot_path", ""),
            cover_letter_text=meta.get("cover_letter_text", ""),
            questions_answered=meta.get("questions_answered", []),
            ats_type=job.ats_type or "easy_apply",
            resume_version=meta.get("resume_version", "original"),
        ))
        _publish(task_id, f"Successfully applied to {job.title} at {job.company}")

        # Follow company after successful submission (Req 20.1)
        try:
            _follow_company(d, settings)
        except Exception as e:
            logger.warning("Follow company failed: %s", e)

        # HR outreach — connect with hiring managers (Req 16.1–16.6)
        try:
            _connect_with_hiring_managers(d, job, settings, db, task_id)
        except Exception as e:
            logger.warning("HR outreach failed: %s", e)
    else:
        job.status = JobStatus.FAILED
        # Capture failure screenshot if not already captured (Req 18.1–18.3)
        failure_ss = meta.get("failure_screenshot_path", "")
        if not failure_ss:
            try:
                failure_ss = session.take_screenshot(f"apply_failure_{job.id}")
            except Exception:
                pass
        db.add(ApplicationRecord(
            platform="linkedin", company=job.company, role=job.title,
            url=job.url, status=ApplicationStatus.FAILED, job_id=job_id,
            failure_screenshot_path=failure_ss,
            ats_type=job.ats_type or "easy_apply",
        ))
        _publish(task_id, f"Application failed for {job.title}")

    db.commit()
    return result



def _detect_and_fill_cover_letter(
    driver, filler, ollama, settings, job, resume_profile_db, resume_text, task_id
) -> str:
    """Detect cover letter textareas and fill with AI-generated text.

    Searches both the main document and all iframes for cover letter fields.
    Returns the generated cover letter text, or empty string if none generated.
    Requirements: 8.1–8.5
    """
    from selenium.webdriver.common.by import By

    COVER_LETTER_KEYWORDS = [
        "cover letter", "cover_letter", "coverletter",
        "letter of interest", "motivation letter",
    ]

    def _find_cover_letter_textarea(drv):
        """Find a cover letter textarea in the current browsing context."""
        textareas = drv.find_elements(By.CSS_SELECTOR, "textarea")
        for ta in textareas:
            label_text = ""
            try:
                ta_id = ta.get_attribute("id")
                if ta_id:
                    lbl = drv.find_element(By.CSS_SELECTOR, f"label[for='{ta_id}']")
                    label_text = lbl.text.strip().lower()
            except Exception:
                pass
            if not label_text:
                try:
                    label_text = ta.get_attribute("aria-label") or ""
                    label_text = label_text.strip().lower()
                except Exception:
                    pass
            if not label_text:
                try:
                    label_text = ta.get_attribute("placeholder") or ""
                    label_text = label_text.strip().lower()
                except Exception:
                    pass
            if any(kw in label_text for kw in COVER_LETTER_KEYWORDS):
                return ta
        return None

    if not resume_text:
        return ""

    # Search main document first, then iframes
    ta = _find_cover_letter_textarea(driver)
    found_in_iframe = False
    if not ta:
        try:
            iframes = driver.find_elements(By.TAG_NAME, "iframe")
            for iframe in iframes:
                try:
                    driver.switch_to.frame(iframe)
                    ta = _find_cover_letter_textarea(driver)
                    if ta:
                        found_in_iframe = True
                        break
                    driver.switch_to.default_content()
                except Exception:
                    driver.switch_to.default_content()
        except Exception:
            driver.switch_to.default_content()

    if not ta:
        return ""

    # Generate cover letter via OllamaService
    try:
        from backend.schemas.resume import ResumeProfile as RPSchema
        from backend.schemas.application import JobPosting

        profile = RPSchema(
            name=f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip(),
            email=settings.get("email", ""),
            phone=settings.get("phone", ""),
            location=settings.get("city", ""),
            linkedin_url=settings.get("linkedin_url", ""),
            skills=resume_profile_db.skills if resume_profile_db and resume_profile_db.skills else [],
            experience=[],
            education=[],
        )
        job_posting = JobPosting(
            title=job.title, company=job.company,
            description=job.description or "",
        )

        import asyncio
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    cover_letter = pool.submit(
                        asyncio.run,
                        ollama.generate_cover_letter(profile, job_posting),
                    ).result(timeout=60)
            else:
                cover_letter = loop.run_until_complete(
                    ollama.generate_cover_letter(profile, job_posting)
                )
        except RuntimeError:
            cover_letter = asyncio.run(
                ollama.generate_cover_letter(profile, job_posting)
            )

        if cover_letter:
            filler._set_react_value(driver, ta, cover_letter)
            _publish(task_id, "Generated and filled cover letter")
    except Exception as cl_err:
        logger.warning("Cover letter generation failed: %s", cl_err)
        _publish(task_id, "Cover letter generation unavailable — continuing without")
        cover_letter = ""
    finally:
        if found_in_iframe:
            driver.switch_to.default_content()

    return cover_letter or ""


def _find_nav_button(driver, aria_label):
    """Search for a navigation button by aria-label in default content, then iframes.

    Returns (button_element, found_in_iframe: bool) or (None, False) if not found.
    Always switches back to default content after searching iframes.
    """
    from selenium.webdriver.common.by import By

    selector = f"button[aria-label='{aria_label}']"

    # Fast path: check default content first
    try:
        btn = driver.find_element(By.CSS_SELECTOR, selector)
        if btn.is_displayed():
            return (btn, False)
    except Exception:
        pass

    # Slow path: iterate all iframes
    try:
        iframes = driver.find_elements(By.TAG_NAME, "iframe")
        for iframe in iframes:
            try:
                driver.switch_to.frame(iframe)
                btn = driver.find_element(By.CSS_SELECTOR, selector)
                if btn.is_displayed():
                    return (btn, True)
            except Exception:
                pass
            finally:
                driver.switch_to.default_content()
    except Exception:
        driver.switch_to.default_content()

    return (None, False)


def _do_easy_apply(task_id, driver, job, settings, db) -> str:
    """Handle LinkedIn Easy Apply multi-step form.

    Integrates iframe-aware filling, AI fallback, already-applied detection,
    discard recovery, pre-submit screenshot, and pause-before-submit.
    """
    from selenium.webdriver.common.by import By
    from backend.bot.form_filler_selenium import FormFillerSelenium
    from backend.services.task_runner import publish_log
    from backend.services.ollama_service import OllamaService

    filler = FormFillerSelenium(settings=settings)
    prefilled = dict(settings.get("prefilled_answers", {}))

    # Load previously answered questions
    answered = db.query(PendingQuestion).filter(
        PendingQuestion.job_id == job.id,
        PendingQuestion.answer.isnot(None),
    ).all()
    for a in answered:
        prefilled[a.question] = a.answer

    # Load resume text and profile for AI fallback / cover letter
    resume_text = ""
    resume_profile_db = None
    try:
        resume_profile_db = db.query(ResumeProfileDB).order_by(
            ResumeProfileDB.created_at.desc()
        ).first()
        if resume_profile_db and resume_profile_db.raw_text:
            resume_text = resume_profile_db.raw_text
    except Exception:
        pass

    # Initialise OllamaService for AI-powered answering
    ollama = OllamaService()

    # Determine resume version and optionally tailor resume (Req 10.1–10.4)
    resume_version = "original"
    resume_path_override = ""  # If set, use this instead of the original resume
    if settings.get("resume_tailoring_enabled") and resume_text and job.description:
        try:
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        tailored_text = pool.submit(
                            asyncio.run,
                            ollama.tailor_resume(resume_text, job.description),
                        ).result(timeout=90)
                else:
                    tailored_text = loop.run_until_complete(
                        ollama.tailor_resume(resume_text, job.description)
                    )
            except RuntimeError:
                tailored_text = asyncio.run(
                    ollama.tailor_resume(resume_text, job.description)
                )

            if tailored_text:
                # Save tailored resume as a separate file
                tailored_dir = os.path.join("data", "tailored_resumes")
                os.makedirs(tailored_dir, exist_ok=True)
                ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                tailored_path = os.path.join(tailored_dir, f"resume_{job.id}_{ts}.txt")
                with open(tailored_path, "w", encoding="utf-8") as f:
                    f.write(tailored_text)
                resume_path_override = os.path.abspath(tailored_path)
                resume_version = "tailored"
                _publish(task_id, "Generated tailored resume for this application")
        except Exception as tr_err:
            logger.warning("Resume tailoring failed, using original: %s", tr_err)
            _publish(task_id, "Resume tailoring unavailable — using original resume")

    # Metadata collected during the flow
    screenshot_path = ""
    cover_letter_text = ""
    questions_answered = []  # [{question, answer, source}]

    # Handle the "Continue to next step" button that sometimes appears right after clicking Easy Apply
    try:
        continue_btn = driver.find_element(
            By.CSS_SELECTOR, "button[aria-label='Continue to next step']"
        )
        if continue_btn.is_displayed():
            continue_btn.click()
            human_delay(1, 2)
    except Exception:
        pass

    # Choose resume if prompted
    _choose_resume(driver)

    try:
        for step in range(10):
            # Keep session alive during multi-step forms (Req 17.6)
            maybe_keep_alive(BrowserSession.get())
            human_delay(1, 2)

            # Upload resume file if upload field is present
            resume_path = resume_path_override or settings.get("resume_file_path", "")
            if resume_path and os.path.exists(resume_path):
                try:
                    file_inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
                    for fi in file_inputs:
                        if fi.is_enabled():
                            fi.send_keys(os.path.abspath(resume_path))
                            _publish(task_id, "Uploaded resume")
                            time.sleep(1)
                            break
                except Exception:
                    pass

            # Fill form fields — use AI fallback with iframe-aware filling
            if resume_text:
                unknown = filler.fill_with_ai_fallback(
                    driver, prefilled, ollama=ollama, resume_text=resume_text
                )
            else:
                # No resume text — use iframe-aware filling without AI
                unknown = filler.fill_in_iframe(driver, prefilled)

            # Track AI-answered questions from this step
            for field in getattr(filler, '_last_ai_answers', []):
                questions_answered.append(field)

            # Detect and fill cover letter textarea (Req 8.1–8.5)
            if not cover_letter_text and resume_text:
                cover_letter_text = _detect_and_fill_cover_letter(
                    driver, filler, ollama, settings, job,
                    resume_profile_db, resume_text, task_id,
                )

            if unknown:
                _publish(task_id, f"Found {len(unknown)} questions I need help with")
                for field in unknown:
                    if not db.query(PendingQuestion).filter(
                        PendingQuestion.job_id == job.id,
                        PendingQuestion.question == field["question"],
                    ).first():
                        db.add(PendingQuestion(
                            job_id=job.id, task_id=task_id,
                            question=field["question"],
                            field_type=field.get("type", "text"),
                            options=field.get("options", []),
                        ))
                        _publish(task_id, f"  Need answer: {field['question']}")
                db.commit()
                publish_log(
                    task_id,
                    "__WAITING__",
                    pending_questions={
                        "job_id": job.id,
                        "count": len(unknown),
                        "job_title": getattr(job, "title", ""),
                        "company": getattr(job, "company", ""),
                    },
                )
                return "waiting"

            # Try Submit
            submit, submit_in_iframe = _find_nav_button(driver, "Submit application")
            if submit is not None:
                # Pre-submit screenshot
                screenshot_path = _take_pre_submit_screenshot(driver, job.id)

                # Pause before submit if enabled
                if settings.get("pause_before_submit"):
                    _publish(task_id, "Paused for review — check Dashboard to approve or cancel")

                    # Build screenshot URL for the frontend
                    screenshot_url = ""
                    if screenshot_path:
                        screenshot_url = f"/data/screenshots/{screenshot_path.split('/')[-1]}" if "/" in screenshot_path else f"/data/screenshots/{screenshot_path}"

                    publish_log(
                        task_id,
                        "__WAITING__",
                        pause_review={
                            "screenshot_url": screenshot_url,
                            "job_title": getattr(job, "title", ""),
                            "company": getattr(job, "company", ""),
                        },
                    )

                    # Create a PendingQuestion for approval
                    pq = PendingQuestion(
                        job_id=job.id, task_id=task_id,
                        question="Review and approve this application before submitting.",
                        field_type="approval",
                        options=["approve", "cancel"],
                        answer=None,
                    )
                    db.add(pq)
                    db.commit()
                    db.refresh(pq)

                    # Poll for user approval (up to 10 minutes)
                    approved = False
                    for _ in range(120):
                        time.sleep(5)
                        db.expire_all()
                        pq = db.query(PendingQuestion).filter(
                            PendingQuestion.id == pq.id
                        ).first()
                        if pq and pq.answer:
                            if pq.answer.strip().lower() == "approve":
                                approved = True
                            break

                    if not approved:
                        _publish(task_id, "Application cancelled by user")
                        _discard_modal(driver, job, db, reason="user_cancelled")
                        return "done"

                submit.click()
                if submit_in_iframe:
                    driver.switch_to.default_content()
                _publish(task_id, "Application submitted!")
                human_delay(2, 4)
                smooth_scroll(driver, settings)

                # Store metadata on the job object for apply_to_job to use
                job._apply_meta = {
                    "screenshot_path": screenshot_path,
                    "cover_letter_text": cover_letter_text,
                    "questions_answered": questions_answered,
                    "resume_version": resume_version,
                }
                return "done"

            # Try Review
            review, review_in_iframe = _find_nav_button(driver, "Review your application")
            if review is not None:
                review.click()
                if review_in_iframe:
                    driver.switch_to.default_content()
                _publish(task_id, "Reviewing application...")
                human_delay(2, 4)
                smooth_scroll(driver, settings)
                continue

            # Try Continue/Next
            next_btn, next_in_iframe = _find_nav_button(driver, "Continue to next step")
            if next_btn is not None:
                next_btn.click()
                if next_in_iframe:
                    driver.switch_to.default_content()
                _publish(task_id, f"Step {step + 1} completed")
                human_delay(2, 4)
                smooth_scroll(driver, settings)
                _choose_resume(driver)
                continue

            _publish(task_id, "No next/submit button found")
            # Capture failure screenshot (Req 18.1–18.3)
            failure_ss = ""
            try:
                failure_ss = BrowserSession.get().take_screenshot(f"easy_apply_no_button_{job.id}")
            except Exception:
                pass
            job._apply_meta = {
                "screenshot_path": screenshot_path,
                "failure_screenshot_path": failure_ss,
                "cover_letter_text": cover_letter_text,
                "questions_answered": questions_answered,
                "resume_version": resume_version,
            }
            return "failed"

    except Exception as e:
        _publish(task_id, f"Easy Apply error: {e}")
        # Capture failure screenshot
        session = BrowserSession.get()
        failure_ss = session.take_screenshot(f"apply_failure_{job.id}")
        job._apply_meta = {
            "screenshot_path": screenshot_path,
            "failure_screenshot_path": failure_ss,
            "cover_letter_text": cover_letter_text,
            "questions_answered": questions_answered,
            "resume_version": resume_version,
        }
        _discard_modal(driver, job, db, reason=str(e)[:200])
        return "failed"

    # Store metadata for the caller
    job._apply_meta = {
        "screenshot_path": screenshot_path,
        "cover_letter_text": cover_letter_text,
        "questions_answered": questions_answered,
        "resume_version": resume_version,
    }
    return "failed"


def _choose_resume(driver) -> None:
    """Select resume if LinkedIn prompts for it (from EasyApplyJobsBot)."""
    from selenium.webdriver.common.by import By
    try:
        driver.find_element(By.CLASS_NAME, "jobs-document-upload__title--is-required")
        resumes = driver.find_elements(By.XPATH, "//div[contains(@class, 'ui-attachment--pdf')]")
        if resumes and resumes[0].get_attribute("aria-label") == "Select this resume":
            resumes[0].click()
            time.sleep(1)
    except Exception:
        pass


def _extract_external_apply_url(driver) -> str | None:
    """
    Extract the external apply URL from the current LinkedIn job page.

    LinkedIn external apply buttons link to an offsite URL, often wrapped
    in a redirect through linkedin.com/redir/redirect.  We look for the
    apply button first, then fall back to parsing the page source for
    known ATS URL patterns.
    """
    from selenium.webdriver.common.by import By

    # 1. Try clicking the external "Apply" button and capturing the redirect URL
    try:
        for sel in [
            (By.CSS_SELECTOR, 'a[data-tracking-control-name*="offsite"]'),
            (By.CSS_SELECTOR, 'a.jobs-apply-button'),
            (By.XPATH, '//a[contains(@href, "/externalApply/")]'),
        ]:
            try:
                link = driver.find_element(*sel)
                href = link.get_attribute("href")
                if href:
                    return href
            except Exception:
                continue
    except Exception:
        pass

    # 2. Parse page source for known ATS URLs
    try:
        html = driver.page_source
        import re
        patterns = [
            r'"applyUrl"\s*:\s*"([^"]+)"',
            r'"companyApplyUrl"\s*:\s*"([^"]+)"',
            r'href="(https?://[^"]*(?:greenhouse|lever|workday|icims|smartrecruiters|ashbyhq|bamboohr|jobvite)[^"]*)"',
            r'href="(https?://[^"]*(?:boards\.greenhouse|jobs\.lever|myworkdayjobs)[^"]*)"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                return match.group(1)
    except Exception:
        pass

    return None


def _do_external_apply(task_id, driver, job, settings, db, apply_url) -> str:
    """
    Handle external ATS application forms using Selenium.
    Routes to Greenhouse, Lever, Workday, or generic handler.
    """
    from selenium.webdriver.common.by import By
    from backend.bot.ats_greenhouse import is_greenhouse, apply_greenhouse
    from backend.bot.ats_lever import is_lever, apply_lever
    from backend.bot.ats_workday import is_workday, apply_workday
    from backend.services.ollama_service import OllamaService
    from backend.services.task_runner import publish_log

    prefilled = dict(settings.get("prefilled_answers", {}))

    # Load previously answered questions
    answered = db.query(PendingQuestion).filter(
        PendingQuestion.job_id == job.id,
        PendingQuestion.answer.isnot(None),
    ).all()
    for a in answered:
        prefilled[a.question] = a.answer

    # Load resume text for AI fallback
    resume_text = ""
    try:
        resume_profile_db = db.query(ResumeProfileDB).order_by(
            ResumeProfileDB.created_at.desc()
        ).first()
        if resume_profile_db and resume_profile_db.raw_text:
            resume_text = resume_profile_db.raw_text
    except Exception:
        pass

    # Enrich settings with resume text for AI helpers
    enriched_settings = dict(settings)
    enriched_settings["_resume_text"] = resume_text

    ollama = OllamaService()

    # Keep session alive during external apply flows (Req 17.6)
    maybe_keep_alive(BrowserSession.get())

    # Determine resume version and optionally tailor resume (Req 10.3, 10.4)
    resume_version = "original"
    if settings.get("resume_tailoring_enabled") and resume_text and job.description:
        try:
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        tailored_text = pool.submit(
                            asyncio.run,
                            ollama.tailor_resume(resume_text, job.description),
                        ).result(timeout=90)
                else:
                    tailored_text = loop.run_until_complete(
                        ollama.tailor_resume(resume_text, job.description)
                    )
            except RuntimeError:
                tailored_text = asyncio.run(
                    ollama.tailor_resume(resume_text, job.description)
                )

            if tailored_text:
                tailored_dir = os.path.join("data", "tailored_resumes")
                os.makedirs(tailored_dir, exist_ok=True)
                ts = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                tailored_path = os.path.join(tailored_dir, f"resume_{job.id}_{ts}.txt")
                with open(tailored_path, "w", encoding="utf-8") as f:
                    f.write(tailored_text)
                # Override resume_file_path so ATS handlers use the tailored version
                enriched_settings["resume_file_path"] = os.path.abspath(tailored_path)
                resume_version = "tailored"
                _publish(task_id, "Generated tailored resume for this application")
        except Exception as tr_err:
            logger.warning("Resume tailoring failed, using original: %s", tr_err)
            _publish(task_id, "Resume tailoring unavailable — using original resume")

    # Navigate to external application
    driver.get(apply_url)
    human_delay(4, 7)
    smooth_scroll(driver, settings)

    url = driver.current_url

    # Route to the appropriate ATS handler — wrapped for screenshot-on-failure (Req 18.1–18.3)
    try:
        if is_greenhouse(url):
            result, unknowns = apply_greenhouse(
                driver, enriched_settings, prefilled, task_id, _publish, ollama=ollama
            )
        elif is_lever(url):
            result, unknowns = apply_lever(
                driver, enriched_settings, prefilled, task_id, _publish, ollama=ollama
            )
        elif is_workday(url):
            result, unknowns = apply_workday(
                driver, enriched_settings, prefilled, task_id, _publish, ollama=ollama
            )
        else:
            # Generic external form handler
            result, unknowns = _do_generic_external_apply(
                driver, enriched_settings, prefilled, task_id, ollama, resume_text
            )
    except Exception as exc:
        _publish(task_id, f"External apply error: {exc}")
        failure_ss = ""
        try:
            session = BrowserSession.get()
            failure_ss = session.take_screenshot(f"external_apply_failure_{job.id}")
        except Exception:
            pass
        job._apply_meta = {
            "resume_version": resume_version,
            "failure_screenshot_path": failure_ss,
        }
        return "failed"

    # Save unknown questions as PendingQuestions
    if result == "waiting" and unknowns:
        for field in unknowns:
            if not db.query(PendingQuestion).filter(
                PendingQuestion.job_id == job.id,
                PendingQuestion.question == field["question"],
            ).first():
                db.add(PendingQuestion(
                    job_id=job.id, task_id=task_id,
                    question=field["question"],
                    field_type=field.get("type", "text"),
                    options=field.get("options", []),
                ))
                _publish(task_id, f"  Need answer: {field['question']}")
        db.commit()
        publish_log(
            task_id,
            "__WAITING__",
            pending_questions={
                "job_id": job.id,
                "count": len(unknowns),
                "job_title": getattr(job, "title", ""),
                "company": getattr(job, "company", ""),
            },
        )

    # Capture failure screenshot for non-exception failures (Req 18.1–18.3)
    failure_ss = ""
    if result == "failed":
        try:
            failure_ss = BrowserSession.get().take_screenshot(f"external_apply_failure_{job.id}")
        except Exception:
            pass

    # Store metadata for apply_to_job to use (Req 10.4, 18.1–18.3)
    job._apply_meta = {
        "resume_version": resume_version,
        "failure_screenshot_path": failure_ss,
    }

    return result


def _do_generic_external_apply(driver, settings, prefilled, task_id, ollama, resume_text) -> tuple[str, list[dict]]:
    """
    Generic external form handler for unrecognized ATS platforms.
    Scans for standard form elements (including inside iframes), fills using
    profile data + prefilled answers + AI fallback, uploads resume if a file
    input is detected, and attempts to click a submit button.

    Requirements: 15.1–15.5
    """
    from selenium.webdriver.common.by import By
    from backend.bot.form_filler_selenium import FormFillerSelenium

    _publish(task_id, "Generic application form — scanning for fields...")

    filler = FormFillerSelenium(settings=settings)

    # ── 1. Fill form fields (profile → prefilled → AI → PendingQuestion) ──
    # fill_with_ai_fallback already searches iframes internally via
    # fill_in_iframe, so it covers both the main page and any iframes.
    if resume_text:
        unknowns = filler.fill_with_ai_fallback(
            driver, prefilled, ollama=ollama, resume_text=resume_text,
        )
    else:
        unknowns = filler.fill_in_iframe(driver, prefilled)

    # ── 2. Upload resume if file input detected ──
    resume_path = settings.get("resume_file_path", "")
    resume_uploaded = _upload_resume_generic(driver, resume_path, task_id)

    # If there are unknowns the AI couldn't handle, return them for the user
    if unknowns:
        return "waiting", unknowns

    # ── 3. Try to click a submit button ──
    submitted = _click_submit_generic(driver, task_id)
    if submitted:
        return "done", []

    # ── 4. No submit button — check if there were any fillable fields at all ──
    has_fields = bool(driver.find_elements(
        By.CSS_SELECTOR,
        'input[type="text"], input[type="email"], textarea, select, '
        'input[type="tel"], input[type="url"], input[type="number"]',
    ))
    if not has_fields and not resume_uploaded:
        _publish(task_id, "No fillable fields found — skipping as unrecognized form")
        return "skipped", []

    _publish(task_id, "Could not find submit button on generic form")
    return "failed", []


def _upload_resume_generic(driver, resume_path: str, task_id: str) -> bool:
    """Upload resume to any visible file input on the page or inside iframes."""
    from selenium.webdriver.common.by import By

    if not resume_path or not os.path.exists(resume_path):
        return False

    abs_path = os.path.abspath(resume_path)

    # Try main page first
    if _try_upload_in_context(driver, abs_path, task_id):
        return True

    # Search inside iframes
    try:
        driver.switch_to.default_content()
        iframes = driver.find_elements(By.TAG_NAME, "iframe")
        for iframe in iframes:
            try:
                driver.switch_to.frame(iframe)
                if _try_upload_in_context(driver, abs_path, task_id):
                    driver.switch_to.default_content()
                    return True
                driver.switch_to.default_content()
            except Exception:
                driver.switch_to.default_content()
    except Exception:
        driver.switch_to.default_content()

    return False


def _try_upload_in_context(driver, abs_path: str, task_id: str) -> bool:
    """Attempt to upload a file to any file input in the current browsing context."""
    from selenium.webdriver.common.by import By

    for fi in driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]'):
        try:
            fi.send_keys(abs_path)
            _publish(task_id, "Uploaded resume")
            return True
        except Exception:
            continue
    return False


def _click_submit_generic(driver, task_id: str) -> bool:
    """
    Try to find and click a submit/apply button on the page or inside iframes.
    Searches by type="submit", then by button text content, then by <a> links
    styled as buttons.
    """
    from selenium.webdriver.common.by import By

    # Try in main page first
    driver.switch_to.default_content()
    if _try_submit_in_context(driver, task_id):
        return True

    # Search inside iframes
    try:
        iframes = driver.find_elements(By.TAG_NAME, "iframe")
        for iframe in iframes:
            try:
                driver.switch_to.frame(iframe)
                if _try_submit_in_context(driver, task_id):
                    driver.switch_to.default_content()
                    return True
                driver.switch_to.default_content()
            except Exception:
                driver.switch_to.default_content()
    except Exception:
        driver.switch_to.default_content()

    return False


def _try_submit_in_context(driver, task_id: str) -> bool:
    """Attempt to click a submit button in the current browsing context."""
    from selenium.webdriver.common.by import By

    # 1. Standard submit elements
    for sel in [
        'button[type="submit"]',
        'input[type="submit"]',
    ]:
        try:
            btn = driver.find_element(By.CSS_SELECTOR, sel)
            if btn.is_displayed():
                btn.click()
                _publish(task_id, "Clicked Submit")
                human_delay(3, 5)
                return True
        except Exception:
            continue

    # 2. Buttons by text content (Submit, Apply, Send Application, etc.)
    for text in ["Submit", "Apply", "Send Application", "Send", "Submit Application"]:
        for xpath in [
            f"//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{text.lower()}')]",
            f"//input[@value and contains(translate(@value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{text.lower()}')]",
        ]:
            try:
                btn = driver.find_element(By.XPATH, xpath)
                if btn.is_displayed():
                    btn.click()
                    _publish(task_id, f"Clicked '{text}' button")
                    human_delay(3, 5)
                    return True
            except Exception:
                continue

    # 3. <a> elements styled as submit buttons (common on custom platforms)
    for text in ["Submit", "Apply"]:
        try:
            link = driver.find_element(
                By.XPATH,
                f"//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{text.lower()}')]"
            )
            if link.is_displayed():
                role = link.get_attribute("role") or ""
                classes = link.get_attribute("class") or ""
                # Only click if it looks like a button (has role=button or button-like class)
                if role == "button" or "btn" in classes or "button" in classes:
                    link.click()
                    _publish(task_id, f"Clicked '{text}' link-button")
                    human_delay(3, 5)
                    return True
        except Exception:
            continue

    return False


# ============================================================
# ANALYZE — re-fetch descriptions and run match analysis
# ============================================================

def analyze_existing_jobs(task_id: str) -> None:
    """Fetch missing descriptions, re-detect ATS types, and run match analysis on unscored jobs."""
    db = SessionLocal()
    try:
        # Find jobs missing descriptions
        no_desc = db.query(ScrapedJob).filter(
            (ScrapedJob.description == "") | (ScrapedJob.description.is_(None))
        ).all()
        no_desc_ids = [j.id for j in no_desc]

        if no_desc_ids:
            _publish(task_id, f"Fetching descriptions for {len(no_desc_ids)} jobs...")
            _fetch_descriptions(db, no_desc_ids, task_id)

        # Re-detect ATS type for jobs with descriptions but empty ats_type
        no_ats = db.query(ScrapedJob).filter(
            ScrapedJob.description != "",
            ScrapedJob.description.isnot(None),
            (ScrapedJob.ats_type == "") | (ScrapedJob.ats_type.is_(None)),
        ).all()
        if no_ats:
            _publish(task_id, f"Re-detecting ATS type for {len(no_ats)} jobs...")
            for job in no_ats:
                try:
                    r = httpx.get(job.url, timeout=10, headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    })
                    if r.status_code == 200:
                        job.ats_type = _detect_ats_from_apply_url(job.url, r.text)
                        db.commit()
                except Exception:
                    pass
                time.sleep(1.5)
            _publish(task_id, f"ATS detection complete")

        # Find jobs missing match scores (have description but no score)
        unscored = db.query(ScrapedJob).filter(
            ScrapedJob.description != "",
            ScrapedJob.description.isnot(None),
            ScrapedJob.match_score == 0,
        ).all()
        unscored_ids = [j.id for j in unscored]

        if unscored_ids:
            _publish(task_id, f"Analyzing {len(unscored_ids)} jobs against your resume...")
            _analyze_matches(db, unscored_ids, task_id)
        else:
            _publish(task_id, "All jobs with descriptions are already analyzed")

        _publish(task_id, "Analysis complete!")
    finally:
        db.close()


def _connect_with_hiring_managers(driver, job, settings: dict, db, task_id: str) -> None:
    """Search LinkedIn for hiring contacts at the company and send connection requests.

    Searches for people with recruiter/HR titles at the target company,
    sends personalized connection requests with AI-generated messages,
    and stores ConnectionRequest records in the DB.

    Requirements: 16.1–16.6
    """
    from backend.db.models import ConnectionRequest
    from selenium.webdriver.common.by import By

    if not settings.get("hr_outreach_enabled"):
        return

    daily_limit = settings.get("hr_daily_connect_limit", 10)

    # Check how many connection requests we've sent today
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    sent_today = (
        db.query(ConnectionRequest)
        .filter(ConnectionRequest.sent_at >= today_start)
        .count()
    )
    if sent_today >= daily_limit:
        _publish(task_id, f"HR outreach: daily limit reached ({sent_today}/{daily_limit})")
        return

    remaining = daily_limit - sent_today
    company = job.company
    role = job.title

    _publish(task_id, f"HR outreach: searching for hiring contacts at {company}...")

    # Build search URL for recruiters/HR at the company
    import urllib.parse
    search_keywords = f"recruiter OR hiring manager OR talent acquisition OR HR {company}"
    search_url = (
        "https://www.linkedin.com/search/results/people/?"
        + urllib.parse.urlencode({"keywords": search_keywords, "origin": "GLOBAL_SEARCH_HEADER"})
    )

    try:
        driver.get(search_url)
        human_delay(4, 7)
        smooth_scroll(driver, settings)
    except Exception as e:
        _publish(task_id, f"HR outreach: failed to load search page — {e}")
        return

    # Initialize OllamaService for message generation
    import asyncio
    from backend.services.ollama_service import OllamaService
    ollama = OllamaService()

    profile_name = f"{settings.get('first_name', '')} {settings.get('last_name', '')}".strip()
    profile_title = settings.get("job_title", "")

    # Find people cards in search results
    contacts_found = 0
    try:
        # LinkedIn people search result cards
        result_cards = driver.find_elements(
            By.CSS_SELECTOR, "div.entity-result__item, li.reusable-search__result-container"
        )
    except Exception:
        result_cards = []

    if not result_cards:
        _publish(task_id, "HR outreach: no search results found")
        return

    hr_titles = {"recruiter", "hiring manager", "talent acquisition", "hr", "human resources"}

    for card in result_cards[:10]:  # Check up to 10 results
        if contacts_found >= remaining:
            break

        try:
            # Extract contact name
            name_el = card.find_element(By.CSS_SELECTOR, "span.entity-result__title-text a span[aria-hidden='true']")
            contact_name = name_el.text.strip()
            if not contact_name or contact_name.lower() == "linkedin member":
                continue

            # Extract title/headline
            try:
                title_el = card.find_element(By.CSS_SELECTOR, "div.entity-result__primary-subtitle")
                contact_title = title_el.text.strip()
            except Exception:
                contact_title = ""

            # Verify the person has a relevant HR/recruiter title
            title_lower = contact_title.lower()
            if not any(t in title_lower for t in hr_titles):
                continue

            # Check if we already sent a request to this person for this job
            existing = (
                db.query(ConnectionRequest)
                .filter(
                    ConnectionRequest.contact_name == contact_name,
                    ConnectionRequest.company == company,
                    ConnectionRequest.job_id == job.id,
                )
                .first()
            )
            if existing:
                continue

            # Find and click the Connect button
            connect_btn = None
            try:
                # Try finding Connect button within the card
                buttons = card.find_elements(By.TAG_NAME, "button")
                for btn in buttons:
                    btn_text = btn.text.strip().lower()
                    if btn_text == "connect":
                        connect_btn = btn
                        break
            except Exception:
                pass

            if not connect_btn:
                # Try the "..." more actions menu
                try:
                    more_btn = card.find_element(
                        By.CSS_SELECTOR, "button[aria-label*='more actions'], button.artdeco-dropdown__trigger"
                    )
                    more_btn.click()
                    human_delay(0.5, 1.0)
                    menu_items = driver.find_elements(By.CSS_SELECTOR, "div.artdeco-dropdown__content li")
                    for item in menu_items:
                        if "connect" in item.text.strip().lower():
                            connect_btn = item
                            break
                except Exception:
                    pass

            if not connect_btn:
                continue

            connect_btn.click()
            human_delay(1.5, 3.0)

            # Generate personalized message
            try:
                message = asyncio.get_event_loop().run_until_complete(
                    ollama.generate_connection_message(profile_name, profile_title, role, company)
                )
            except Exception:
                try:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    message = loop.run_until_complete(
                        ollama.generate_connection_message(profile_name, profile_title, role, company)
                    )
                    loop.close()
                except Exception as e:
                    logger.warning("AI message generation failed: %s", e)
                    message = f"Hi {contact_name.split()[0]}, I recently applied for the {role} position at {company} and would love to connect."
                    message = message[:300]

            # Click "Add a note" if the modal appears
            try:
                add_note_btn = driver.find_element(
                    By.XPATH, "//button[contains(@aria-label, 'Add a note')]"
                )
                add_note_btn.click()
                human_delay(0.5, 1.0)
            except Exception:
                pass

            # Type the message
            try:
                msg_textarea = driver.find_element(By.CSS_SELECTOR, "textarea[name='message'], textarea#custom-message")
                msg_textarea.clear()
                msg_textarea.send_keys(message)
                human_delay(0.5, 1.0)
            except Exception:
                pass

            # Click Send
            try:
                send_btn = driver.find_element(
                    By.XPATH, "//button[contains(@aria-label, 'Send')]"
                )
                send_btn.click()
                human_delay(2, 4)
            except Exception:
                # Try generic send button
                try:
                    send_btn = driver.find_element(
                        By.XPATH, "//button[normalize-space()='Send']"
                    )
                    send_btn.click()
                    human_delay(2, 4)
                except Exception as e:
                    logger.warning("Failed to click Send for %s: %s", contact_name, e)
                    # Dismiss any open modal
                    try:
                        driver.find_element(By.XPATH, "//button[@aria-label='Dismiss']").click()
                    except Exception:
                        pass
                    continue

            # Store the connection request in DB
            conn_req = ConnectionRequest(
                job_id=job.id,
                contact_name=contact_name,
                contact_title=contact_title,
                company=company,
                role_applied=role,
                message_sent=message,
                status="sent",
            )
            db.add(conn_req)
            db.commit()

            contacts_found += 1
            _publish(task_id, f"HR outreach: sent connection request to {contact_name} ({contact_title})")

        except Exception as e:
            logger.warning("HR outreach: error processing contact card — %s", e)
            continue

    if contacts_found == 0:
        _publish(task_id, "HR outreach: no suitable contacts found to connect with")
    else:
        _publish(task_id, f"HR outreach: sent {contacts_found} connection request(s)")
