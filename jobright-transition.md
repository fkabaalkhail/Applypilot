# ApplyPilot → Jobright-Style Chrome Extension Transition

## Overview

Transition ApplyPilot from a server-side Selenium bot architecture to a client-side Chrome extension that autofills job applications directly in the browser — similar to Jobright's extension (`odcnpipkhjegpefkfplmedhmkmmhmoko`).

---

## Current ApplyPilot Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  React UI   │────▶│ FastAPI      │────▶│ Selenium Bots   │
│  (frontend) │     │ (backend)    │     │ (headless)      │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │  Ollama AI  │
                    │  (local LLM)│
                    └─────────────┘
```

**Problems with current approach:**
- Selenium bots are fragile, slow, and detectable
- Requires server infrastructure (Docker, Redis, browser pools)
- Can't handle CAPTCHAs or 2FA naturally
- User must share credentials with the backend
- LinkedIn actively blocks bot traffic

---

## Target Architecture (Jobright-Style)

```
┌──────────────────────────────────────────────┐
│              Chrome Extension                  │
│  ┌────────────┐  ┌───────────┐  ┌─────────┐ │
│  │ Content    │  │ Background│  │ Popup   │ │
│  │ Scripts    │  │ Worker    │  │ UI      │ │
│  │ (filler)   │  │ (API hub) │  │ (React) │ │
│  └────────────┘  └───────────┘  └─────────┘ │
└──────────────────────┬───────────────────────┘
                       │ HTTPS
              ┌────────▼────────┐
              │  ApplyPilot API │
              │  (cloud/local)  │
              │  - AI answers   │
              │  - Fill rules   │
              │  - Resume store │
              └─────────────────┘
