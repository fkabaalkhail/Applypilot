# Tasks

## Feature 1: Multi-Select Pill UI

- [x] 1.1 Add pill-group and pill-btn CSS styles to popup.css
  - [x] 1.1.1 Add `.pill-group` flex-wrap container styles
  - [x] 1.1.2 Add `.pill-btn` base styles (transparent bg, --border border, --text-secondary color, --radius-full, padding, cursor)
  - [x] 1.1.3 Add `.pill-btn.selected` styles (--accent background, white text)
  - [x] 1.1.4 Add `.pill-btn:hover` subtle hover effect
- [x] 1.2 Replace Experience Level `<select>` with pill group in popup.html
  - [x] 1.2.1 Remove the `<select id="experienceLevel">` element and its parent `.form-group`
  - [x] 1.2.2 Add `<div class="pill-group" data-setting="experienceLevel">` with pill buttons for Internship (intern), Entry Level (entry), Mid-Senior (mid), Senior (senior), Director (director), Executive (executive)
- [x] 1.3 Replace Work Type `<select>` with pill group in popup.html
  - [x] 1.3.1 Remove the `<select id="workType">` element and its parent `.form-group`
  - [x] 1.3.2 Add `<div class="pill-group" data-setting="workType">` with pill buttons for Remote (remote), On-site (onsite), Hybrid (hybrid)
- [x] 1.4 Replace Posted Within `<select>` with pill group in popup.html
  - [x] 1.4.1 Remove the `<select id="postedWithin">` element and its parent `.form-group`
  - [x] 1.4.2 Add `<div class="pill-group" data-setting="postedWithin">` with pill buttons for Last 24 Hours (24h), Last Week (week), Last Month (month)
- [x] 1.5 Add pill group toggle logic and auto-save integration in popup.js
  - [x] 1.5.1 Add `setupPillGroups()` function that attaches click handlers to `.pill-btn` elements to toggle `.selected` class and trigger `saveConfig()`
  - [x] 1.5.2 Call `setupPillGroups()` from the DOMContentLoaded handler
  - [x] 1.5.3 Update `saveConfig()` to detect `.pill-group[data-setting]` containers and collect selected values as arrays
  - [x] 1.5.4 Update `populateSettingsFields()` to detect pill groups and restore selections from arrays, with legacy single-string fallback (wrap in `[value]`)
  - [x] 1.5.5 Update `setupAutoSave()` to include pill button click events in the auto-save wiring (delegated listener on pill groups)

## Feature 2: Easy Apply Badge Detection Fix

- [x] 2.1 Add `hasEasyApplyBadge(cardElement)` helper function in content.js
  - [x] 2.1.1 Check for "Easy Apply" text content within the card element (spans, divs)
  - [x] 2.1.2 Check for LinkedIn Easy Apply SVG icon within the card element
  - [x] 2.1.3 Return `true` if badge found, `false` otherwise
- [x] 2.2 Update `scrapeCurrentPage()` in content.js to use per-card badge detection
  - [x] 2.2.1 In APPROACH 1 (job links), replace hardcoded `atsType: 'easy_apply', easyApply: 1` with dynamic values from `hasEasyApplyBadge(card)`
  - [x] 2.2.2 In APPROACH 2 (SDUI), replace hardcoded `atsType: 'easy_apply', easyApply: 1` with dynamic values (default to `'external'` / `0` when badge cannot be determined from text parsing)
- [x] 2.3 Update `save_job_batch` in backend/routers/extension.py to respect client-provided ATS type
  - [x] 2.3.1 Change `easy_apply=1` to `easy_apply=j.get("easyApply", 1)`
  - [x] 2.3.2 Change `ats_type="easy_apply"` to `ats_type=j.get("atsType", "easy_apply")`

## Feature 3: Greenhouse Form Filling in Content Script

- [x] 3.1 Add `fillGreenhouseForm(profile, settings, prefilledAnswers)` function in content.js
  - [x] 3.1.1 Locate form container using selectors `#application_form`, `#main_fields`, `#application`, with fallback to `document`
  - [x] 3.1.2 Fill standard fields (first_name, last_name, email, phone, linkedin) from profile using CSS selectors matching ats_greenhouse.py, skipping fields that already have values
  - [x] 3.1.3 Handle resume upload: find `input[type="file"]` with nearby "resume"/"cv"/"curriculum" label, upload from stored resume in chrome.storage
  - [x] 3.1.4 Handle custom select dropdowns: match label against prefilled answers, fall back to AI via `askAI()`, add to unfilled list if no answer
  - [x] 3.1.5 Handle custom text inputs and textareas (excluding standard fields): match label against prefilled answers, fall back to AI, add to unfilled list if no answer
  - [x] 3.1.6 Handle radio button groups in fieldsets: match legend against prefilled answers, fall back to AI, add to unfilled list if no answer
  - [x] 3.1.7 Find and click submit button using selectors `#submit_app`, `button[type="submit"]`, `input[type="submit"]`, or buttons containing "Submit"/"Apply" text
  - [x] 3.1.8 Check for success confirmation ("thank" or "success" in page text) and validation errors after submission
  - [x] 3.1.9 Return result object `{ status, filled, skipped, failed, unfilled }`
- [x] 3.2 Integrate Greenhouse form filling into `processJobQueue()` in content.js
  - [x] 3.2.1 When `currentJob.atsType === 'greenhouse'`, call `fillGreenhouseForm()` instead of the Easy Apply flow
  - [x] 3.2.2 Handle the result (submitted → increment applied count, failed/waiting → increment skipped count)
  - [x] 3.2.3 Call `moveToNextJob()` after processing

## Testing

- [x] 4.1 Write property test: Pill toggle involution (fast-check)
  - [x] 4.1.1 Generate random pill group with random initial state, click a random pill twice, verify state restored
- [x] 4.2 Write property test: Pill save/load round-trip (fast-check)
  - [x] 4.2.1 Generate random subset of valid pill values, mock chrome.storage, call saveConfig then populateSettingsFields, verify selected pills match. Include legacy single-string case.
- [x] 4.3 Write property test: Easy Apply badge classification (fast-check)
  - [x] 4.3.1 Generate random job card HTML with/without Easy Apply badge text, call hasEasyApplyBadge, verify atsType and easyApply match badge presence
- [x] 4.4 Write property test: Backend ATS preservation (hypothesis)
  - [x] 4.4.1 Generate random job payloads with optional atsType/easyApply fields, call save_job_batch, verify stored values match payload or defaults
- [x] 4.5 Write property test: Greenhouse URL detection (fast-check)
  - [x] 4.5.1 Generate random URLs (some containing greenhouse.io/boards.greenhouse/grnh.se), call detectATS, verify returns "greenhouse" iff pattern matches
- [x] 4.6 Write property test: Pre-filled field preservation (fast-check)
  - [x] 4.6.1 Generate random pre-filled field values in mock DOM, run Greenhouse filler, verify values unchanged
- [x] 4.7 Write property test: Prefilled answer matching (fast-check)
  - [x] 4.7.1 Generate random Q&A dictionary and random field labels (some matching keys), run matching logic, verify correct answers applied to matching fields
