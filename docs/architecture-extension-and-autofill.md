# Tailrd Extension — Architecture & Autofill Flow

**Last updated:** 2026-06-29
**Scope:** How the Chrome extension is structured and how the end-to-end autofill
process works — detection, matching, writing, reconciliation, and the AI-fill
backend. Grounded in the actual source (`chrome-extension/src/**`, `backend/routers/**`).

---

## 1. The three runtimes

```
┌─────────────────┐   sync/auth    ┌──────────────────────┐   reads      ┌──────────────────┐
│  Web app        │ ─────────────▶ │  Backend (FastAPI)   │ ◀─────────── │  Chrome extension│
│  www.tailrd.ca  │  source of     │  on Vercel + Neon DB │   /api/*     │  (this repo)     │
│  (React)        │  truth         │                      │              │                  │
└─────────────────┘                └──────────────────────┘              └──────────────────┘
```

- **Web app** is the **source of truth** for your profile, résumés, cover letters,
  settings. You edit there.
- **Backend** exposes `/api/*` (form-fill AI, sync snapshot, résumé/cover-letter
  generation, answers memory) and `/auth/*`.
- **Extension** never lets the page talk to the backend directly — it pulls a
  **synced snapshot** and fills forms locally.

---

## 2. The extension's internal parts (MV3)

Three contexts, strict separation of concerns:

| Part | File | Role |
|---|---|---|
| **Service worker** (background) | `background/serviceWorker.ts` | The **only** thing that talks to the backend. Owns auth, token refresh, sync, and every `/api` call. |
| **Content script** | `content/contentScript.ts` | Injected into **every frame**. Owns the DOM: scans for fields, fills them, mounts the UI. Never fetches. |
| **Overlay** (the real UI) | `content/overlay.ts` | A Shadow-DOM side panel the content script mounts in the **top frame**. (The toolbar `popup/` is legacy/unbuilt.) |

They talk via `chrome.runtime.sendMessage` (typed `BackgroundRequest` union in
`shared/types.ts`):

```
overlay (UI)  ──callback──▶  contentScript  ──sendMessage──▶  serviceWorker  ──authedRequest──▶  backend
   ▲                              │ owns DOM                      │ owns auth+sync
   └──────────────renders─────────┘                              └─ cached snapshot (offline)
```

---

## 3. Auth & sync (how the extension gets your data)

1. **Connect**: `CONNECT` → `api/handshake.ts:connectAccount()` runs a PKCE OAuth
   handshake on tailrd.ca, pinned to the extension ID. Tokens are stored by
   `api/client.ts`.
2. **Every backend call** goes through `client.ts:authedRequest`, which silently
   refreshes the access token and throws `AuthRequiredError` when it can't → the SW
   returns `{needsLogin:true}` → the overlay shows the reconnect view.
3. **Sync snapshot**: `GET /api/extension/sync` (`routers/extension.py`) returns one
   `ExtensionSyncSnapshot` — profile, résumés (+ which is active), **cover letters**,
   custom résumés, settings. `api/sync.ts` caches it so the extension works
   **offline**; `syncIfStale()` only re-pulls when the server's version bumps.

That snapshot's `profile.coverLetter` is the active cover-letter text — which is
exactly what the autofill engine pastes into cover-letter textareas.

---

## 4. The autofill pipeline — the heart of it

The autofill is built as **three layers** (the reconciler header literally calls
itself "the core engine"). Page load → scan → the user clicks **Autofill** → a
two-phase fill → continuous reconciliation.

### Layer A — Detection (`content/formScanner.ts`)

`scanPage(profile, fillEEO)` walks the DOM (`deepQueryAll` pierces shadow roots) and
for each candidate control:

- **Types it** (`controlTypeOf`): text / textarea / select / checkbox / radioGroup /
  file / contenteditable / customDropdown. Skips `hidden/submit/password/...`.
- **Excludes captcha** (`isCaptchaField`) — the engine fills *around* captchas, never
  touches or suspends on them.
- **Visibility filter** (relaxed for checkbox/radio/file that are styled-hidden but
  labeled).
- **Groups radios** into one logical field (by `form::name`).
- **Assigns a stable id** (`ensureFieldId` writes `FIELD_ID_ATTR` onto the element)
  prefixed with a per-frame `FRAME_TOKEN` — so ids survive re-scans and are unique
  across iframes.
