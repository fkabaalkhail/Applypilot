# Tailrd Extension — AI Features: Map + Feature A Design

**Date:** 2026-06-28
**Status:** Feature A design approved; Features B & C summarized (each gets its own spec)

## 1. Context & scope

The Tailrd Chrome extension (`chrome-extension/`, MV3, v0.3.0) detects job-application
forms and autofills them from the user's Tailrd profile. The dashboard (`frontend/`) and
backend (`backend/`, FastAPI) already provide a rich AI feature set. This effort brings AI
into the extension and fixes a live autofill bug.

Three features were requested. Inspection showed **most of the backend already exists**, so
the work is mostly extension-side wiring plus thin additions. The features are separable and
are built in sequence **A → B → C**.

### Foundation that already exists (reused by all three)

- **Backend AI layer:** `AnthropicService` (`backend/services/anthropic_service.py`) via
  `get_llm_service()`; methods include `edit_snippet`, `answer_question`,
  `generate_cover_letter`, `tailor_resume`.
- **AI endpoints (mounted in `backend/main.py`):**
  - `POST /api/fill` (`routers/fill.py`, mounted `prefix="/api"` at `main.py:79`) —
    rule-based + AI answers for a batch of form fields, with option-matching; pulls the
    user's resume from the DB. **Currently unused by the extension.**
  - `POST /ai/edit-snippet` (`routers/ai.py`) — per-snippet rewrite
    (rewrite/shorten/expand/professional/ats/impact/grammar); powers the dashboard's
    `AiAssistTextarea.tsx`.
  - `POST /ai/cover-letter/{job_id}` (`routers/ai.py`) wrapping
    `CoverLetterGenerator.generate(resume_text, job_description, company, tone, base_text)`
    (`services/cover_letter.py`) — raw-text based; only the route wrapper requires a job_id.
- **Extension ↔ backend plumbing:**
  `overlay → sendToBackground → serviceWorker case → api/client.authedRequest → backend`.
  `api/client.ts` handles auth + silent token refresh-on-401. Base URL `https://www.tailrd.ca`.
- **Extension fill engine:** `formScanner` (detect + categorize) →
  `fieldMatcher.resolveProfileValue` (local profile map) → `reconciler`
  (write/verify/stabilize state machine) → `writeEngine` (typed control writes). Field
  categories include `workAuthorization`, `sponsorship`, `coverLetter`, `unknown`.

### Feature summary

| | A — Autofill fix + AI fill | B — Cover letter | C — Resume rewrite in extension |
|---|---|---|---|
| Urgency | Live bug | Stubbed "Coming soon" | Net-new |
| Backend change | **None** (`/api/fill` exists) | Thin job-id-less route | **None** (`/ai/edit-snippet` exists) |
| Main work | Extension | Extension + 1 route | Extension (new editor UI) |
| Depends on | — | A (jobContext, AI plumbing) | A (plumbing) |

**Sequence A → B → C.** A fixes a live defect, reuses existing backend, and builds the
`jobContext` scraper + extension→AI pattern that B and C both reuse.

---

## 2. Feature A — Autofill bug fix + AI-assisted fill

### 2.1 Problems
1. **Scroll-jump bug (confirmed symptom):** during autofill the viewport repeatedly
   scrolls/snaps to fields.
2. **No AI fill:** fields the local profile can't answer — screening questions and long-form
   essays ("why do you want to work here") — are left blank. The extension never calls
   `/api/fill`.

### 2.2 Confirmed root cause (bug)
There is **no `scrollIntoView`** anywhere in the extension (verified by grep). `writeControl()`
calls `el.focus()` at `writeEngine.ts:66` (text), `:77` (select), `:104` (contenteditable).
`.focus()` auto-scrolls the element into view by default. The reconciler re-focuses on every
write and on every retry of a field that won't verify (e.g., masked/reformatted inputs), so
the viewport yanks repeatedly. The double-click race is **already prevented** by
`overlayState.busy` in `doAutofill()` (`overlay.ts:1104`).

