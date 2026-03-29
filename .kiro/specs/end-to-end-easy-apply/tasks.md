# Implementation Plan: End-to-End Easy Apply

## Overview

Incremental implementation of the full Auto Apply Bot feature set: enhanced browser session, iframe-aware form filling, Easy Apply end-to-end flow, ATS Selenium migration, smart filtering, autopilot, AI enhancements, application tracking, HR outreach, browser UX, and desktop packaging. Each task builds on the previous, with checkpoints to validate progress.

## Tasks

- [x] 1. Enhance DB models and schemas
  - [x] 1.1 Add new fields to ScrapedJob, ApplicationRecord, and UserSettings in `backend/db/models.py`
    - Add `experience_years_required` (Integer, nullable) and `skip_reason` (String) to ScrapedJob
    - Add `screenshot_path`, `failure_screenshot_path`, `cover_letter_text`, `questions_answered` (JSON), `ats_type`, `resume_version` to ApplicationRecord
    - Add `company_blacklist` (JSON), `keyword_blacklist` (JSON), `min_salary`, `max_salary`, `min_experience_years`, `max_experience_years`, `autopilot_enabled`, `daily_apply_limit`, `weekly_apply_limit`, `apply_delay_min`, `apply_delay_max`, `pause_before_submit`, `follow_companies`, `hr_outreach_enabled`, `hr_daily_connect_limit`, `smooth_scrolling`, `resume_tailoring_enabled` to UserSettings
    - _Requirements: 5.8, 7.1–7.10, 6.5, 6.9, 17.4, 19.1, 20.1, 16.6, 10.1, 22.1_

  - [x] 1.2 Create new ConnectionRequest and AutopilotRun models in `backend/db/models.py`
    - ConnectionRequest: id, job_id, contact_name, contact_title, company, role_applied, message_sent, status, sent_at
    - AutopilotRun: id, task_id, started_at, stopped_at, total_applied, total_skipped, total_failed, total_waiting, status
    - _Requirements: 16.5, 6.1–6.7_

  - [x] 1.3 Update Pydantic schemas in `backend/schemas/settings.py` and `backend/schemas/application.py`
    - Add new fields to Settings response/update schemas
    - Add ApplicationReview schema with screenshot_path, cover_letter_text, questions_answered, ats_type, resume_version
    - Add ConnectionRequest and AutopilotRun schemas
    - Add CSV export schema
    - _Requirements: 5.1–5.8, 22.1–22.7_

- [x] 2. Checkpoint — Ensure models compile and DB migrations work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Enhance BrowserSession with keep-alive, screenshots, and session validation
  - [x] 3.1 Add `keep_alive()`, `take_screenshot(name)`, and `is_session_valid()` methods to `backend/services/browser_pool.py`
    - `keep_alive()`: execute JS mouse move / minor scroll every 5 min to prevent timeout
    - `take_screenshot(name)`: save screenshot to `data/` with timestamp, return file path
    - `is_session_valid()`: check current URL contains "/feed" without full navigation
    - _Requirements: 17.6, 18.1, 18.4, 1.9_

  - [x] 3.2 Enhance `ensure_logged_in` to support 2FA relay via PendingQuestion
    - When checkpoint/challenge detected, create a PendingQuestion with job_id=0 for the Dashboard to display a verification code modal
    - When user submits the code, relay it to the browser and complete auth
    - _Requirements: 1.4, 1.5_

  - [x] 3.3 Add login failure screenshot capture
    - On any login failure, call `take_screenshot("login_failure")` and return descriptive error
    - _Requirements: 1.8, 18.4_

- [-] 4. Implement iframe-aware form filling and React value persistence
  - [x] 4.1 Add `fill_in_iframe()` method to `backend/bot/form_filler_selenium.py`
    - Switch to each iframe on the page, call `fill_visible_fields()`, switch back to default content
    - Search ALL iframes, not just ones matching specific patterns
    - _Requirements: 26.1, 26.4, 26.5_

  - [x] 4.2 Add `_set_react_value()` method to FormFillerSelenium
    - Primary: `element.send_keys(value)` with clear first
    - Fallback: JS native setter `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` + dispatch `input`, `change`, `blur` events
    - _Requirements: 26.2, 26.3, 2.14_

  - [x] 4.3 Add `fill_with_ai_fallback()` method to FormFillerSelenium
    - After profile mapping and prefilled answers, call OllamaService for remaining unknown text/textarea fields
    - For select/radio fields, call OllamaService to evaluate options against resume context
    - Only save as PendingQuestion if AI also fails
    - _Requirements: 9.1–9.5, 2.4_

  - [x] 4.4 Write property test for form fill priority order
    - **Property 1: Fill priority order — profile data > prefilled answers > AI > PendingQuestion**
    - **Validates: Requirements 2.4, 9.1, 9.5**

