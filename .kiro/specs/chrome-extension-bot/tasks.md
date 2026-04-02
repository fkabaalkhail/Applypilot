# Implementation Plan: Chrome Extension Bot

## Overview

Build a Chrome Manifest V3 extension that autofills job application forms across LinkedIn and external ATS sites (Greenhouse, Lever, Workday, JazzHR). The implementation ports form-filling logic from `smart_form_filler.py` and mirrors patterns from the AutoApplyMax reference extension, adding ATS detection, iframe support, dark-themed UI, and optional backend AI integration.

## Tasks

- [x] 1. Extension skeleton — manifest, background, empty content script, popup shell
  - [x] 1.1 Create `extension/manifest.json` with Manifest V3 structure
    - Permissions: `storage`, `activeTab`, `scripting`, `tabs`
    - Host permissions for LinkedIn, Greenhouse, Lever, Workday, JazzHR, and localhost backend
    - Content script matching all ATS URLs with `"all_frames": true` and `"run_at": "document_idle"`
    - Background service worker pointing to `background.js`
    - Action popup pointing to `popup/popup.html`
    - Icon entries for 16, 48, 128px
    - _Requirements: Design §1 (manifest.json)_

  - [x] 1.2 Create `extension/background.js` service worker
    - `onInstalled` listener initializing `chrome.storage.local` with default state: `isRunning: false`, `appliedCount: 0`, `skippedCount: 0`, `appliedJobs: []`, `mode: "autofill"`
    - Message listener for `incrementCount`, `incrementSkippedCount`, `setRunning` (mirror AutoApplyMax `background.js`)
    - Placeholder handler for `askAI` messages (to be implemented in task 7)
    - _Requirements: Design §4 (Background Service Worker)_

  - [x] 1.3 Create `extension/content.js` with message listener skeleton
    - Set up `chrome.runtime.onMessage` listener accepting `autofill`, `autoapply`, `detect`, `getStatus` actions
    - Stub functions: `detectATS()`, `extractFields()`, `autofill()`, `autoapply()`
    - Add `log()` helper (console + `chrome.runtime.sendMessage` for status)
    - Add `wait(ms)` helper returning a Promise
    - Add `fill(input, value)` helper dispatching `input` and `change` events (from AutoApplyMax pattern)
    - _Requirements: Design §2 (Content Script)_

  - [x] 1.4 Create `extension/popup/popup.html` with basic shell
    - HTML boilerplate with charset, viewport, link to `popup.css` and `popup.js`
    - Container div with header (extension name, version badge), empty tab bar, empty tab content areas
    - _Requirements: Design §3 (Popup UI)_

  - [x] 1.5 Create `extension/popup/popup.css` with dark theme base
    - CSS variables: `--bg-primary: #26265D` (Coronation Blue), `--accent: #B09255` (Matte Bronze), `--bg-surface: #1E1E4A`, `--text-primary: #E8E8F0`, `--text-secondary: #A0A0C0`
    - Body/container styles with dark background, light text
    - Basic layout: 400px width, padding, font-family
    - _Requirements: Design §3 (Popup UI), user design choices (dark theme)_

  - [x] 1.6 Create `extension/popup/popup.js` with DOMContentLoaded skeleton
    - Load config from `chrome.storage`, setup tab switching, setup auto-save
    - Stub functions for start/stop button handlers
    - _Requirements: Design §3 (Popup UI)_

  - [x] 1.7 Create `extension/icons/` directory with placeholder icon files
    - Create a simple SVG-based icon or placeholder PNGs at 16x16, 48x48, 128x128
    - _Requirements: Design §1 (manifest.json icons)_

