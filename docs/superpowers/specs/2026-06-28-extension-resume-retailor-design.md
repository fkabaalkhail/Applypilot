# Tailrd Extension — On-the-spot Résumé Retailor + Attach (Design)

**Date:** 2026-06-28
**Status:** Design approved (ready for implementation plan)
**Relationship:** Concretizes the deferred "Feature C — Resume rewrite in the extension"
from `2026-06-28-extension-ai-features-design.md` §4, scoped specifically to the web app's
**Custom Resume** (tailoring) flow plus auto-attaching the result as a PDF.

## 1. Context & scope

Bring the web app's **Generate Custom Resume** flow into the Chrome extension: from any job
application page, the user tailors their résumé to the on-page job **on the spot**, then
attaches the tailored file to the page's résumé-upload field — reusing the web app's tailoring
engine verbatim.

The web app's flow (`frontend/src/components/CustomResumeModal.tsx`) is keyed by a numeric
`job_id` (a `ScrapedJob` row) and produces its PDF by **printing the rendered React DOM node**
(`resumeExport.ts → printResume`). Neither is available to the extension: a live application
page has no `job_id`, and a browser print dialog can't be driven headlessly to capture bytes.
This design bridges both gaps.

### Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Output file format | **PDF**, via a **new server-side renderer** |
| In-extension flow depth | **One-click + keyword tweak** (generate, then toggle missing keywords + regenerate) |
| PDF rendering technique | **Approach A** — structure-driven `reportlab` from the `ResumeDocument` |
| First-click keyword default | **Auto-weave all missing keywords** (strongest one-click result) |
| Render endpoint payload | **base64 JSON** (no binary plumbing in the service worker) |
| DB persistence of tailored version | **Deferred** to a later iteration |

### Foundation that already exists (reused; little/no change)

- **Tailoring services** (all in `backend/`):
  - `services/resume_document.py` — `db_record_to_document(record)` builds a structured
    `ResumeDocument` from a `ResumeProfileDB` row (no re-parse, no LLM); `document_to_text(doc)`
    flattens for scoring/diff.
  - `services/anthropic_service.py:235` — `tailor_resume_structured(document, job_description,
    sections, keywords) -> ResumeDocument` (content-only rewrite; structure/header/theme
    preserved).
  - `services/match_engine.py` — `MatchEngine.analyze_job(resume_text, title, company,
    description)` → overall/ats/keyword-coverage scores + matched/missing keywords.
  - `services/resume_tailor.py` — `ResumeTailor.compute_diff(original, tailored)`.
  - `routers/ai.py:49` — `_resolve_resume(db, user_id, resume_id)` (explicit id → primary →
    most recent). The new endpoint reuses this resolution rule.
  - Schemas: `schemas/resume_document.py` (`ResumeDocument`, `ResumeHeader`, `Section`,
    `SectionItem`, `Theme`).
- **Router mounting:** `routers/fill.py` is mounted `prefix="/api"` (`main.py:79`); the
  extension already calls `/api/fill`. New endpoints join the same `/api` surface.
- **Extension ↔ backend plumbing:** `overlay → chrome.runtime.sendMessage → serviceWorker
  handle() case → api/client.authedRequest → backend`. `api/client.ts` handles auth + silent
  token refresh and raises `AuthRequiredError` (→ `needsLogin`). Base URL `https://www.tailrd.ca`.
- **Job-context scraper:** `content/jobContext.ts → extractJobContext(): { jobDescription,
  jobTitle, company }` (best-effort, failure-tolerant) — already built for AI fill.
- **File-attach engine:** `content/fileUpload.ts` — `injectResumeFile(target, file)`
  (DataTransfer assign + dropzone fallback; **never submits**), `base64ToFile(b64, name, type)`,
  `findFileInput(el)`.
- **Overlay résumé wiring:** the "Upload Resume" section, `hasResumeField()` (a field with
  `category === "resumeUpload" && controlType === "file"`), the résumé picker, and
  `doUploadResume()` → `onUploadResume(resumeId)`. The AI-fill "review card" pattern
  (`renderReviewSection`, `ap-upload-status`) is the visual template for the result card.