```

---

## What to Reuse from ApplyPilot

| Component | Reuse? | Notes |
|-----------|--------|-------|
| `backend/bot/ats_greenhouse.py` | ✅ Port logic | Field detection patterns → content script selectors |
| `backend/bot/ats_lever.py` | ✅ Port logic | Same — convert to DOM manipulation |
| `backend/bot/ats_workday.py` | ✅ Port logic | Workday needs React fiber injection (like Jobright) |
| `backend/bot/ats_ashby.py` | ✅ Port logic | Ashby uses custom React selects |
| `backend/bot/form_filler_selenium.py` | ✅ Core logic | Convert Selenium actions → native DOM events |
| `backend/services/ollama_service.py` | ✅ Keep as API | Move to cloud endpoint or keep local |
| `backend/bot/smart_filter.py` | ✅ Keep | Job matching logic stays server-side |
| `prompts/*` | ✅ Keep all | AI prompts for answers, cover letters, resume tailoring |
| `extension/content.js` | ✅ Expand | Already has ATS detection — build on this |
| `extension/background.js` | ✅ Expand | Already has message routing |
| `extension/popup/` | ✅ Redesign | Keep popup concept, modernize UI |
| `frontend/` | ❌ Replace | Dashboard moves into extension popup/options page |
| `backend/bot/linkedin_bot.py` | ❌ Drop | LinkedIn Easy Apply handled in-browser instead |
| `desktop/` | ❌ Drop | No longer needed — extension replaces it |
| `docker-compose.yml` | ❌ Drop | No server-side browser automation |

---

## Implementation Plan

### Phase 1: Extension Framework (Week 1-2)

1. **Migrate to Plasmo framework** (like Jobright uses)
   ```bash
   npm create plasmo -- --with-react --with-tailwindcss
   ```

2. **Set up manifest v3** with permissions:
   ```json
   {
     "permissions": ["storage", "tabs", "activeTab", "scripting"],
     "host_permissions": ["<all_urls>"],
     "background": { "service_worker": "background.js" },
     "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"] }]
   }
   ```

3. **Port ATS detection** from `extension/content.js` + `backend/bot/smart_filter.py`:
   - Supported sites registry (like Jobright's `SITE_REGISTRY`)
   - URL pattern matching with `@webext-core/match-patterns`

### Phase 2: Form Filling Engine (Week 3-4)

4. **Convert Selenium fill logic to DOM manipulation:**

   | Selenium (current) | Extension (target) |
   |--------------------|--------------------|
   | `driver.find_element(By.CSS_SELECTOR, sel)` | `document.querySelector(sel)` |
   | `element.send_keys(value)` | Native input events + React fiber setState |
   | `Select(element).select_by_value(v)` | Dispatch change events / React select injection |
   | `element.click()` | `element.click()` + synthetic events |
   | `WebDriverWait` | `MutationObserver` + polling |

5. **Implement React fiber injection** (critical for Workday, Greenhouse v2, Ashby):
   - Inject into MAIN world via `chrome.scripting.executeScript`
   - Find `__reactFiber$` keys on DOM elements
   - Call `setState` / `setValue` directly on React component instances

6. **Build TaskQueue + ProgressTracker** (like Jobright's `filler.js`):
   - Sequential async task execution
   - Real-time progress reporting to popup UI

### Phase 3: AI Integration (Week 5-6)

7. **Create lightweight API** (replace heavy FastAPI backend):
   - `POST /api/fill` — Given form fields + resume, return answers
   - `POST /api/tailor-resume` — Tailor resume for job
   - `POST /api/cover-letter` — Generate cover letter
   - Keep Ollama support for local/privacy-conscious users

8. **Port prompt templates** from `prompts/` directory:
   - `answer_question.txt` → API endpoint
   - `cover_letter.txt` → API endpoint
   - `tailor_resume.txt` → API endpoint

### Phase 4: Resume & Profile Management (Week 7-8)

9. **Chrome storage for user profile:**
   - Store autofill info (name, email, phone, work history)
   - Resume collection management
   - Encrypted credential storage via `backend/services/crypto.py` patterns

10. **Resume upload + parsing** in extension:
    - PDF parsing client-side or via API
    - Resume file injection into file inputs (intercept `HTMLInputElement.click()`)

### Phase 5: Polish & Ship (Week 9-10)

11. **Popup UI** (React + Tailwind in extension):
    - Login/signup flow
    - Profile editor
    - Fill progress overlay
    - Job match score display

12. **iframe support** — Many ATS embed forms in iframes:
    - Detect iframe sources matching ATS patterns
    - PostMessage communication between content scripts

---

## Key Technical Patterns from Jobright to Adopt

### 1. React Select Filling (Greenhouse, Ashby)
```javascript
// Inject into MAIN world, find React fiber, call setValue
function fillReactSelect(anchorSelector, candidates) {
  const el = document.querySelector(anchorSelector);
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
  let fiber = el[fiberKey];
  // Walk up fiber tree to find Select instance
  while (fiber) {
    if (fiber.stateNode?.setValue) {
      const options = fiber.memoizedProps?.options || [];
      const match = options.find(o => candidates.includes(o.label.toLowerCase()));
      if (match) fiber.stateNode.setValue(match, 'select-option');
      return;
    }
    fiber = fiber.return;
  }
}
```

### 2. Workday Date Filling
```javascript
// Workday uses custom React date components
// Must set state directly + fire change events
function fillWorkdayDate(containerSelector, { month, day, year }) {
  const container = document.querySelector(containerSelector);
  const inputs = container.querySelectorAll('input');
  inputs.forEach(input => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
```

### 3. File Input Interception (Resume Upload)
```javascript
// Override HTMLInputElement.click() to inject resume file
const originalClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function() {
  if (this.type === 'file' && pendingResumeFile) {
    const dt = new DataTransfer();
    dt.items.add(pendingResumeFile);
    this.files = dt.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  originalClick.call(this);
};
```

### 4. Message-Based Architecture
```javascript
// Content script → Background → API
// Use @plasmohq/messaging for type-safe messages
chrome.runtime.sendMessage({ name: 'getGptResults', body: { fields, url } });
```

---

## Files to Delete After Transition

```
backend/bot/linkedin_bot.py      # Replaced by in-browser filling
backend/bot/session_runner.py    # No more Selenium sessions
backend/services/browser_pool.py # No more browser pool
desktop/                         # Entire desktop app
docker-compose.yml               # No Docker needed
Dockerfile.*                     # No Docker needed
worker-entrypoint.sh             # No workers
nginx.conf                       # No reverse proxy
bot/easyapply.py                 # Old bot code
smart_form_filler.py             # Replaced by extension content script
test_easy_apply.py               # Old test
```

---

## Files to Keep & Adapt

```
backend/services/ollama_service.py  → API endpoint for AI answers
backend/bot/smart_filter.py         → Job matching logic (API)
backend/schemas/                    → API request/response types
prompts/                            → All prompt templates
extension/                          → Base to build on (expand significantly)
```

---

## New File Structure

```
applypilot/
├── extension/                    # Chrome extension (Plasmo)
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts         # Service worker
│   │   │   └── messages/        # Message handlers
│   │   ├── contents/
│   │   │   ├── filler.ts        # Form filling engine
│   │   │   ├── detector.ts      # ATS site detection
│   │   │   └── sites/           # Per-ATS fill strategies
│   │   │       ├── greenhouse.ts
│   │   │       ├── lever.ts
│   │   │       ├── workday.ts
│   │   │       ├── ashby.ts
│   │   │       └── linkedin.ts
│   │   ├── popup/               # React popup UI
│   │   └── utils/
│   ├── package.json
│   └── plasmo.config.ts
├── api/                          # Lightweight backend
│   ├── fill.py                  # AI answer generation
│   ├── resume.py                # Resume parsing & storage
│   └── prompts/                 # Prompt templates (moved from root)
└── README.md
```

---

## Competitive Advantages Over Jobright

| Feature | Jobright | ApplyPilot (target) |
|---------|----------|---------------------|
| AI Model | Proprietary (cloud-only) | Ollama local + cloud option |
| Privacy | All data sent to Jobright servers | Local-first, optional cloud |
| Pricing | Freemium with credits | Self-hosted option |
| Open Source | No | Yes |
| LinkedIn Easy Apply | No (separate product) | Yes (in-browser) |
| Custom prompts | No | User-editable prompts |