### 2.3 Goals / non-goals
- **Goals:** autofill never scrolls the page; unanswered screening questions fill inline via
  AI; long-form essays are drafted by AI and surfaced for user review/edit *before* insertion
  (the user stays accountable for essay content).
- **Non-goals:** changing the reconciler's correctness model; auto-submitting; resume editing
  (Feature C); any backend change.

### 2.4 Bug fix
Add `{ preventScroll: true }` to the three `.focus()` calls in `writeEngine.ts`
(`writeTextLike`, `writeSelect`, `writeContentEditable`). Focus still fires (frameworks still
register the input); the browser just stops scrolling. No other behavior changes.

### 2.5 AI-assisted fill — architecture (Approach 1: additive second pass)
Local-profile fill is unchanged. A second phase runs after it, inside the same
`overlayState.busy` window that already guards re-entry.

```
doAutofill()                          [overlay; run guard via overlayState.busy already exists]
 └─ onAutofill(selectedIds)           [contentScript overlayCallbacks]
     1. local pass → reconciler.run(targets that have a profile proposedValue)   (unchanged)
     2. collect candidates: fillable fields where proposedValue===null OR report.ok===false
     3. classify each candidate → "simple" | "longform"
     4. jobContext = extractJobContext()                                          (new)
     5. send {type:"AI_FILL", fields, jobContext} → serviceWorker
            serviceWorker → api.authedRequest("/api/fill", POST
              {fields, resumeText:"", jobDescription, jobTitle, company})
            backend: rule-based → Claude → option-match; resume pulled from DB
            response: { answers: [{id, label, answer, confidence}], errors: [] }
     6. simple answers   → reconciler.run (inline; preventScroll fix applies)
     7. longform answers → returned to the overlay as drafts (NOT auto-inserted)
 └─ returns { ok, fail, total, drafts: {fieldId, label, value}[] }
```

### 2.6 Field classification (client-side)
From `DetectedField.controlType` + label/category:
- **longform** if `controlType` is `textarea` or `contenteditable`; OR label/placeholder
  matches `/why|describe|tell us|tell me|explain|cover letter|in your own words/i`; OR a
  textarea with large `rows`.
- **simple** otherwise (short text, select, radio, checkbox) — screening-type questions.
- `file` / `customDropdown` candidates are excluded (not AI-fillable here).
- **EEO/demographic fields are excluded from AI fill unless the existing `fillEEO` opt-in is
  on.** AI must never guess gender/race/veteran/disability answers; this mirrors the local
  pass, which already gates EEO categories behind `lastFillEEO` (`contentScript.ts`).

Mapping to backend `FormField`: `{ id: fieldId, label, type: controlType → one of
text|textarea|select|radio|checkbox (radioGroup→radio, contenteditable→textarea),
options: from the registry control, required }`.

### 2.7 Job context extraction — `content/jobContext.ts` (new; shared with Feature B)
`extractJobContext(): { jobDescription: string; jobTitle: string; company: string }`
- **jobDescription:** first match of common containers
  (`[class*="job-description" i]`, `[class*="description" i]`, `<article>`, `[role="main"]`),
  else the largest visible text block (element with the most text content above a length
  threshold, excluding nav/footer/script). Truncated to a sane cap.
- **jobTitle:** `h1`, `[class*="title" i]`, or `document.title`.
- **company:** reuse any company the form scanner detected; else `og:site_name` / hostname;
  else `""`.
- **Failure-tolerant:** returns empty strings rather than throwing. AI fill still works
  without a JD (lower quality), matching `/api/fill`'s optional fields.

### 2.8 Overlay long-form review UX — `content/overlay.ts`
- Extend `OverlayCallbacks.onAutofill` return to `{ ok, fail, total, drafts }`.
- Add `OverlayCallbacks.onInsertAnswer(fieldId, value): Promise<{ ok: boolean; reason?: string }>`
  in contentScript. It must insert **without resetting the reconciler** — `reconciler.run()`
  rebuilds its `states` map from the passed targets, which would drop background drift-tracking
  of the already-filled fields. Use a non-disruptive path: either a one-shot
  `writeControl` + `verifyControl` (essays in textareas rarely drift), or a new reconciler
  method that merges a single target into the existing `states`. `preventScroll` applies.