- [x] 5. Enhance Easy Apply end-to-end flow in LinkedInBot
  - [x] 5.1 Add `_detect_already_applied(driver)` to `backend/bot/linkedin_bot.py`
    - Check page for "Applied" badge or "Already applied" text
    - Query ApplicationRecord table for existing record with same job URL or LinkedIn job ID
    - Update ScrapedJob status to "skipped" with reason if duplicate
    - _Requirements: 3.1–3.4_

  - [x] 5.2 Add `_discard_modal(driver)` to LinkedInBot
    - Try clicking dismiss button, then ESC key
    - Handle "Discard application?" confirmation by clicking "Discard"
    - Switch driver back to default content after dismissal
    - Update ScrapedJob status to "failed" with reason
    - _Requirements: 4.1–4.4_

  - [x] 5.3 Add `_take_pre_submit_screenshot(driver, job_id)` to LinkedInBot
    - Capture screenshot before clicking Submit, save to `data/screenshots/`
    - Store path in ApplicationRecord.screenshot_path
    - _Requirements: 5.2, 18.1, 19.2_

  - [x] 5.4 Add `_follow_company(driver)` to LinkedInBot
    - If `follow_companies` enabled in settings, find and click Follow button on company page
    - Skip if already following or button not found
    - _Requirements: 20.1–20.3_

  - [x] 5.5 Enhance `_do_easy_apply` to use iframe-aware filling, AI fallback, already-applied detection, discard recovery, pre-submit screenshot, and pause-before-submit
    - Call `_detect_already_applied()` before starting
    - Use `fill_in_iframe()` instead of `fill_visible_fields()` for iframe support
    - Use `fill_with_ai_fallback()` for AI-powered answering
    - Call `_take_pre_submit_screenshot()` before Submit click
    - If `pause_before_submit` enabled, pause and notify Dashboard, wait for approval
    - On failure, call `_discard_modal()` and capture failure screenshot
    - Handle up to 10 form steps, resume upload, resume selection
    - _Requirements: 2.1–2.14, 3.1–3.4, 4.1–4.4, 5.2, 19.1–19.5_

  - [x] 5.6 Enhance `apply_to_job` to store enriched ApplicationRecord
    - Save screenshot_path, cover_letter_text, questions_answered, ats_type, resume_version
    - Call `_follow_company()` after successful submission if enabled
    - _Requirements: 5.8, 8.4, 20.1_

  - [x] 5.7 Write unit tests for already-applied detection and modal discard
    - Test `_detect_already_applied` with "Applied" badge present/absent
    - Test `_discard_modal` with confirmation dialog
    - _Requirements: 3.1–3.4, 4.1–4.4_

- [x] 6. Checkpoint — Ensure Easy Apply flow compiles and existing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Migrate ATS modules from Playwright to Selenium
  - [x] 7.1 Migrate `backend/bot/ats_greenhouse.py` from Playwright to Selenium
    - Replace `Page` parameter with `WebDriver`
    - Replace `page.query_selector()` → `driver.find_element()`, `page.fill()` → `element.send_keys()`, `page.query_selector_all()` → `driver.find_elements()`, `page.set_input_files()` → `element.send_keys(file_path)`
    - Replace `page.content()` → `driver.page_source`
    - Add AI fallback via OllamaService for custom questions
    - Use shared BrowserSession singleton
    - _Requirements: 12.1–12.8, 25.1, 25.4, 25.5_

  - [x] 7.2 Migrate `backend/bot/ats_lever.py` from Playwright to Selenium
    - Same Playwright→Selenium migration pattern as Greenhouse
    - Add AI fallback via OllamaService for custom questions
    - _Requirements: 13.1–13.7, 25.2, 25.4, 25.5_

  - [x] 7.3 Create `backend/bot/ats_workday.py` (new Selenium-based handler)
    - Implement `is_workday(url)` checking for "myworkdayjobs" or "workday.com"
    - Implement `apply_workday(driver, settings, prefilled, task_id, log_fn, ollama)` with multi-page flow
    - Fill standard fields (name, email, phone, address, work experience, education) from settings and ResumeProfile
    - Handle file upload, Next/Submit button navigation
    - Skip if account creation required (log warning, mark skipped)
    - _Requirements: 14.1–14.6_

  - [x] 7.4 Implement generic external form handler in `backend/bot/linkedin_bot.py`
    - For ats_type "external" or unrecognized: navigate to URL, scan for standard form elements
    - Fill using profile data, prefilled answers, AI fallback
    - Upload resume if file input detected
    - Click submit button if found, else mark as skipped with "unrecognized form"
    - _Requirements: 15.1–15.5_

  - [x] 7.5 Update `_do_external_apply` in LinkedInBot to use Selenium driver instead of Playwright page
    - Route to migrated Greenhouse, Lever, Workday, or generic handler
    - Pass `driver` from BrowserSession instead of Playwright `page`
    - Remove all Playwright imports
    - _Requirements: 25.3, 25.4_

  - [x] 7.6 Write unit tests for ATS URL detection functions
    - Test `is_greenhouse()`, `is_lever()`, `is_workday()` with various URL patterns
    - _Requirements: 12.2, 13.2, 14.2_

