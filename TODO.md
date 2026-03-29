# Auto Apply Bot — TODO

## ✅ SOLVED: Browser Automation Approach
**Key learnings — DO NOT use Docker Chromium for LinkedIn. Use local Chrome.**
- LinkedIn blocks Docker's Chromium (SPA won't render job content)
- Playwright fails even with stealth — LinkedIn detects `--enable-automation`
- Solution: Selenium + selenium_stealth + user's real Chrome on their machine
- Apply button uses obfuscated CSS classes — find by JavaScript `span.textContent === 'Apply'`
- Easy Apply form is inside an **iframe** (JazzHR, etc.) — must `driver.switch_to.frame()`
- Search ALL iframes, not just ones matching specific src patterns
- Shadow DOM deep search as last resort using `createTreeWalker`
- Cookie persistence via pickle files for session reuse
- `add_experimental_option("excludeSwitches", ["enable-automation"])` is critical

## Priority 1: Fix LinkedIn Login (BLOCKER)
- [ ] Add VNC server to worker container so user can manually complete security check once
- [ ] Add "Connect LinkedIn" button in UI that opens login page in bot's browser via VNC
- [ ] Persist browser session/cookies across container restarts (persistent context already done)
- [ ] After manual login, session stays active for all future apply tasks — no more 2FA

## Priority 2: Get Easy Apply working end-to-end
- [ ] After login is solved, test the full Easy Apply flow (click Apply → fill form → submit)
- [ ] Handle multi-step Easy Apply forms (Next → Next → Review → Submit)
- [ ] Resume upload during Easy Apply
- [ ] Handle "already applied" detection
- [ ] Discard/close modal on failure (ESC key like GodsScion's bot)

## Feature: Application Tracking & Review
- [ ] Application review page with:
  - Screenshot of the filled application form (taken before submit)
  - View attached documents (resume, cover letter)
  - Applied date, company, role, status
  - Search/filter applied vs failed
  - Download jobs list as CSV export
- [ ] Detailed application history CSV logging (job ID, title, company, location, work style, description, experience required, skills, HR name/link, resume used, date posted, date applied, job link, questions found)

## Feature: Autopilot Mode
- [ ] Auto-apply to all matching Easy Apply jobs without manual clicks
- [ ] Toggle on/off from dashboard
- [ ] Stats: jobs applied today, this week, interview requests
- [ ] Recently applied carousel
- [ ] Configurable daily/weekly limits
- [ ] Run continuously until stopped (like GodsScion's `run_non_stop`)

## Feature: Smart Filtering
- [ ] Company blacklist — skip specific companies
- [ ] Keyword blacklist — skip jobs containing certain words in description
- [ ] Salary range filter (min/max)
- [ ] Years of experience extraction from job description + auto-skip if overqualified/underqualified
- [ ] Skip already-applied jobs (track by job ID)
- [ ] Skip reposted jobs

## Feature: AI-Powered
- [ ] AI-generated cover letters per job (using Ollama)
- [ ] Smart question answering using AI for custom application questions
- [ ] AI resume tailoring per job description
- [ ] AI match scoring improvements (already partially done)

## Feature: External ATS Support
- [ ] Greenhouse form filling
- [ ] Lever form filling
- [ ] Workday form filling
- [ ] Generic external application form detection + filling

## Feature: HR Outreach (Future)
- [ ] Auto-connect with hiring managers after applying
- [ ] Personalized connection request messages
- [ ] Track connection requests sent

## Feature: Browser & UX
- [ ] Follow companies after applying (optional toggle)
- [ ] Smooth scrolling option for more human-like behavior
- [ ] Screenshot on every failure for debugging
- [ ] Keep screen/session awake during long runs
- [ ] Pause before submit option (review before final click)