- [x] 2. Checkpoint — Load extension in Chrome
  - Load `extension/` as unpacked extension in `chrome://extensions`
  - Verify popup opens, background script initializes, content script loads on LinkedIn
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Popup UI — dark theme with all 4 tabs, auto-save, profile fields
  - [x] 3.1 Implement tab navigation in `popup.html` and `popup.js`
    - Four tabs: Dashboard, Personal Info, Settings, Applied Jobs (from Design §3)
    - Tab switching logic: add/remove `.active` class on tab buttons and content panels
    - Style active tab with `--accent` border-bottom
    - _Requirements: Design §3 (Popup UI tabs)_

  - [x] 3.2 Build Dashboard tab
    - Status card showing: ATS type badge (placeholder), running status, applied count, skipped count
    - Three action buttons: "Autofill" (fill only), "Autoapply" (fill + submit), "Stop"
    - Wire Start/Stop to send messages to content script via `chrome.tabs.sendMessage`
    - Inject content script on-demand via `chrome.scripting.executeScript` when user clicks Start (AutoApplyMax pattern)
    - Listen for `updateCount`, `updateSkippedCount`, `botStarted`, `botStopped` messages from content script
    - _Requirements: Design §3 (Dashboard tab)_

  - [x] 3.3 Build Personal Info tab
    - Form fields: firstName, lastName, email, phone (with country code select), city, state, postal, country, linkedinUrl, website
    - Resume/CV file upload with base64 storage (port from AutoApplyMax `popup.js` `setupResumeUpload`)
    - Country code dropdown with grouped optgroups (port from AutoApplyMax `popup.html`)
    - _Requirements: Design §5 (Storage Schema — profile)_

  - [x] 3.4 Build Settings tab
    - Backend API URL input (default `http://localhost:8000`)
    - AI toggle checkbox (default off)
    - Prefilled Q&A editor: list of question/answer pairs with add/remove buttons
    - Common application questions: visa sponsorship, work authorization, willing to relocate, driver's license (select yes/no)
    - Blacklist keywords input, max years required input, expected salary input
    - _Requirements: Design §5 (Storage Schema — settings)_

  - [x] 3.5 Build Applied Jobs tab
    - Scrollable list rendering applied jobs from `chrome.storage.local`
    - Each job card: title, company, URL link, timestamp, status badge, field counts
    - Clear All button, Export CSV button
    - Empty state with icon and message
    - _Requirements: Design §5 (Storage Schema — appliedJobs)_

  - [x] 3.6 Implement auto-save on all form fields
    - Debounced save (500ms) on input events for text fields
    - Immediate save on change events for selects and checkboxes
    - Auto-save indicator ("Saved" toast) — port from AutoApplyMax `popup.js`
    - _Requirements: Design §5 (Storage Schema)_

  - [x] 3.7 Style all tabs with dark theme CSS
    - Input fields: dark surface background, light text, accent border on focus
    - Buttons: accent color primary, danger red for stop, muted for secondary actions
    - Status badges: green for running, red for stopped, accent for ATS type
    - Toggle switches, file upload area, job cards — all dark themed
    - _Requirements: User design choices (Matte Bronze accent, Coronation Blue primary)_

  - [x] 3.8 Write unit tests for popup auto-save and tab switching logic
    - Test that tab switching shows/hides correct panels
    - Test that auto-save debounce fires after 500ms
    - _Requirements: Design §3_

- [x] 4. Content script — ATS detection and form field extraction
  - [x] 4.1 Implement `detectATS(url)` function in `content.js`
    - Port `ATS_PATTERNS` from design: linkedin, greenhouse, lever, workday, jazzhr regex patterns
    - Return `ATSType` string or `"generic"` fallback
    - _Requirements: Design §2 (ATS Detection Patterns)_

  - [x] 4.2 Implement `getLabel(el)` multi-strategy label detection
    - Strategy order: `label[for]` → `aria-label` → `aria-labelledby` → `placeholder` → parent `<label>` → closest form group label/span → preceding sibling text
    - Port from `smart_form_filler.py` `_getLabel` JS and AutoApplyMax's inline label detection
    - _Requirements: Design §2 (getLabel function)_

  - [x] 4.3 Implement `extractFields(root)` to extract all visible form fields
    - Scope to modal (`.jobs-easy-apply-modal`) on LinkedIn, or full page on external ATS
    - Extract: text/email/tel/number/url inputs, textareas, selects, radio groups, checkboxes, file inputs
    - Use `getBoundingClientRect()` to skip hidden fields
    - Return array of `FormField` objects with type, label, value, id, name, required, options
    - Port field extraction JS from `smart_form_filler.py` `EXTRACT_FIELDS_JS`
    - _Requirements: Design §2 (extractFields)_

  - [x] 4.4 Implement `extractFieldsFromIframes()` for iframe form filling
    - Enumerate all iframes in the page
    - For same-origin iframes: access `contentDocument` and call `extractFields`
    - For cross-origin: log warning (cannot access)
    - Merge iframe fields with main page fields
    - `all_frames: true` in manifest handles content script injection into iframes
    - _Requirements: Design §2 (extractFieldsFromIframes), user design choices (iframe support)_

  - [x] 4.5 Write property test for ATS detection
    - **Property 1: ATS detection is deterministic** — same URL always returns same ATS type
    - **Validates: Design §2 (ATS Detection Patterns)**