- New `renderReviewSection(drafts)` rendered under the banner: per draft a card with the
  truncated question label, an editable `<textarea>` prefilled with the AI draft, and
  `[Insert]` + `[Skip]`; an `[Insert all]` at the top. After insert: card shows "Inserted ✓"
  and the button becomes "Re-insert" (edited text remains re-insertable). The section is
  hidden when there are no drafts.
- Banner copy: `Filled {ok} of {total}` + (`· {drafts.length} to review below` when drafts
  exist) + "Review before submitting."

### 2.9 Components changed / added
**Changed (extension only):**
- `content/writeEngine.ts` — `preventScroll` on the 3 focus calls.
- `content/contentScript.ts` — `onAutofill` second phase (collect → classify → AI_FILL →
  reconcile simple → return drafts); add `onInsertAnswer`.
- `content/overlay.ts` — review-section render + wiring; extended callback types; banner copy.
- `background/serviceWorker.ts` — new `AI_FILL` case → api client.
- `api/client.ts` (or `api/sync.ts`) — `aiFill(payload)` calling `authedRequest("/api/fill", …)`.
- `shared/types.ts` — `AI_FILL` request/response message types; `Draft` type; extended
  `onAutofill` return type.

**Added:**
- `content/jobContext.ts` — `extractJobContext()`.
- field-classifier helper (`content/fieldClassifier.ts`, or folded into contentScript).

**Backend:** none.

### 2.10 Error / edge handling
- AI unavailable (503) or `/api/fill` error: simple fields stay blank; banner notes "AI
  couldn't answer some fields"; never throws in a way that breaks the local fill.
- No candidates after the local pass: skip the AI phase entirely (no network call).
- Long-form field removed before insert (SPA re-render): `onInsertAnswer` returns
  `{ ok:false, reason }`; the card shows the reason.
- Disconnected / auth required: AI phase skipped with a connect hint; local fill still works
  from the cached profile.

### 2.11 Testing
- `test/writeEngine.test.ts`: assert `.focus()` is called with `{ preventScroll:true }`;
  existing fill-correctness tests still pass.
- New classifier test: `DetectedField` → simple/longform.
- New `jobContext` test: extract JD/title/company from `test/sample-form.html` + a JD fixture.
- Orchestration test: mocked `AI_FILL` response → simple answers feed the reconciler,
  long-form answers return as drafts.
- Manual E2E: unpacked build on Greenhouse/Workday — no scroll-jump; screening Qs fill
  inline; long-form review cards insert correctly.
- **No backend tests** (no backend change).

### 2.12 Out of scope (Feature A)
Resume editing (C), cover-letter generation (B), auto-submit, any backend change.

---

## 3. Feature B — Cover letter generator (summary; own spec later)
- **UI anchor exists:** overlay "Generate Cover Letter" action with a "Coming soon" badge
  (`overlay.ts:680`).
- **Backend:** add a thin `POST /api/cover-letter` (`{ job_description, company, tone }`,
  resume pulled from DB like `/fill`) → `CoverLetterGenerator.generate`. Avoids the job_id
  requirement of `/ai/cover-letter/{job_id}`.
- **Extension:** reuse `extractJobContext()` (from A) + a paste fallback; "Generate" →
  serviceWorker → new route → editable letter in the overlay → Copy / Insert-into-page
  (insert via writeEngine into a `coverLetter`-category field).
- **Depends on:** A (jobContext, AI plumbing).

## 4. Feature C — Resume rewrite in the extension (summary; own spec later)
- **Backend exists:** `POST /ai/edit-snippet` with 7 actions; the dashboard already uses it
  via `AiAssistTextarea.tsx`.
- **Open UX decision (resolve in C's own brainstorming):** (a) add a lightweight editable
  resume view to the overlay that reuses `/ai/edit-snippet`, or (b) keep it a dashboard
  feature and add an "edit in dashboard" link from the extension.
- **Depends on:** A (plumbing). Least urgent.