- **Builds two things**: a serializable `DetectedField[]` (safe to send to the UI)
  and a `registry: Map<id, RuntimeControl>` (live DOM handles that **never leave the
  content script**).

A **debounced MutationObserver** (`observePage`) re-scans on SPA re-renders
(Workday/Ashby rebuild the DOM constantly).

### Field matching (`content/fieldMatcher.ts`)

For each field, `classifyField(signals)` turns label/placeholder/name/aria signals
into `{category, confidence, sensitive}` (e.g. `email`, `coverLetter`,
`resumeUpload`, EEO categories…). Then `resolveProfileValue(category, profile, …)`
computes the **proposedValue** from your synced profile (e.g. `coverLetter` →
`profile.coverLetter`, but only into long-text controls; EEO only when you've enabled
it). `proposedValue === null` means "profile can't answer this."

### Layer B — Writing (`content/writeEngine.ts`)

`writeControl(control, value)` knows how to write each control type (set `.value` +
dispatch the `input`/`change` events frameworks listen for; select/radio/checkbox via
`matchOption` fuzzy matching; contenteditable). It returns `{written, reason}`.
`verifyControl` reads the value **back**. This write+read-back is the correctness
primitive.

### Layer C — Reconciliation (`content/reconciler.ts` — `AutofillReconciler`)

This is what makes it robust on unstable pages. Filling is treated as **continuous
reconciliation, not a one-shot write**. Each field runs a state machine:

```
discovered → mapped → filled → verified → stable
                         ↘ drifted ↗  (reapply)
```

- `run(targets, registry)`: up to `maxCycles` (3) of {write each active field → wait
  a randomized **settle window** 300–800ms → `confirmStability`}. A field is only
  **`stable`** (=`ok`) once it *still* verifies after the settle window — timing backs
  up the observer, it is never the sole check.
- **Idempotent**: `fillOnce` verifies before writing, so re-running never corrupts a
  field.
- **Drift correction**: after the initial pass it keeps a background MutationObserver
  alive; if the page re-renders and a `stable` field no longer verifies,
  `reconcileNow` reverts it to `mapped` and refills — just that field, not a full
  rerun.
- One engine **per frame**, created on first fill (`getEngine()` in
  `contentScript.ts`).

### The two-phase fill (`contentScript.ts:onAutofill`)

When you click **Autofill** in the overlay (`overlay.ts:doAutofill` gathers the
selected field ids):

```
Phase 1 — LOCAL profile fill:
  selected fields with proposedValue !== null
    → engine.run(targets, registry)            // deterministic, offline, instant

Phase 2 — AI fill (best-effort, for what the profile couldn't answer):
  aiFillCandidates(fields)                      // eligible + empty + no proposed value
    → SW AI_FILL { fields, jobContext }         // jobContext from content/jobContext.ts
    → backend POST /api/fill                    // see §5
    → planAiFill(candidates, answers):
        • silent answers  → engine.addTargets() // filled in place (merges, keeps drift-tracking)
        • needsReview     → drafts returned to the overlay for Accept/Edit/Skip
  tallyOutcomes(localReports, aiReports)        // "12 of 15 filled"
```

`addTargets` (not `run`) is used in phase 2 so the AI pass doesn't wipe drift-tracking
of the phase-1 fields.

---

## 5. The AI-fill backend (`backend/routers/fill.py`)

`POST /api/fill` answers a batch of fields in **three escalating passes**, each
tagging a `source` (drives the UI badge) and a `needsReview` flag:

1. **Rule / profile** (`_rule_based_answer`) — fast deterministic answers for common
   screeners ("authorized to work?" → Yes; sponsorship → No; first name/email/phone
   from settings). `source:"rule"`, filled **silently**.
