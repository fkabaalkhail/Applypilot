# User Story: Chrome Extension Transition to Autofill Model

**Assignee:** Wassim  
**Priority:** High  
**Sprint:** Next  

---

## Story

As a user, I want the ApplyPilot Chrome extension to autofill job applications directly on ATS pages (like Jobright does) instead of relying on a backend Selenium bot — so that filling is instant, undetectable, and works with my active browser session.

---

## Current State (What We Have)

The existing `extension/` folder has:
- `content.js` (262KB) — Detects ATS pages, communicates with backend
- `background.js` (20KB) — Routes messages between content script and API
- `popup/` — Basic popup UI (HTML/CSS/JS)
- `manifest.json` — MV3 manifest

**Problem:** The extension currently just detects pages and sends URLs to the backend bot. The actual form filling happens server-side via Selenium — which is slow, fragile, and detectable.

---

## Target State (What We Want)

A Jobright-style extension that:
1. Detects supported ATS pages (Greenhouse, Lever, Workday, Ashby, etc.)
2. Injects a floating overlay panel on the page
3. Fills forms **client-side** using DOM manipulation + React fiber injection
4. Shows real-time progress (field-by-field)
5. Calls our API only for AI-generated answers

---

## Architecture Change

```
BEFORE:
Extension → detects page → sends URL to backend → Selenium fills remotely

AFTER:
Extension → detects page → shows overlay → calls API for answers → fills DOM directly
```

---

## Implementation Tasks

### Phase 1: Framework Migration
- [ ] Migrate from raw JS to **Plasmo** framework (TypeScript + React)
- [ ] Set up content script UI (floating overlay panel)
- [ ] Keep existing ATS detection logic, port to TypeScript

### Phase 2: Form Filling Engine
- [ ] Port `backend/bot/ats_greenhouse.py` selectors → `sites/greenhouse.ts`
- [ ] Port `backend/bot/ats_lever.py` → `sites/lever.ts`
- [ ] Port `backend/bot/ats_workday.py` → `sites/workday.ts` (needs React fiber injection)
- [ ] Port `backend/bot/ats_ashby.py` → `sites/ashby.ts`
- [ ] Build `TaskQueue` for sequential field filling
- [ ] Build `ProgressTracker` for real-time status

### Phase 3: Overlay UI
- [ ] Floating panel with states: INITIAL → FILLING → FILLED → FAILED
- [ ] Resume picker dropdown
- [ ] "Autofill" primary button
- [ ] Field status list (✅ filled, ❌ missing)
- [ ] "Ask AI" per-field answer regeneration
- [ ] Settings (auto-fill after page turn, hide on site)

### Phase 4: API Integration
- [ ] `POST /api/fill` — Send form fields, get AI answers back
- [ ] `POST /api/resume` — Get resume blob for file upload
- [ ] File input interception (inject resume into file pickers)
- [ ] Cover letter generation endpoint

---

## Key Technical Patterns to Implement

### 1. React Fiber Injection (for Workday, Greenhouse v2, Ashby)
```typescript
// Inject into MAIN world to access React internals
chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  func: injectReactSelectFiller,
  world: "MAIN"
});
```

### 2. Native Input Events (for standard forms)
```typescript
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
setter.call(input, value);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

### 3. File Input Interception (resume upload)
```typescript
// Override click to inject resume file
HTMLInputElement.prototype.click = function() {
  if (this.type === 'file' && pendingResume) {
    const dt = new DataTransfer();
    dt.items.add(pendingResume);
    this.files = dt.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  originalClick.call(this);
};
```

---

## Target File Structure

```
extension/
├── src/
│   ├── background/
│   │   ├── index.ts              # Service worker
│   │   └── messages/             # API message handlers
│   ├── contents/
│   │   ├── overlay.tsx           # Floating panel UI (Plasmo CSUI)
│   │   ├── filler.ts            # Form filling engine
│   │   ├── detector.ts          # ATS site detection
│   │   ├── progress.ts          # TaskQueue + ProgressTracker
│   │   └── sites/               # Per-ATS strategies
│   │       ├── greenhouse.ts
│   │       ├── lever.ts
│   │       ├── workday.ts
│   │       ├── ashby.ts
│   │       └── linkedin.ts
│   ├── popup/
│   │   └── index.tsx            # Popup UI (profile, settings)
│   └── utils/
│       ├── dom-events.ts        # Native event dispatching
│       └── fiber-inject.ts      # React fiber manipulation
├── package.json
├── tsconfig.json
└── plasmo.config.ts
```

---

## Acceptance Criteria

- [ ] Extension loads on Greenhouse job application pages
- [ ] Floating overlay appears with "Autofill" button
- [ ] Clicking "Autofill" fills text inputs with test data
- [ ] Progress shows field-by-field status
- [ ] Resume file is injected into file upload inputs
- [ ] React select dropdowns are filled via fiber injection
- [ ] Multi-page forms auto-continue after page turn
- [ ] No Selenium/backend bot involved in the fill process

---

## What to Delete After Transition

```
backend/bot/linkedin_bot.py         # No more remote bot
backend/bot/session_runner.py       # No more Selenium sessions
backend/services/browser_pool.py    # No more browser pool
desktop/                            # Electron app no longer needed
docker-compose.yml                  # No Docker for bot infra
Dockerfile.*                        # No Docker
worker-entrypoint.sh                # No workers
```

---

## Reference

See `jobright-transition.md` and `jobright-frontend-copy.md` in this repo for the full Jobright reverse-engineering analysis including their exact supported sites list, API patterns, and UI component structure.

---

## Notes

- Jobright uses Plasmo + Parcel + React + lodash-es + nanoid
- They support 50+ ATS platforms — we start with top 5 (Greenhouse, Lever, Workday, Ashby, LinkedIn)
- Our advantage: local AI (Ollama) option + open source + no credit system