- **Service-worker file path:** `DOWNLOAD_RESUME` case → `{ dataBase64, name, contentType }`,
  consumed by the content script via `base64ToFile`. The new render path mirrors this exactly.

## 2. Architecture overview

Three new units, each with one job; the web app's existing print-based flow is untouched.

```
backend/services/resume_pdf.py     render_resume_pdf(doc) -> bytes      (new, pure)
backend/routers/tailor.py          POST /api/tailor-resume              (new; reuses services)
                                   POST /api/render-resume              (new; uses renderer)
chrome-extension/src/api/tailorResume.ts   tailorResume(), renderResume()   (new client)
  + serviceWorker routes TAILOR_RESUME / RENDER_RESUME
  + contentScript callbacks onTailorResume / onAttachTailored / onDownloadTailored
  + overlay "Generate Custom Resume" result card
```

## 3. Backend

**New dependency:** `reportlab` (pure-Python wheel; deploys cleanly on Vercel Hobby alongside
the existing `pdfplumber` and `python-docx`). No system libraries required.

### 3.1 `POST /api/tailor-resume`

Tailor from a **scraped** job description (no `job_id`), reusing the exact services the web
`POST /ai/custom-resume/{job_id}` path uses.

```
Request:
  { resumeId?: int | null,
    jobDescription: string, jobTitle: string, company: string,
    sections?: string[],            // default: all available sections
    addKeywords?: string[] | null } // see keyword semantics below

Flow:
  resume          = _resolve_resume(db, user_id, resumeId)
  original_doc    = db_record_to_document(resume)
  original_text   = document_to_text(original_doc)
  before          = MatchEngine.analyze_job(original_text, jobTitle, company, jobDescription)
  keywords        = addKeywords if provided else before.missing_keywords   # auto-weave-all
  document        = tailor_resume_structured(original_doc, jobDescription, sections, keywords)
  tailored_text   = document_to_text(document)
  after           = MatchEngine.analyze_job(tailored_text, jobTitle, company, jobDescription)
  diff_summary    = ResumeTailor(db).compute_diff(original_text, tailored_text)

Response:
  { document: ResumeDocument,
    originalOverallScore, newOverallScore, newAtsScore, newKeywordCoverage,
    matchedKeywords: string[], missingKeywords: string[],
    diffSummary: string }
```

**Keyword semantics:** if `addKeywords` is **omitted/null**, weave in **all** missing keywords
(best one-click result). If provided (**even `[]`**), use exactly that set — so
regenerate-after-tweak is precise and can subtract keywords.

**Sections semantics:** if `sections` is omitted, all sections present in the document are
eligible for enhancement.

**Stable chip set:** `missingKeywords` in the response is the **candidate set from the `before`
analysis** (i.e. relative to the original résumé), so the overlay's keyword chips stay stable
across regenerates instead of shrinking as keywords get woven in. `matchedKeywords` is likewise
from `before`; the `new*` scores come from the `after` analysis.

**Shared orchestration:** the tailor-and-score body above is extracted into one helper (e.g.
`tailor_document_from_text(...)` in `services/resume_tailor.py`) so the `/api` endpoint and the
existing `/ai/custom-resume/{job_id}` endpoint cannot drift. Scope the refactor to that shared
core only — no unrelated changes to `routers/ai.py`.

**Errors:** no résumé on file → `400` "Upload a résumé first." LLM/connection failure →
`503` "AI is temporarily unavailable." (mirrors `routers/ai.py`).

### 3.2 `POST /api/render-resume`

```
Request:  { document: ResumeDocument, filename?: string }
Response: { dataBase64: string, name: string, contentType: "application/pdf" }
```