2. **Question Memory** (semantic reuse) — `canonicalize_question` + embeddings;
   `best_match` against your `SavedAnswer` rows. If score ≥ `MATCH_THRESHOLD`: a
   **generic** match fills silently (`source:"memory"`), but a **company-specific**
   match is flagged `needsReview` (so one company's answer isn't pasted blind into
   another's form).
3. **AI generation** — `llm.answer_question(question, context)` with résumé + job
   context; answers are matched to the field's options if any. `source:"ai"`, **always
   `needsReview`**, and **never auto-saved**.

The review drafts surface in the overlay as **Accept / Edit / Skip** cards. Accepting
calls `onInsertAnswer` (writes via `writeControl`) and `onSaveAnswer` →
`POST /api/answers` — the **only** write path into Question Memory, so it grows only
from answers you've approved.

---

## 6. End-to-end, in one sequence

```
1. You open a job application page.
2. contentScript loads in every frame; the top frame scans (scanPage).
   - Frame coordination: chrome.tabs.sendMessage broadcasts but resolves on the
     FIRST reply; frames WITH fields answer instantly, empty frames after a delay,
     so an embedded-iframe form wins over an empty top frame. FILL targets the
     owning frame because field ids carry its FRAME_TOKEN.
3. If ≥1 recognizable field, the overlay mounts (Shadow DOM side panel).
4. The overlay resolves your account → pushes the profile back → re-scan computes
   proposedValue for each field → the Autofill button enables with a count.
5. You click Autofill:
   • Phase 1 fills everything the profile knows (instant, offline).
   • Phase 2 asks the backend for the rest; silent answers fill, AI/company-specific
     answers become Accept/Edit/Skip drafts.
6. The reconciler keeps watching: if the ATS re-renders and a value drops, it refills
   just that field. Captchas are filled *around*, never blocked. Nothing is ever submitted.
```

---

## 7. Where résumé / cover-letter generation plug in

They reuse the **same plumbing** (overlay callback → SW message → `authedRequest` →
backend), as separate overlay sections:

- **Generate Custom Resume**: `TAILOR_RESUME` / `RENDER_RESUME` → tailored PDF attached
  to the résumé file field (`fileUpload.ts:injectResumeFile`, never submits).
- **Generate Cover Letter**: `GENERATE_COVER_LETTER` / `RENDER_COVER_LETTER` →
  smart-insert into the page's cover-letter **textarea** (`writeControl`) or, if it's a
  file field, an attached PDF; plus Copy / Download. Generation is **ephemeral** (it
  reuses `CoverLetterGenerator` but writes nothing to the DB).

---

## 8. The load-bearing design decisions

- **Never submit** — every action only fills/attaches; the user submits.
- **Fill around captcha** — captcha controls excluded at scan; the rest fills normally.
- **Idempotent reconciliation** — verify-before-write + drift correction beats SPA
  re-renders.
- **Ids on elements** — fills survive re-scans; per-frame tokens make iframes safe.
- **Offline-first** — the synced snapshot means autofill works without a live backend;
  only AI answers need the network.
- **Strict layering** — page DOM (content script) ⟂ network/auth (service worker), so
  the page can never reach your tokens or the backend.

---

## 9. File map (quick reference)

| Concern | File |
|---|---|
| Message hub, auth, sync, all `/api` calls | `chrome-extension/src/background/serviceWorker.ts` |
| Auth handshake / token refresh | `chrome-extension/src/api/{handshake,client}.ts` |
| Sync snapshot (cached, offline) | `chrome-extension/src/api/sync.ts` |
| DOM ownership, scan/fill orchestration | `chrome-extension/src/content/contentScript.ts` |
| Field detection + registry | `chrome-extension/src/content/formScanner.ts` |
| Field classification + profile value | `chrome-extension/src/content/fieldMatcher.ts` |
| Write + read-back primitives | `chrome-extension/src/content/writeEngine.ts` |
| Reconciliation state machine (core engine) | `chrome-extension/src/content/reconciler.ts` |
| AI-fill planning (longform/candidate/drafts) | `chrome-extension/src/content/aiFillPlanner.ts` |
| Job-context scraping | `chrome-extension/src/content/jobContext.ts` |
| File injection (résumé / cover-letter PDF) | `chrome-extension/src/content/fileUpload.ts` |
| Side-panel UI | `chrome-extension/src/content/overlay.ts` |
| AI form-fill endpoint (rule → memory → AI) | `backend/routers/fill.py` |
| Sync snapshot endpoint | `backend/routers/extension.py` |
| Saved-answer memory write path | `backend/routers/answers.py` |
