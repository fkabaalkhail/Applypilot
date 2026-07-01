---
inclusion: auto
---

# Greenhouse & External ATS Fixes — Critical Context

## IMMEDIATE ISSUES TO FIX (in priority order):

### 1. Multiple tabs race condition
When the queue processes external ATS jobs, multiple Greenhouse tabs open simultaneously and all try to fill at once. `autoFillExternalATS()` in content.js runs on every page load. Need a tab-level lock — only one external ATS tab should be filling at a time.

### 2. Greenhouse React-Select dropdowns returning empty options
Country and School work (searchable typeaheads). But these fields return `[]` options:
- Degree, Discipline
- High school math/language performance
- Plagiarism/AI agreement
- Travel commitment
- Privacy policy confirmation
- Country of work
- Number of companies worked for
- Gender, Nationality, Race/ethnicity

The issue: the dropdown indicator arrow needs to be clicked (the SVG caret inside `[class*="select__indicator"]`), not just the container div. The current code clicks the container which doesn't trigger the menu for non-searchable selects.

### 3. Textarea answers are "yes" instead of paragraphs
`getSmartAnswer()` matches "Please describe your experience with clouds" to the generic "familiar with" Yes/No rule. Textareas need paragraph answers. Fix: check if the field is a `<textarea>` and skip Yes/No rules, route to AI instead.

### 4. Checkboxes not being auto-checked
Skills checkboxes (python, bash, docker, aws, k8s, golang, etc.) are detected but skipped. Need to auto-check checkboxes that match the user's known skills. Add a skills list to the profile and check matching checkboxes.

### 5. High school rationale gets "University of Ottawa"
The `getProfileValue()` match for "school" catches the textarea label "Please share your rationale or evidence for the high school performance" before `getSmartAnswer` can match it. Fix: make `getSmartAnswer` run BEFORE `getProfileValue` for textarea fields, or make the profile matching more strict.

### 6. Degree result gets "University of Ottawa" instead of "GPA 3.5/4.0"
Same issue as #5 — profile `school` field matches before the smart answer for degree result.

### 7. SDUI job scraping (LinkedIn new UI)
LinkedIn's `/jobs/search-results/` page doesn't use `<a>` tags for job list items. Only 2 `<a href="/jobs/view/...">` exist (selected job detail panel). The job list uses SDUI React components with no standard HTML links. Need to intercept LinkedIn's network requests from background.js to capture job list JSON, or use click-and-extract approach.

## User Profile (for form filling):
- Name: Fahad Aba-Alkhail
- Email: fk.abaalkhail@gmail.com (Greenhouse) / fahadabraar@gmail.com (LinkedIn)
- Phone: 6133168025
- City: Ottawa, Ontario, Canada
- School: University of Ottawa
- Degree: Bachelor's in Computer Science
- GPA: 3.5/4.0
- Skills: Python, JavaScript, React, Node.js, Docker, AWS, Bash, K8s, Git
- LinkedIn: https://www.linkedin.com/in/fk

## Key Files:
- `extension/content.js` — Main content script (7400+ lines), has autoFillExternalATS(), getSmartAnswer(), handleExternalSelects(), React-Select handler
- `extension/popup/popup.js` — Popup UI, scrapeFromPage(), fetchPendingJobs()
- `extension/popup/popup.html` — Popup HTML layout
- `extension/background.js` — Message routing, CORS relay
- `backend/routers/extension.py` — get_pending_jobs, save-batch, reclassify endpoints
- `backend/bot/linkedin_bot.py` — Guest API scraper, _scrape_linkedin, _fetch_descriptions

## UI IMPROVEMENTS REQUESTED:
- Replace dropdown filters (experience level, work type, posted within) with multi-select chip/pill boxes
- Allow selecting multiple experience levels (e.g., Entry + Mid-Senior)
- Make the popup UI sleek and modern — pill-style toggleable buttons instead of `<select>` dropdowns
- Auto-skip Workday jobs (OAuth wall can't be bypassed)