Returns the rendered PDF as **base64 JSON** (the service worker forwards it straight to the
content script's `base64ToFile`, with no binary handling). Default `name` =
`resume-{company-slug}.pdf` (mirrors the web app's `resume-${slug}.docx`).

### 3.3 PDF renderer — `backend/services/resume_pdf.py`

`render_resume_pdf(doc: ResumeDocument) -> bytes`, built on `reportlab` Platypus (flowables →
automatic multi-page pagination). It mirrors the structure and theme mapping of the web app's
DOCX builder (`frontend/src/lib/resumeExport.ts → sectionParagraphs / downloadResumeDocx`) so
content and styling stay consistent with the web app's outputs:

- **Page:** size from `theme.page_size` (`letter`/`a4`); ~0.5–0.6in margins.
- **Header:** centered name (`theme.name_font_pt`, `theme.accent_color`); contact line
  (`location · email · phone`); links line (`linkedin · github · other`, accent).
- **Section heading:** uppercased title at `theme.heading_font_pt`, accent color, with a bottom
  rule; `theme.section_spacing_pt` above.
- **Body:** `summary`/`custom` text paragraphs; `skills` joined; `groups` as
  `Category: a, b, c`; `items` with **bold title + right-aligned dates** (two-column row),
  italic `subtitle · location`, optional `link`, `detail`, and bullets. Base text at
  `theme.base_font_pt`/`theme.text_color`, leading from `theme.line_height`.
- **Fonts:** map `theme.font_family`'s first token to a core PDF font (Calibri/Segoe →
  Helvetica). Embedding a TTF for exact-face fidelity is a later enhancement.
- **ATS-friendly:** real selectable text, single column.

Fidelity note: this renderer is **consistent with**, but not pixel-identical to, the web app's
React print preview (a deliberate, deployable tradeoff). The endpoint is reusable; the web app
could later adopt it to unify on one renderer.

## 4. Extension

### 4.1 API client — `chrome-extension/src/api/tailorResume.ts` (new)

`tailorResume(opts)` → `authedRequest("/api/tailor-resume", POST, …)`;
`renderResume(document, filename)` → `authedRequest("/api/render-resume", POST, …)`. Mirrors
`api/aiFill.ts` (including a `buildTailorRequestBody` helper for testability).

### 4.2 Service worker — `background/serviceWorker.ts`

Two new `handle()` cases, same shape as `AI_FILL`:
- `TAILOR_RESUME` `{ resumeId, jobContext, sections?, addKeywords? }` → `tailorResume(...)` →
  `{ ok, result }` (or `{ ok:false, needsLogin }` on `AuthRequiredError`).
- `RENDER_RESUME` `{ document, filename }` → `renderResume(...)` →
  `{ ok, dataBase64, name, contentType }` (mirrors `DOWNLOAD_RESUME`'s response).

### 4.3 Content script — `content/contentScript.ts`

New `OverlayCallbacks` (the content script owns DOM access + SW messaging):
- `onTailorResume({ resumeId, sections?, addKeywords? })` → `extractJobContext()` → send
  `TAILOR_RESUME` → return the result (or a `needsLogin`/error signal).
- `onAttachTailored(document)` → send `RENDER_RESUME` → `base64ToFile(dataBase64, name,
  contentType)` → `injectResumeFile(target, file)`, where `target` is the same
  `resumeUpload`/`file` element `doUploadResume()` already targets. Returns `{ ok, reason? }`.
- `onDownloadTailored(document)` → `RENDER_RESUME` → trigger a download (blob URL /
  `chrome.downloads`).

### 4.4 Overlay UI — `content/overlay.ts`

Activate the "Generate Custom Resume" block (today's *coming soon*) inside the Upload Resume
section. **One-click + keyword tweak:**

```
┌ Generate Custom Resume ──────────────┐
│  ✨ Tailor my résumé for this job    │   ← initial state
└──────────────────────────────────────┘
        ↓ after generate
┌──────────────────────────────────────┐
│ Match 7.2 → 8.5    ATS 88 · 92% cov  │
│ Wove in 4 keywords · enhanced Skills  │
│ Keywords:  [✓react][✓aws][ docker]…  │   ← toggle chips (pre-checked = woven in)
│ [ Regenerate ]                        │
│ [ Attach to form ]   [ Download PDF ] │
│ status…                               │
└──────────────────────────────────────┘
```

- **Enablement:** the "Tailor" button requires a signed-in account with a résumé that has
  structured data. A thin/absent JD does **not** block (best-effort, like AI fill).
- **First click:** `onTailorResume` with `sections` = all available, `addKeywords` omitted
  (→ auto-weave all missing). The card renders score jump (from `original*`/`new*` scores),
  a short "what changed" line, and the `missingKeywords` as chips (pre-checked = the woven set).
- **Regenerate:** re-calls `onTailorResume` with `addKeywords` = the explicitly checked chips
  (cheap, LLM-only — no PDF render).
- **Attach / Download:** render the current document once via `onAttachTailored` /
  `onDownloadTailored`. Status uses the existing `ap-upload-status` styles.
- **Résumé choice:** reuse the existing picker (`overlayState.resumes`).

### 4.5 Shared types — `shared/types.ts`

Add `TAILOR_RESUME` / `RENDER_RESUME` request + response message types, a `TailorResult` type,
and the new `OverlayCallbacks` signatures.

## 5. Data flow (end to end)

```
[Tailor click]
  overlay.onTailorResume → contentScript: extractJobContext()
    → SW TAILOR_RESUME → POST /api/tailor-resume
      (resolve résumé → analyze before → tailor_resume_structured → analyze after → diff)
    → result card: scores + keyword chips
[toggle chips] → [Regenerate] → TAILOR_RESUME (addKeywords = checked)        (no render)
[Attach to form]
  overlay.onAttachTailored → SW RENDER_RESUME → POST /api/render-resume
    (render_resume_pdf → base64) → base64ToFile → injectResumeFile(field)    (never submits)
```

## 6. Error handling / edge cases

- **No résumé-upload field on the page** → "Attach to form" disabled; "Download PDF" offered
  with a hint (attach manually). Detection reuses `hasResumeField()`.
- **Thin/empty JD** → still tailors; subtle note "Couldn't read a full job description on this
  page — tailoring may be limited" (mirrors AI-fill degradation).
- **Sparse/unstructured résumé** → `db_record_to_document` yields a thin doc; show the web
  app's "couldn't fully read this résumé's structure" style note. **No résumé at all** →
  backend `400`, surfaced in the card.
- **LLM `503` / render failure / expired session** → shown in the card status line; the panel
  never crashes; the existing `needsLogin` reconnect path is reused.
- **Captcha** → unaffected: attaching a file is an explicit user action that never submits the
  form, consistent with the existing autofill "fill around, never suspend" decision.

## 7. Scope / non-goals (v1)

- **No DB persistence** of the tailored version (a live application page has no `job_id`).
  Deferred; a later iteration could save a `ResumeVersion` with a nullable `job_id`.
- **No in-panel rich editor** (the web app's `ResumeEditor`/ATS panel/versions). Only
  keyword-tweak + regenerate, per the chosen flow.
- **PDF only** from the extension (the render endpoint can add `format: "docx"` later via the
  already-present `python-docx`).
- **Web app's print-based PDF unchanged.**
- **Cover-letter generation** stays out of scope (its own "coming soon" track).

## 8. Testing

- **Backend**
  - `render_resume_pdf`: emits a valid, non-empty `%PDF` stream for a representative document,
    an empty/sparse document, both page sizes, accent color, and a multi-page document
    (pagination). Hypothesis-style where it fits the repo's existing property tests.
  - `/api/tailor-resume`: with mocked `MatchEngine`/LLM — `addKeywords` omitted (auto-weaves all
    missing) vs. explicit (uses exactly that set, incl. `[]`); `400` with no résumé; `503` on
    LLM failure.
  - `/api/render-resume`: returns base64 that decodes to a `%PDF` header; correct `contentType`
    and slugged filename.
  - (Per project memory: pytest exercises the real Neon dev DB via app lifespan — follow the
    existing `conftest.py` patterns and keep new tests hermetic where possible.)
- **Extension**
  - `tailorResume.ts`: request-body shaping (mirrors the `aiFill` test).
  - Attach wiring: `RENDER_RESUME` → `base64ToFile` → `injectResumeFile` (extends existing
    `fileUpload` tests).
  - Overlay result-card render in jsdom: score jump, chips, regenerate, attach/download states.
- **Manual E2E:** unpacked build on a Greenhouse/Workday application page — tailor, tweak a
  keyword, regenerate, attach; confirm the file appears in the upload widget and the form is
  not submitted.
