# Tailrd Extension — On-the-spot Cover Letter Generation (Design)

**Date:** 2026-06-29
**Status:** Design approved (ready for implementation plan)
**Relationship:** Concretizes the deferred "Cover-letter generation" track explicitly left
out of scope by `2026-06-28-extension-resume-retailor-design.md` §7 ("Cover-letter generation
stays out of scope (its own 'coming soon' track)"). This is that track. It mirrors the
résumé-retailor architecture for cover letters, reusing the cover-letter engine that already
powers the web app.

## 1. Context & scope

Bring cover-letter generation into the Chrome extension: from any job application page, the
user generates a cover letter tailored to the on-page job **on the spot**, tweaks its tone,
edits it, and inserts it into the form — reusing the web app's `CoverLetterGenerator` verbatim.

The web app's cover-letter flow (`POST /ai/cover-letter/{job_id}`, `routers/ai.py:177`;
web UI `frontend/src/components/CoverLetterModal.tsx`) is keyed by a numeric `job_id`
(a `ScrapedJob` row) and **persists** an active `CoverLetter` row. Neither fits a live
application page: there is no `job_id`, and (per the decisions below) the extension flow is
**ephemeral**. In the extension today, the overlay's "Generate Cover Letter" control is a
**"Coming soon"** stub (`content/overlay.ts:765`). This design replaces that stub with a
working, `job_id`-free flow.

### Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Insert mechanism | **Smart insert** — fill the page's cover-letter textarea if present; else, if the form has a cover-letter **file** field, render a PDF and attach it; always also offer Copy + Download PDF |
| DB persistence | **Ephemeral** — generate/insert only; **no** writes to the `cover_letters` table; the autofill `coverLetter` source (web app's active letter) is unchanged |
| Card interaction depth | **Tone + edit + regenerate** — tone presets, editable preview, Regenerate (mirrors the web `CoverLetterModal`) |
| New-endpoint placement | New `backend/routers/cover_letter.py`, mounted at `/api` (parallel to `routers/tailor.py`) |
| Cover-letter PDF rendering | New `backend/services/cover_letter_pdf.py` using `reportlab` (already a dependency); stateless (renders the text the client passes) |
| Output file format | **PDF** (DOCX deferrable later via the already-present `python-docx`) |

### Foundation that already exists (reused; little/no change)

- **Cover-letter engine** — `backend/services/cover_letter.py`:
  `CoverLetterGenerator.generate(resume_text, job_description, company, tone=None,
  base_text=None) -> str`. Two modes already built: `base_text=None` → fresh letter
  (`COVER_LETTER_PROMPT`); `base_text` set → rewrite in a new tone (`REWRITE_PROMPT`). Tone
  presets in `TONE_GUIDANCE` (`professional`/`formal`/`enthusiastic`/`concise`/`technical`).
  No engine changes required.
- **Résumé resolution + LLM error constant** — `routers/ai.py:49` `_resolve_resume(db,
  user_id, resume_id)` (explicit id → primary → most recent; **400** if none, with `.raw_text`);
  `routers/ai.py:46` `LLM_503_DETAIL`.
- **Router mounting** — `main.py:79-82` mounts `fill`, `answers`, `tailor`, `profile` at
  `prefix="/api"`. The new `cover_letter` router joins the same `/api` surface.
- **Extension ↔ backend plumbing** — `overlay → chrome.runtime.sendMessage → serviceWorker
  handle() case → api/client.authedRequest → backend`. `api/client.ts` handles auth + silent
  token refresh and raises `AuthRequiredError` (→ `needsLogin`). Base URL `https://www.tailrd.ca`.
- **Résumé-retailor template (mirrored directly)** — `routers/tailor.py`
  (`/api/tailor-resume`, `/api/render-resume`), `services/resume_pdf.py`,
  `schemas/tailor.py`, `api/tailorResume.ts`, `content/tailorCard.ts`, and the
  `TAILOR_RESUME`/`RENDER_RESUME` service-worker + content-script wiring.
- **Job-context scraper** — `content/jobContext.ts → extractJobContext(): { jobDescription,
  jobTitle, company }` (best-effort, failure-tolerant).
- **Field plumbing** — `content/contentScript.ts` keeps `lastFields` (scanned `FieldReport`s,
  each with `category` + `controlType`) and a `registry` (`registry.get(field.id) ->
  RuntimeControl` with `.el`). `content/fieldMatcher.ts:182` already classifies cover-letter
  fields as `category: "coverLetter"`; `LONG_TEXT` is the set of long-text control types.
- **Write + file engines** — `content/writeEngine.ts:36` `writeControl(control, value):
  WriteResult` (the same path autofill uses to fill a textarea); `content/fileUpload.ts`
  `injectResumeFile(target, file)` (never submits), `base64ToFile(b64, name, type)`,
  `downloadBase64File(...)`. All three are already imported in `contentScript.ts`.
- **Overlay cover-letter section** — the "Upload Cover Letter" section, its toggle
  (`#ap-section-cover` → `#ap-cover-sub`, `overlay.ts:897`), and the coming-soon block
  (`overlay.ts:761-768`). The AI-fill / tailor "review card" pattern (`ap-upload-status`,
  `ap-btn-*` styles, `tailorCard.ts`) is the visual template.

## 2. Architecture overview

Three new backend units + the extension wiring; the web app's `job_id`-keyed flow is untouched.

```
backend/services/cover_letter_pdf.py   render_cover_letter_pdf(text) -> bytes   (new, pure)
backend/routers/cover_letter.py        POST /api/cover-letter                   (new; reuses CoverLetterGenerator)
                                        POST /api/render-cover-letter            (new; uses renderer)
backend/schemas/cover_letter.py        request/response models                  (new)
chrome-extension/src/api/coverLetter.ts        generateCoverLetter(), renderCoverLetter()   (new client)
  + serviceWorker routes GENERATE_COVER_LETTER / RENDER_COVER_LETTER
  + contentScript callbacks onGenerateCoverLetter / onInsertCoverLetter / onDownloadCoverLetter / onCopyCoverLetter
  + content/coverLetterCard.ts        pure HTML builders                         (new)
  + overlay "Generate Cover Letter" card (replaces the coming-soon stub)
```

## 3. Backend

**New dependency:** none (`reportlab` is already used by `services/resume_pdf.py`).

### 3.1 `POST /api/cover-letter`

Generate (or regenerate in a tone) from a **scraped** job (no `job_id`), reusing the exact
service the web `POST /ai/cover-letter/{job_id}` path uses — but **without** persisting.

```
Request:
  { resume_id?: int | null,
    job_description: string, job_title: string, company: string,
    tone?: string | null,        // one of CoverLetterGenerator.TONE_GUIDANCE keys, or null
    base_text?: string | null }  // null -> fresh letter; set -> rewrite this text in `tone`

Flow:
  resume = _resolve_resume(db, user_id, resume_id)        # 400 if none on file
  text   = await CoverLetterGenerator().generate(
               resume.raw_text, job_description, company, tone, base_text)

Response:
  { text: string }
```

- **No persistence** — does not read or write the `cover_letters` table, and does **not** call
  `bump_profile_version`. The web app's active cover letter (the autofill `coverLetter` source)
  is unaffected.
- **Errors:** no résumé on file → **400** "No resume profile found. Please upload a resume
  first." (raised by `_resolve_resume`). LLM/connection failure → **503** `LLM_503_DETAIL`
  (catch `(ConnectionError, httpx.ConnectError)`, mirroring `routers/tailor.py:55`).
- **`job_title`** is accepted for prompt parity/forward-compatibility even though the current
  `CoverLetterGenerator.generate` signature does not consume it (the prompt centers on
  `company` + résumé + JD). Kept in the schema so the client contract is stable if the engine
  later uses it; **no engine change in this iteration.**

### 3.2 `POST /api/render-cover-letter`

```
Request:  { text: string, filename?: string }
Response: { data_base64: string, name: string, content_type: "application/pdf" }
```

Stateless: renders the `text` the client already holds (the possibly-edited preview), so no DB
lookup — exactly like `/api/render-resume`. `name = _slug(filename or "cover-letter") + ".pdf"`
(same `_slug`/strip-`.pdf` rule as `tailor.py:36,81-84`); the overlay passes
`filename = "cover-letter-{company}"`, yielding e.g. `cover-letter-acme.pdf`. Render failure →
**422** "Could not render this cover letter." (mirrors `tailor.py:80`).

### 3.3 PDF renderer — `backend/services/cover_letter_pdf.py`

`render_cover_letter_pdf(text: str) -> bytes`, built on `reportlab` Platypus (flowables →
automatic multi-page pagination), mirroring `resume_pdf.py`'s construction:

- **Page:** Letter, ~0.6in margins.
- **Body:** split `text` on blank lines into paragraphs; render each as a left-aligned (or
  justified) `Paragraph` at a standard business-letter size (~11pt, ~1.3 leading), with spacing
  between paragraphs. Preserve single newlines within a paragraph as line breaks.
- **Robustness:** empty/whitespace text renders a valid, near-empty single-page `%PDF` (never
  raises); HTML-special characters in the text are escaped before becoming `Paragraph` markup.
- **ATS-friendly:** real selectable text, single column.

Fidelity note: this is a clean, readable letter — intentionally simpler than a hand-formatted
letterhead. A sender/contact header (name/email from the résumé) is a later enhancement; v1
renders the letter body only.

### 3.4 Schemas — `backend/schemas/cover_letter.py`

```python
class CoverLetterGenerateIn(BaseModel):
    resume_id: int | None = None
    job_description: str = ""
    job_title: str = ""
    company: str = ""
    tone: str | None = None
    base_text: str | None = None

class CoverLetterGenerateOut(BaseModel):
    text: str

class RenderCoverLetterIn(BaseModel):
    text: str
    filename: str | None = None

class RenderCoverLetterOut(BaseModel):
    data_base64: str
    name: str
    content_type: str = "application/pdf"
```

### 3.5 Mounting

In `main.py`: add `cover_letter` to the `backend.routers` import (line 23) and
`app.include_router(cover_letter.router, prefix="/api", tags=["cover-letter"])` next to the
`tailor` mount (after line 81).

## 4. Extension

### 4.1 API client — `chrome-extension/src/api/coverLetter.ts` (new)

Mirrors `api/tailorResume.ts` (auth via `authedRequest`; snake_case server → camelCase UI; a
`buildCoverLetterRequestBody` helper for testability):

- `generateCoverLetter(resumeId, jobContext, tone?, baseText?) -> { text: string }` →
  `authedRequest("/api/cover-letter", POST, …)`.
- `renderCoverLetter(text, filename?) -> { dataBase64, name, contentType }` →
  `authedRequest("/api/render-cover-letter", POST, …)`.

### 4.2 Service worker — `background/serviceWorker.ts`

Two new `handle()` cases, same shape as `TAILOR_RESUME` / `RENDER_RESUME`:
- `GENERATE_COVER_LETTER` `{ resumeId, jobContext, tone?, baseText? }` →
  `generateCoverLetter(...)` → `{ ok, text }` (or `{ ok:false, needsLogin }` on
  `AuthRequiredError`).
- `RENDER_COVER_LETTER` `{ text, filename? }` → `renderCoverLetter(...)` →
  `{ ok, dataBase64, name, contentType }`.

### 4.3 Card builder — `content/coverLetterCard.ts` (new)

Pure, DOM-free HTML builders (mirrors `tailorCard.ts`, escapes interpolated text), so the
markup is unit-testable; `overlay.ts` injects the HTML and wires the controls:
- A tone `<select>` (the five `TONE_GUIDANCE` presets + a default/"Auto" option).
- An editable preview `<textarea>` (`#ap-cl-text`) seeded with the generated letter.
- Action buttons: **Regenerate**, **Insert to form** (label flips to **Attach PDF** when the
  page only has a cover-letter *file* field — see §4.4), **Copy**, **Download PDF**.
- A status line (`ap-upload-status` styles).

### 4.4 Content script — `content/contentScript.ts`

New `OverlayCallbacks` (the content script owns DOM access + SW messaging):
- `onGenerateCoverLetter({ resumeId, tone?, baseText? })` → `extractJobContext()` → send
  `GENERATE_COVER_LETTER` → return `{ ok, text }` (or `needsLogin`/error signal).
- `onInsertCoverLetter(text)` → **smart insert**:
  1. `field = lastFields.find(f => f.category === "coverLetter" && LONG_TEXT.includes(f.controlType))`
     → `writeControl(registry.get(field.id), text)` → `{ ok, reason? }`.
  2. else `field = lastFields.find(f => f.category === "coverLetter" && f.controlType === "file")`
     → send `RENDER_COVER_LETTER` → `base64ToFile(...)` → `injectResumeFile(control.el, file)`
     (mirrors `onAttachTailored`, `contentScript.ts:279`; **never submits**).
  3. else → `{ ok:false, reason: "No cover-letter field found on this page." }` (UI then nudges
     toward Copy / Download).
- `onDownloadCoverLetter(text)` → send `RENDER_COVER_LETTER` → `downloadBase64File(...)`.
- `onCopyCoverLetter(text)` → `navigator.clipboard.writeText(text)` (content-script context, on
  the user's button gesture) → `{ ok }`.

A small helper `hasCoverLetterField()` (scanning `lastFields` for either a `coverLetter`
long-text or `coverLetter` file control) tells the overlay which Insert label to show and
whether to enable it.

### 4.5 Overlay UI — `content/overlay.ts`

Replace the coming-soon block (`overlay.ts:761-768`) with the real card inside the existing
"Upload Cover Letter" section (toggle already wired at `#ap-section-cover`, `overlay.ts:897`):

```
┌ Generate Cover Letter ───────────────┐
│ Tone: [ Professional ▾ ]   [ ✨ Generate ]   ← initial state
└───────────────────────────────────────┘
        ↓ after generate
┌───────────────────────────────────────┐
│ Tone: [ Professional ▾ ]               │
│ ┌───────────────────────────────────┐ │
│ │ Dear Hiring Team at Acme, …        │ │   ← editable preview (#ap-cl-text)
│ └───────────────────────────────────┘ │
│ [ Regenerate ]                         │
│ [ Insert to form ] [ Copy ] [ Download PDF ] │
│ status…                                │
└───────────────────────────────────────┘
```

- **Enablement:** the **Generate** button requires a signed-in account with a résumé that has
  text (same gating as the Tailor button; `_resolve_resume` enforces it server-side too). A
  thin/absent JD does **not** block (best-effort, like AI fill).
- **First Generate:** `onGenerateCoverLetter` with the selected `tone`, `baseText` omitted
  (→ fresh letter). Render the editable preview.
- **Change tone / Regenerate:** re-call `onGenerateCoverLetter` with `baseText` = the current
  preview text + the selected tone (→ `REWRITE_PROMPT`; cheap, LLM-only, no PDF render). Editing
  the textarea before Regenerate carries the edits into the rewrite.
- **Insert to form / Download / Copy:** operate on the **current** (possibly edited) preview
  text. **Insert** label = "Insert to form" when a cover-letter textarea exists, "Attach PDF"
  when only a file field exists, disabled (with a hint to Copy/Download) when neither exists.
  Status uses the existing `ap-upload-status` styles.
- **Résumé choice:** reuse the existing résumé picker (`overlayState.resumes`), shared with the
  Tailor flow.

### 4.6 Shared types — `shared/types.ts`

Add `GENERATE_COVER_LETTER` / `RENDER_COVER_LETTER` request + response message types, a
`CoverLetterResult` (`{ text: string }`) type, a `CoverLetterGenOpts`
(`{ resumeId, tone?, baseText? }`) type, and the new `OverlayCallbacks` signatures.

## 5. Data flow (end to end)

```
[Generate]
  overlay.onGenerateCoverLetter → contentScript: extractJobContext()
    → SW GENERATE_COVER_LETTER → POST /api/cover-letter
        (resolve résumé → CoverLetterGenerator.generate)            (no persistence)
    → editable preview textarea
[change tone] / [Regenerate] → GENERATE_COVER_LETTER (base_text = current text)   (no render)
[Insert to form]
  overlay.onInsertCoverLetter(text) → contentScript:
    cover-letter textarea?  → writeControl(control, text)
    else cover-letter file? → SW RENDER_COVER_LETTER → POST /api/render-cover-letter
                              → base64ToFile → injectResumeFile(field)            (never submits)
    else                    → { ok:false } → UI nudges Copy / Download
[Download PDF]
  overlay.onDownloadCoverLetter(text) → SW RENDER_COVER_LETTER → downloadBase64File
[Copy]
  overlay.onCopyCoverLetter(text) → navigator.clipboard.writeText
```

## 6. Error handling / edge cases

- **No cover-letter field on the page** → "Insert to form" disabled; "Copy" + "Download PDF"
  offered with a hint. Detection reuses `lastFields` + the `coverLetter` category.
- **Cover-letter file field (no textarea)** → "Attach PDF" renders + injects the PDF (never
  submits), consistent with the résumé attach + the autofill "fill around, never suspend"
  decision.
- **Thin/empty JD** → still generates; subtle note "Couldn't read a full job description on
  this page — the letter may be generic" (mirrors AI-fill degradation).
- **No résumé at all** → backend **400**, surfaced in the card status line.
- **LLM 503 / render 422 / expired session** → shown in the card status line; the panel never
  crashes; the existing `needsLogin` reconnect path is reused.
- **Clipboard blocked** → fall back to selecting the textarea contents + a "press Ctrl/Cmd+C"
  hint.

## 7. Scope / non-goals (v1)

- **No DB persistence** of the generated letter (ephemeral, per the locked decision). The
  autofill `coverLetter` source remains the web app's active `CoverLetter` row. A later
  iteration could add an opt-in "Save & set active" (feasible because `CoverLetter.job_id` is
  nullable, `models.py:429`).
- **No sender/letterhead header** in the PDF (body only); **PDF only** (DOCX later).
- **No in-panel rich editor** beyond the plain `<textarea>`.
- **Web app's `/ai/cover-letter/{job_id}` flow unchanged.**

## 8. Testing

- **Backend**
  - `render_cover_letter_pdf`: emits a valid, non-empty `%PDF` stream for a representative
    multi-paragraph letter, an empty/whitespace string (valid near-empty PDF, no raise), and a
    long multi-page letter (pagination). HTML-special characters don't break rendering.
  - `/api/cover-letter`: with a mocked `CoverLetterGenerator` — fresh generate (`base_text`
    null) vs rewrite (`base_text` set) pass the right args to the service; **400** with no
    résumé; **503** on `ConnectionError`. Asserts **no** `cover_letters` row is written and the
    profile version is **not** bumped (ephemeral guarantee).
  - `/api/render-cover-letter`: returns base64 that decodes to a `%PDF` header; correct
    `content_type` and slugged filename.
  - (Per project memory: pytest exercises the real Neon dev DB via app lifespan — follow the
    existing `conftest.py` patterns; keep new tests hermetic where possible.)
- **Extension**
  - `coverLetter.ts`: `buildCoverLetterRequestBody` shaping + response mapping (mirrors the
    `tailorResume` test).
  - `coverLetterCard.ts`: HTML builder in jsdom — tone options, preview seeding, button set,
    Insert-vs-Attach label.
  - Insert wiring: textarea path (`writeControl`) vs file path (`RENDER_COVER_LETTER` →
    `base64ToFile` → `injectResumeFile`), extending the existing `fileUpload`/write tests.
- **Manual E2E:** unpacked build on a Greenhouse/Workday application page — generate, change
  tone, regenerate, edit the preview, insert into the cover-letter textarea; on a file-field
  page, attach the PDF; copy; download. Confirm the form is **not** submitted and no
  `cover_letters` row is created.