- [x] 8. Implement SmartFilter
  - [x] 8.1 Create `backend/bot/smart_filter.py` with SmartFilter class
    - `__init__(settings)`: load blacklists, salary range, experience range from settings
    - `evaluate(job, db) -> tuple[bool, str]`: run all filter checks, return (passes, skip_reason)
    - `_check_company_blacklist(job)`: case-insensitive company name match
    - `_check_keyword_blacklist(job)`: keyword search in job description
    - `_check_salary_range(job)`: skip if salary entirely below minimum
    - `_check_experience_range(job)`: skip if required experience outside user's range
    - `_check_already_applied(job, db)`: check ApplicationRecord by URL and job ID
    - _Requirements: 7.1–7.11_

  - [x] 8.2 Add `extract_experience_years(description)` to OllamaService
    - New prompt template to extract years-of-experience from job description text
    - Store result in ScrapedJob.experience_years_required
    - _Requirements: 7.7_

  - [x] 8.3 Integrate SmartFilter into `apply_to_job` in LinkedInBot
    - Before applying, run `smart_filter.evaluate(job, db)` and skip if fails
    - Log skip reason and update ScrapedJob.skip_reason
    - _Requirements: 7.11_

  - [x] 8.4 Write property test for SmartFilter evaluation
    - **Property 2: A job matching any blacklist rule is always skipped**
    - **Validates: Requirements 7.5, 7.6**

  - [x] 8.5 Write unit tests for SmartFilter
    - Test each filter rule independently: company blacklist, keyword blacklist, salary range, experience range
    - _Requirements: 7.1–7.10_

- [x] 9. Implement AI-powered cover letters and resume tailoring
  - [x] 9.1 Enhance cover letter generation flow in LinkedInBot
    - When a cover letter textarea is detected during Easy Apply, call `OllamaService.generate_cover_letter()`
    - Paste generated text into the field
    - Store cover_letter_text in ApplicationRecord
    - If OllamaService unreachable, continue without cover letter and log warning
    - _Requirements: 8.1–8.5_

  - [x] 9.2 Add `tailor_resume(resume_text, job_description)` to OllamaService
    - Create new prompt template `prompts/tailor_resume.txt`
    - Generate tailored resume summary highlighting matching skills/experience
    - Save tailored version as separate file
    - _Requirements: 10.1–10.4_

  - [x] 9.3 Integrate resume tailoring into apply flow
    - If `resume_tailoring_enabled` in settings, call `tailor_resume()` before applying
    - Use tailored resume file for that application
    - Store resume_version ("original" or "tailored") in ApplicationRecord
    - _Requirements: 10.3, 10.4_

