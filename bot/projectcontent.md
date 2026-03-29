---
inclusion: always
---

# Auto Apply Bot — Project Context & Lessons Learned

## What This Project Is
A premium desktop application that auto-applies to LinkedIn Easy Apply jobs. Will be distributed as a paid software with license keys.

## Architecture
- **Frontend**: React + Vite (dashboard for settings, job tracking, stats)
- **Backend**: FastAPI + SQLAlchemy + SQLite (API, job storage, settings)
- **Worker**: Celery + Redis (background job processing)
- **Browser Automation**: Selenium + selenium_stealth (LinkedIn interaction)
- **AI**: Ollama/Llama (resume matching, custom question answering)
- **Docker**: For web dashboard (frontend + backend + redis)
- **Local Python**: For browser automation (MUST run on user's machine, NOT Docker)

## CRITICAL: Browser Automation Lessons (DO NOT REPEAT THESE MISTAKES)

### What DOESN'T work:
1. **Docker Chromium** — LinkedIn blocks it. SPA won't render job content. Wasted hours on this.
2. **Playwright** — LinkedIn detects `--enable-automation` flag. Even with stealth plugin, SPA won't render.
3. **Headless mode** — LinkedIn blocks headless browsers entirely.
4. **Direct login from Docker** — Always triggers 2FA/CAPTCHA that can't be solved.

### What WORKS:
1. **Local Chrome + Selenium + selenium_stealth** — User's real Chrome on their machine
2. **Cookie persistence via pickle** — Save/load cookies between sessions
3. **li_at cookie injection** — User pastes cookie from their browser, instant login
4. **JavaScript button finding** — LinkedIn uses obfuscated CSS classes. Find buttons by `span.textContent === 'Apply'`
5. **Iframe handling** — Easy Apply forms (JazzHR, etc.) are inside iframes. Must `driver.switch_to.frame()` and search ALL iframes
6. **Shadow DOM deep search** — Last resort using `createTreeWalker` for web components
7. **`excludeSwitches: ["enable-automation"]`** — Critical anti-detection option
8. **`useAutomationExtension: False`** — Critical anti-detection option

### Easy Apply Button Detection:
```javascript
// LinkedIn obfuscates class names. Find by text content:
const spans = document.querySelectorAll('span');
for (const span of spans) {
    if (span.textContent.trim() === 'Apply') {
        // Walk up to find parent button
        let el = span;
        for (let i = 0; i < 10; i++) {
            el = el.parentElement;
            if (el.tagName === 'BUTTON') { el.click(); break; }
        }
    }
}
```

### Form Button Detection (Next/Submit/Review):
Must search inside iframes. The form modal is typically in an iframe.
```javascript
// Search ALL iframes for buttons
driver.switch_to.default_content()
iframes = driver.find_elements(By.TAG_NAME, "iframe")
for iframe in iframes:
    driver.switch_to.frame(iframe)
    // Look for Next/Submit buttons here
    driver.switch_to.default_content()
```

### Form Filling:
- Forms inside iframes need `driver.switch_to.frame()` before filling
- React forms need native setter: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
- Or use `el.send_keys()` which simulates real typing
- Must dispatch `input`, `change`, `blur` events

## Key Files
- `test_easy_apply.py` — Working local Chrome test script
- `smart_form_filler.py` — AI-powered form filler (profile + Ollama)
- `backend/services/browser_pool.py` — Browser session manager (Selenium)
- `backend/bot/linkedin_bot.py` — Main bot logic (scrape + apply)
- `backend/bot/form_filler_selenium.py` — Selenium form filler
- `TODO.md` — Feature roadmap

## Current Status
- ✅ Job scraping works (LinkedIn guest API)
- ✅ Dashboard works (React frontend)
- ✅ Cookie login works (li_at cookie)
- ✅ Apply button found and clicked (JavaScript approach)
- ✅ Form modal opens (iframe detected)
- ✅ Next/Submit buttons found inside iframe
- 🔧 Form filling inside iframe needs fixing (fields found but values not sticking)
- ❌ Full end-to-end Easy Apply not yet complete
- ❌ Desktop app packaging not started

## Reference Repos (Proven Approaches)
- `github.com/wodsuz/EasyApplyJobsBot` — Best reference. Selenium + stealth, cookie persistence, simple form flow
- `github.com/GodsScion/Auto_job_applier_linkedIn` — undetected_chromedriver, user's Chrome profile
- `github.com/Azoo92i/AutoApplyMax` — Chrome extension approach

## User Info
- Name: Fahad Aba-Alkhail
- Email: fahadabraar@gmail.com
- Phone: 6133168025
- Location: Ottawa, Ontario, Canada
- LinkedIn: fahadabraar@gmail.com