- [x] 5. Content script — form field filling (profile mapping + prefilled answers)
  - [x] 5.1 Implement `FIELD_MAP` and `getProfileValue(label, profile)` in `content.js`
    - Port `FIELD_MAP` from `smart_form_filler.py` into JavaScript object
    - Three-pass matching: exact match → key-in-label (longer keys first) → label-in-key
    - Support callable entries for computed values (full name)
    - _Requirements: Design §2 (FIELD_MAP, getProfileValue)_

  - [x] 5.2 Implement `matchPrefilled(label, prefilled)` for fuzzy Q&A matching
    - Case-insensitive bidirectional substring matching (question in label OR label in question)
    - Port from `smart_form_filler.py` `_match_prefilled`
    - _Requirements: Design §2 (matchPrefilled)_

  - [x] 5.3 Implement `fillField(field, value)` for text inputs and textareas
    - Use `fill(input, value)` pattern from AutoApplyMax: set `.value`, dispatch `input` + `change` events
    - Add `setReactValue(el, value)` using native setter: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
    - Dispatch `input`, `change`, `blur` events with `{bubbles: true}`
    - _Requirements: Design §2 (fillField, setReactValue)_

  - [x] 5.4 Implement `autofill(profile, settings, prefilled)` orchestrator
    - Call `detectATS()` → `extractFields()` → for each empty field: try `getProfileValue` → try `matchPrefilled` → try AI (if enabled) → fill
    - Track filled/skipped/failed counts
    - Return `FillResult` object to popup
    - _Requirements: Design §2 (autofill orchestrator)_

  - [x] 5.5 Write property test for profile value matching
    - **Property 2: Profile mapping prefers exact matches over substring matches**
    - **Validates: Design §2 (getProfileValue)**

  - [x] 5.6 Write unit tests for FIELD_MAP matching
    - Test exact match: "email" → email value
    - Test substring match: "Your email address" → email value
    - Test computed value: "full name" → firstName + lastName
    - Test no match returns null
    - _Requirements: Design §2 (FIELD_MAP)_

- [x] 6. Checkpoint — Test form filling on LinkedIn
  - Navigate to a LinkedIn Easy Apply job, click Autofill, verify fields populate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Content script — typeahead, radio, select, file upload, checkbox handling
  - [x] 7.1 Implement `handleTypeahead(el, value)` for city/location autocomplete
    - Type value into input, wait 1s for dropdown
    - Search for `[role="listbox"]` with multiple fallback selectors (port from AutoApplyMax)
    - Click first `[role="option"]` or use ArrowDown+Enter keyboard fallback
    - _Requirements: Design §2 (handleTypeahead)_

  - [x] 7.2 Implement radio button handling
    - Find `fieldset[data-test-form-builder-radio-button-form-component]` groups
    - Smart detection: visa sponsorship, work authorization, relocation, driver's license, security clearance
    - Match user's configured yes/no answers from settings
    - Multilingual yes/no matching (EN/FR/ES/DE/IT) — port from AutoApplyMax
    - Default to "Yes" if no specific match, fallback to first option
    - _Requirements: Design §2 (fillField for radio)_

  - [x] 7.3 Implement select dropdown handling (native + custom LinkedIn)
    - Native `<select>`: set `.value` and dispatch `change` event
    - Custom LinkedIn dropdowns (`button[aria-haspopup="listbox"]`): click to open, find `[role="listbox"]`, click matching `[role="option"]`
    - Smart language proficiency detection: prefer Native/Bilingual → Fluent → Professional
    - Skip "Select..." placeholder options
    - _Requirements: Design §2 (fillField for select)_

  - [x] 7.4 Implement file upload handling
    - Resume selection: check for existing uploaded resumes first (radio buttons, clickable cards) — port from AutoApplyMax
    - File upload: convert base64 resume from storage to File via `DataTransfer` API
    - `new DataTransfer(); dt.items.add(file); fileInput.files = dt.files;` then dispatch `change`
    - Only upload to inputs matching resume/CV labels
    - _Requirements: Design §2 (fillField for file)_

  - [x] 7.5 Implement checkbox handling (consent, terms, agreements)
    - Auto-check checkboxes with labels matching consent/agree/terms/policy patterns
    - Skip "follow company" checkbox (uncheck it before submit, like AutoApplyMax)
    - Multilingual pattern matching
    - _Requirements: Design §2 (fillField for checkbox)_

  - [x] 7.6 Write unit tests for typeahead and radio handling
    - Test typeahead dropdown selection flow
    - Test radio button smart detection for visa/authorization questions
    - _Requirements: Design §2_