- [x] 10. Implement Autopilot mode
  - [x] 10.1 Create `backend/bot/autopilot.py` with AutopilotEngine class
    - `__init__(settings, smart_filter)`: configure limits and delays
    - `run(task_id)`: main loop — scrape → filter → apply → delay → check limits → repeat
    - `_check_limits(db)`: query ApplicationRecord count for today/this week against daily_apply_limit and weekly_apply_limit
    - `_random_delay()`: sleep for random duration between apply_delay_min and apply_delay_max
    - Skip jobs with PendingQuestions (log reason, continue to next)
    - Stop when user disables toggle or limit reached
    - _Requirements: 6.1–6.9_

  - [x] 10.2 Add `start_autopilot_task()` and `stop_autopilot_task()` to TaskRunner
    - Dispatch Celery task for autopilot loop
    - Create AutopilotRun record on start
    - Update AutopilotRun on stop (stopped_at, final counts, status)
    - _Requirements: 6.1, 6.6, 6.7_

  - [x] 10.3 Add autopilot API endpoints in `backend/routers/jobs.py`
    - `POST /autopilot/start` — start autopilot task
    - `POST /autopilot/stop` — stop autopilot task
    - `GET /autopilot/status` — return current AutopilotRun stats (applied today, this week, total interviews)
    - _Requirements: 6.1, 6.3, 6.6_

- [x] 11. Checkpoint — Ensure autopilot, smart filter, and AI enhancements compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement HR outreach — auto-connect with hiring managers
  - [x] 12.1 Add `generate_connection_message(profile, job_title, company)` to OllamaService
    - Create new prompt template `prompts/connection_message.txt`
    - Generate personalized connection request message referencing the applied role
    - _Requirements: 16.4_

  - [x] 12.2 Implement HR connect logic in LinkedInBot
    - New function `_connect_with_hiring_managers(driver, job, settings, db, task_id)`
    - Search LinkedIn for people with titles containing "recruiter", "hiring manager", "talent acquisition", "HR" at the target company
    - Send personalized connection request with AI-generated message
    - Store ConnectionRequest record in DB
    - Respect `hr_daily_connect_limit` from settings
    - _Requirements: 16.1–16.6_

  - [x] 12.3 Add `start_connect_task(job_id)` to TaskRunner and API endpoint
    - `POST /jobs/{id}/connect` — dispatch HR connect task
    - `GET /connections` — list sent connection requests with status
    - _Requirements: 16.5, 16.7_

- [x] 13. Implement browser UX — human-like behavior
  - [x] 13.1 Add randomized delays and smooth scrolling to LinkedInBot
    - Between page navigations: random delay 2–8 seconds
    - Smooth scrolling: incremental JS scroll with randomized distances and pauses (when enabled in settings)
    - Randomize form field fill order
    - _Requirements: 17.3, 17.4, 17.5_

  - [x] 13.2 Integrate keep-alive into long-running tasks
    - During autopilot and multi-application runs, call `BrowserSession.keep_alive()` every 5 minutes
    - _Requirements: 17.6_

  - [x] 13.3 Add screenshot-on-failure to all apply flows
    - Wrap apply logic in try/except, capture failure screenshot on any exception
    - Save failure_screenshot_path in ApplicationRecord
    - _Requirements: 18.1–18.3_

- [x] 14. Implement application tracking, review page, and CSV export
  - [x] 14.1 Add review and export API endpoints
    - `GET /applications/review` — paginated list with screenshot_path, cover_letter_text, questions_answered, ats_type, resume_version; support search by company/role/status and filter by status
    - `GET /applications/export` — generate CSV with all fields: job ID, title, company, location, work style, description excerpt, experience required, skills, HR contact, resume used, date posted, date applied, job link, questions found, status
    - _Requirements: 5.1–5.7_

  - [x] 14.2 Create `frontend/src/pages/ReviewPage.tsx`
    - Table listing all applications with columns: company, role, platform, status, applied date
    - Inline pre-submit and failure screenshot display
    - Resume version and cover letter display per application
    - Search bar for company/role/status filtering
    - Status filter controls (applied, failed, skipped, interviewing, rejected, offer)
    - "Export CSV" button triggering download
    - _Requirements: 5.1–5.7_

  - [x] 14.3 Add ReviewPage route to `frontend/src/App.tsx` and navigation
    - Add `/review` route pointing to ReviewPage
    - Add "Review" link in the nav bar
    - _Requirements: 5.1_