- [x] 8. Content script — multi-step navigation (autoapply mode)
  - [x] 8.1 Implement Next/Submit button detection and clicking
    - Find buttons by text content: `next`, `suivant`, `review`, `submit`, `soumettre` (port from AutoApplyMax)
    - Detect submit vs next: check if text includes `submit`/`soumettre`
    - Before submit: unfollow company checkbox handling
    - Check button disabled state, skip if `aria-disabled="true"`
    - _Requirements: Design §2 (autoapply flow)_

  - [x] 8.2 Implement multi-step form loop with timeout and stuck detection
    - Step loop (max 10 steps per application, 3-minute timeout)
    - On each step: fill fields → find Next/Submit → click → wait for page change
    - Stuck detection: no activity for 2 minutes → refresh page
    - Loading screen detection: spinners, progressbars → wait up to 20s then discard
    - Validation error detection: `[role="alert"]`, `.artdeco-inline-feedback--error` → discard application
    - _Requirements: Design §2 (autoapply orchestrator)_

  - [x] 8.3 Implement discard application logic
    - Close modal: X button (`button[aria-label*="Dismiss"]`) → ESC key → find discard/cancel buttons
    - Confirm discard in confirmation dialog
    - Verify modal closed after each attempt
    - Port from AutoApplyMax `discardApplication()`
    - _Requirements: Design §2 (error recovery)_

  - [x] 8.4 Implement Done/completion button handling after submit
    - Search for Done/Dismiss/Close buttons after successful submit
    - Multiple click methods: standard click → MouseEvent dispatch → keyboard Enter
    - Handle "Application sent" confirmation modal
    - Port from AutoApplyMax `findAndClickDoneButton()`
    - _Requirements: Design §2 (post-submit flow)_

  - [x] 8.5 Implement main autoapply loop (job list iteration + pagination)
    - Iterate `li[data-occludable-job-id]` job cards on LinkedIn
    - For each: scroll into view → click → find Easy Apply button → open modal → fill + navigate steps
    - Track applied/skipped counts, save applied jobs to storage
    - Blacklist keyword filtering and experience year filtering
    - Daily limit detection (port from AutoApplyMax `checkDailyLimit()`)
    - Page navigation: pagination buttons or infinite scroll for collections pages
    - _Requirements: Design §2 (LinkedIn autoapply)_

  - [x] 8.6 Write unit tests for button detection and step navigation
    - Test Next/Submit button text matching
    - Test discard flow with mock DOM
    - _Requirements: Design §2_