- [x] 15. Implement Autopilot panel and enhanced Settings in frontend
  - [x] 15.1 Create AutopilotPanel component in `frontend/src/pages/Dashboard.tsx`
    - Autopilot toggle (on/off)
    - Real-time stats: jobs applied today, this week, total interview requests
    - Recently-applied carousel showing last 10 applications with company logo, title, timestamp
    - _Requirements: 6.1, 6.3, 6.4_

  - [x] 15.2 Enhance `frontend/src/pages/Settings.tsx` with new filter and config fields
    - Company blacklist input (add/remove companies)
    - Keyword blacklist input (add/remove keywords)
    - Min/max salary range inputs
    - Min/max years-of-experience inputs
    - Daily and weekly application limit inputs
    - Apply delay range (min/max seconds)
    - Pause before submit toggle
    - Follow companies toggle
    - HR outreach toggle with daily connect limit
    - Smooth scrolling toggle
    - Resume tailoring toggle
    - _Requirements: 7.1–7.3, 7.8, 6.5, 6.9, 19.1, 20.1, 16.1, 16.6, 17.4, 10.1, 22.1–22.7_

  - [x] 15.3 Add pause-before-submit review UI to Running page
    - Display "Review & Submit" prompt with pre-submit screenshot
    - Approve (submit) and Cancel (discard) buttons
    - Wire to backend notification via SSE
    - _Requirements: 19.2–19.5_

  - [x] 15.4 Add connection requests list to Dashboard
    - Display sent connection requests with contact name, company, role, message, status, timestamp
    - _Requirements: 16.7_

- [x] 16. Update `frontend/src/api.ts` with new API calls
  - Add autopilot start/stop/status endpoints
  - Add application review and export endpoints
  - Add connection request list endpoint
  - Add HR connect endpoint
  - Update Settings interface with all new fields
  - _Requirements: 5.1–5.7, 6.1, 6.3, 16.7_

- [x] 17. Checkpoint — Ensure frontend compiles and all API endpoints are wired
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Enhance job scraping and ATS detection
  - [x] 18.1 Enhance `scrape_jobs` in LinkedInBot with rate-limit handling
    - Implement exponential backoff with max 2 retries on HTTP 429
    - _Requirements: 21.7_

  - [x] 18.2 Enhance ATS detection in `_detect_ats_from_apply_url`
    - Ensure all known ATS domains are detected: greenhouse.io, lever.co, myworkdayjobs, workday.com, icims, smartrecruiters, ashbyhq, bamboohr, jobvite, taleo, successfactors
    - Store detected ats_type in ScrapedJob
    - _Requirements: 21.5, 21.6_

- [x] 19. Enhance real-time log streaming
  - [x] 19.1 Add `__WAITING__` sentinel support to TaskRunner and SSE endpoint
    - Publish `__WAITING__` when task is waiting for user input (PendingQuestion or pause-before-submit)
    - Frontend Running page handles `__WAITING__` to show appropriate UI
    - _Requirements: 23.4–23.6_

  - [x] 19.2 Ensure SSE auto-scroll and sentinel handling in `frontend/src/pages/Running.tsx`
    - Auto-scroll log display
    - Handle `__DONE__`, `__ERROR__`, `__WAITING__` sentinels to update UI state
    - _Requirements: 23.3–23.6_

- [x] 20. Implement Settings page encryption and resume upload
  - [x] 20.1 Ensure LinkedIn password and cookies are encrypted before DB storage
    - Use existing `backend/services/crypto.py` encrypt/decrypt for password and li_at cookie
    - _Requirements: 22.7_

  - [x] 20.2 Ensure resume upload accepts PDF and DOCX via Settings page
    - File upload control in Settings, store file path in UserSettings
    - _Requirements: 22.2_

- [x] 21. Implement AI match scoring enhancements
  - [x] 21.1 Enhance Dashboard job cards with color-coded match score bar
    - "Great fit" (green) for 90+, "Good fit" (blue) for 75–89, "Fair" (yellow) for 50–74, "Low match" (red) below 50
    - Add sort controls: by match score (best first) or scrape date (newest first)
    - _Requirements: 11.4, 11.5_

- [x] 22. Checkpoint — Ensure all features compile and integrate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Desktop application packaging
  - [x] 23.1 Set up Electron project structure for desktop packaging
    - Create `desktop/` directory with Electron main process
    - Bundle React frontend, FastAPI backend, Redis, and Celery worker
    - Auto-launch all services on app start, open Dashboard in embedded browser
    - System tray icon with Dashboard, status, and quit options
    - Auto-update support
    - _Requirements: 24.1–24.6_

- [x] 24. Final checkpoint — Full integration validation
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- ATS migration (task 7) removes all Playwright dependencies — critical for single-dependency codebase
- Browser automation MUST use local Chrome + Selenium + selenium_stealth throughout
- Property tests validate universal correctness properties