- [x] 9. Checkpoint — Test autoapply on LinkedIn
  - Test full autoapply flow: job iteration, form filling, multi-step navigation, submit
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. ATS detection and external site support
  - [x] 10.1 Implement Greenhouse form filling
    - Detect via `boards.greenhouse.io` URL pattern
    - Extract fields from Greenhouse's standard form layout
    - Handle Greenhouse-specific field selectors and form structure
    - _Requirements: Design §2 (ATS detection — greenhouse)_

  - [x] 10.2 Implement Lever form filling
    - Detect via `jobs.lever.co` URL pattern
    - Extract fields from Lever's application form
    - Handle Lever-specific field structure
    - _Requirements: Design §2 (ATS detection — lever)_

  - [x] 10.3 Implement Workday form filling
    - Detect via `myworkdayjobs.com` URL pattern
    - Handle Workday's complex multi-page form structure
    - Handle iframe-embedded forms
    - _Requirements: Design §2 (ATS detection — workday)_

  - [x] 10.4 Implement JazzHR form filling
    - Detect via `applytojob.com` URL pattern
    - Handle JazzHR's iframe-based forms (use `extractFieldsFromIframes`)
    - Use `sendKeys`-style filling for React compatibility
    - _Requirements: Design §2 (ATS detection — jazzhr)_

  - [x] 10.5 Implement generic fallback form filling
    - For unrecognized ATS: extract all visible form fields from page
    - Apply same profile mapping and prefilled answer logic
    - _Requirements: Design §2 (ATS detection — generic)_

  - [x] 10.6 Write unit tests for ATS-specific form extraction
    - Test Greenhouse field extraction with mock DOM
    - Test Lever field extraction with mock DOM
    - _Requirements: Design §2_

- [x] 11. Backend API integration for AI answers (optional)
  - [x] 11.1 Implement `askAI` message handler in `background.js`
    - Receive `{action: "askAI", question, options, resumeText, jobDescription}` from content script
    - `fetch()` to backend API at `${backendUrl}/api/ai/answer`
    - Return `{answer, error}` response to content script
    - Handle network errors, timeouts, backend unavailable gracefully
    - _Requirements: Design §4 (Background Service Worker — AI relay)_

  - [x] 11.2 Integrate AI fallback into content script fill flow
    - In `autofill()`: after profile mapping and prefilled answers fail, if `settings.aiEnabled`:
      - Send field label + options to background worker via `chrome.runtime.sendMessage({action: "askAI", ...})`
      - Await response, fill field with AI answer
    - For select/radio fields: send options list, pick best matching option from AI response
    - _Requirements: Design §2 (AI fallback in autofill orchestrator)_

  - [x] 11.3 Write unit tests for AI integration
    - Test AI request message format
    - Test graceful fallback when backend is unavailable
    - _Requirements: Design §4_

- [x] 12. Toast notifications and status updates
  - [x] 12.1 Implement toast notification system in popup
    - Create `showToast(message, type, duration)` function (port from AutoApplyMax `popup-improvements.js`)
    - Types: success (green), error (red), warning (amber), info (blue) — styled with dark theme
    - Slide-in animation, auto-dismiss, close button
    - CSP-compliant (no inline event handlers)
    - _Requirements: Design §3 (Popup UI feedback)_

  - [x] 12.2 Implement field validation in popup
    - Validators for email, phone, firstName, lastName, yearsOfExper ience
    - Show inline error messages on blur, clear on focus
    - Validate all fields before starting bot
    - Port validation patterns from AutoApplyMax `popup-improvements.js`
    - _Requirements: Design §3 (Popup UI validation)_

  - [x] 12.3 Implement real-time status updates from content script to popup
    - Content script sends: `updateCount`, `updateSkippedCount`, `botStarted`, `botStopped`, `atsDetected`, `fillResult`
    - Popup listens via `chrome.runtime.onMessage` and updates Dashboard tab
    - Poll `chrome.storage.local` every 2s as fallback (popup may reopen after close)
    - _Requirements: Design §3 (Dashboard tab), Design message protocol_

  - [x] 12.4 Write unit tests for toast and validation
    - Test toast creation and auto-dismiss
    - Test email/phone validation patterns
    - _Requirements: Design §3_

- [x] 13. Final checkpoint — Full integration test
  - Load extension in Chrome, verify all tabs render correctly with dark theme
  - Test Autofill on LinkedIn Easy Apply form
  - Test Autoapply flow end-to-end on LinkedIn
  - Test on at least one external ATS (Greenhouse or Lever)
  - Verify applied jobs tracking and CSV export
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific design sections for traceability
- Checkpoints ensure incremental validation at key milestones
- The extension directory is `extension/` at project root
- AutoApplyMax reference code in `reference/AutoApplyMax/` should be consulted during implementation
- All code is JavaScript (Manifest V3 Chrome Extension)
