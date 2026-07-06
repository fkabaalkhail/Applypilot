# Onboarding required resume upload + extension AI modals (parity with app)

Date: 2026-07-06
Branch: `feat/onboarding-upload-and-extension-ai-modals`
Status: Approved (user granted autonomous approval)

## Problem

Two gaps between the web app and its adjacent surfaces:

1. **Onboarding resume upload is a second-class citizen.** The setup wizard
   (`frontend/src/setup/`) posts the picked file to `/settings/resume` as an
   *optional, fire-and-forget* step (failure swallowed), offers an "I'll do this
   later" skip, and lets the user finish without a resume. The real in-app
   upload (`Resume.tsx` → `UploadModal` → `POST /resumes/upload`) runs the full
   analyze pipeline, stores to blob, returns `{id, profile}`, and shows
   progress/success/error. Onboarding must use that same pipeline and must be
   **required** (no skip, cannot finish until a resume is analyzed).

2. **Extension AI is a stripped-down clone.** The extension renders minimal
   vanilla cards (`tailorCard.ts`, `coverLetterCard.ts`) with a single textarea +
   buttons — nothing like the app's real 3-step `CustomResumeModal` (See
   Difference → Align → Review, with gauges, keyword chips, section pickers,
   ATS panel, versions, visual editor) or `CoverLetterModal` (resume pick, tone
   controls, save). The user wants the extension to show the **exact app modals**,
   ending with **Attach to application OR Download**.

## Approved approach

### Part 1 — Onboarding: required, real upload

Replace the wizard's optional `/settings/resume` path with the real
`/resumes/upload` pipeline, reused via a shared uploader so the two surfaces
cannot drift.

- Extract the upload state machine from `Resume.tsx`'s `UploadModal` into a
  reusable **`useResumeUpload` hook** (in `frontend/src/lib/` or
  `frontend/src/hooks/`): owns `state: "upload"|"progress"|"success"|"error"`,
  `ROTATING_TIPS` rotation, file-type validation, and the
  `POST /resumes/upload` (FormData) call returning `{id, profile}`.
  - `Resume.tsx`'s `UploadModal` is refactored to consume the hook (no behavior
    change — regression-guarded by its existing tests / manual parity).
- `ResumeStep.tsx` becomes a **self-contained inline uploader** using the hook:
  same drop-zone → progress (rotating tips + spinner) → success (analyzed)
  states, styled to fit the wizard card. On success it reports the uploaded
  resume **id** upward.
- `SetupWizard.tsx`:
  - Replace `resumeFile: File | null` state with `uploadedResumeId: number | null`.
  - Remove the `/settings/resume` block from `persist()` entirely (upload now
    happens inline, immediately, through `/resumes/upload`).
  - **Remove** the "I'll do this later" skip button.
  - Gate finish: on the resume step, the "Start Matching" button is **disabled
    until `uploadedResumeId` is set** (resume analyzed). No resume ⇒ cannot
    finish.
  - Settings PUT + filter seeding in `persist()` stay as-is.

### Part 2 — Extension: embed the real app modals via iframe

Chosen over a vanilla rebuild because "exactly like the app" is the core
requirement; embedding the real React components guarantees pixel + behavior
parity and one code path to maintain.

**2a. Backend — context-keyed AI endpoints (mounted at `/api`).**
The web modals key on a DB `job_id` (`/ai/custom-resume-analysis/{job_id}`,
`/ai/custom-resume/{job_id}`, `/ai/cover-letter/{job_id}`). The extension has no
`ScrapedJob` row — only raw `{title, company, description, url}`. The underlying
services already accept raw fields, so add thin context wrappers in
`backend/routers/tailor.py` (already mounted at `/api`):

- `POST /api/custom-resume-analysis` → `JobAnalysisOut` (full analysis:
  scores + matched/missing keywords + strengths/weaknesses/suggestions), calling
  `MatchEngine.analyze_job(resume.raw_text, title, company, description)`.
  (Note: existing `/api/tailor-resume` only returns keywords+scores, not the full
  analysis the modal's step 1 needs — hence a new endpoint.)
- `POST /api/custom-resume` → `RewriteOut` (same shape as web: `document`,
  `original_document`, `original_text`, `tailored_text`, before/after scores,
  `version_id`), calling `tailor_document(...)`. `job_id` is unknown, so the
  saved `ResumeVersion.job_id` is null here (label falls back to
  `f"AI · {title}"`). **Verified:** `ResumeVersion.job_id` is already
  `nullable=True` (`backend/db/models.py:450`) — no migration needed.
- Cover letter: `POST /api/cover-letter` **already exists** and returns `{text}`
  from raw context — reused as-is. Save (`/ai/cover-letters`) needs a job_id;
  embed cover letter omits Save (Attach/Download/Copy only) — acceptable parity
  gap, called out below.
- `/api/render-resume` (exists) renders the edited document to PDF for Attach.
- Cover letter PDF: `/api/render-cover-letter` (exists) for Attach/Download.

**2b. Frontend — refactor modals to accept data source + embed routes.**

- Refactor `CustomResumeModal` and `CoverLetterModal` to be **data-source
  agnostic** without changing web behavior:
  - `job` loosens to `{ id?: number; title; company; url }`.
  - Add optional props with web defaults:
    - `analyze?`, `generate?` (resume) / `generate?` (cover) function props —
      default to the current `/ai/...${job.id}` calls; embed passes
      context-based implementations hitting `/api/...`.
    - `jobId?: number | null` threaded to `VersionsPanel`/`ResumeEditor`
      (default `job.id`; embed passes `null` — both must tolerate null).
    - `onAttach?: (file) => Promise<void>` — when present, the footer's "Apply
      Now" is replaced by **"Attach to application"** (keeps Download PDF/DOCX).
- New embed routes rendering the real modals full-bleed (no dashboard chrome):
  - `frontend/src/pages/embed/CustomResumeEmbed.tsx` → route `/embed/custom-resume`
  - `frontend/src/pages/embed/CoverLetterEmbed.tsx` → route `/embed/cover-letter`
  - Each: receives job context + auth token from the parent over a private
    `MessageChannel` (see 2d), builds the context-based `analyze`/`generate`
    using the extension `/api/*` endpoints via a dedicated axios instance that
    uses the port-provided token (not localStorage), and wires `onAttach` to
    postMessage the rendered file bytes to the parent.
- **Hosting reality (verified):** the SPA **and** the API are one Vercel
  deployment on `www.tailrd.ca` (`vercel.json`: `api/**/*.py` functions +
  `frontend/dist` static; `/api/*`,`/ai/*`,`/resumes*` rewrite to the Python
  function, everything else → `index.html`). So:
  - The `frame-ancestors 'none'` / `X-Frame-Options: DENY` in
    `backend/main.py` apply **only to API (JSON) responses**, not to the
    Vercel-static SPA HTML. The SPA currently sets no framing headers (only
    COOP), so `/embed/*` is already frameable. To make intent explicit + avoid a
    future global lockdown breaking it, add a **scoped `vercel.json` header** on
    `source: "/embed/(.*)"` setting `Content-Security-Policy: frame-ancestors https:`
    (the iframe is injected into arbitrary ATS pages, so the ancestor is the ATS
    origin, not a fixed one). The catch-all rewrite already serves `index.html`
    for `/embed/*`.
  - API calls from the iframe are **same-origin** (`www.tailrd.ca/api/*`) — no
    CORS concerns.

**2c. Auth in the iframe.** The embed runs third-party (framed inside an ATS
page), so the HttpOnly refresh cookie is unreliable and the web `localStorage`
token may be absent. The parent (extension content script, which holds the
extension token pair) sends the current access token to the iframe over a
`MessageChannel` port after the iframe signals `ready`. The embed uses that
token for its same-origin `/api/*` calls via a dedicated axios instance; on
`401` it posts `{type:"need-token"}` and the parent replies with a freshly
refreshed token (parent already has silent refresh in `client.ts`). Token never
touches the host page's main world or a query string. Cross-origin
`postMessage` + `MessagePort` transfer (ATS-page → `www.tailrd.ca` iframe) is
used with an explicit `targetOrigin`.

**2d. Extension — replace vanilla cards with iframe overlay.**
- `overlay.ts`: the "Resume rewrite" and "Cover letter" buttons open a
  full-screen overlay hosting an `<iframe src="{appOrigin}/embed/custom-resume">`
  (resp. `/embed/cover-letter`) inside the panel's shadow DOM, plus a
  `MessageChannel` bridge:
  - On iframe `ready`: post job context `{title, company, description, url}` +
    the access token via the port.
  - On `{type:"attach-resume"|"attach-cover", dataBase64, filename, contentType}`:
    reuse the **existing** attach logic (`onAttachTailored` / cover attach) to
    drop the file onto the page's file input.
  - On `{type:"need-token"}`: refresh + post a new token.
  - On `{type:"close"}`: tear down the overlay.
- Delete/retire `tailorCard.ts`, `coverLetterCard.ts`, and the old `ap-pdf-modal`
  tailor/cover result-card path (the generic PDF preview modal for other
  features, if any, stays). Keep `tailorResume.ts`/`coverLetter.ts` service
  wrappers only if still referenced; otherwise remove.

## Deliberately out of scope / accepted gaps

- **Embed cover-letter "Save" to `/ai/cover-letters`** is omitted (needs a DB
  job_id). Extension keeps Attach/Download/Copy/Regenerate/Tone. Revisit if
  users want saved cover letters from the extension.
- **Versions panel in embed** shows empty (jobId null) — versions are a web,
  job-card concept. The visual editor + ATS panel + gauges all still work.
- No change to the extension's autofill flow.

## Testing

- `SetupWizard.test.tsx`: finish disabled until upload succeeds; no "I'll do this
  later" button; `/resumes/upload` (not `/settings/resume`) is called; success
  enables "Start Matching".
- `useResumeUpload` hook test + unchanged `Resume.tsx` upload parity.
- Backend: `test_tailor_api.py` additions for `/api/custom-resume-analysis` and
  `/api/custom-resume` (happy path, no-resume 400, LLM 503, version save/skip).
- Refactored modal tests: web path still hits `/ai/...${job.id}`; embed path hits
  `/api/*` and renders identically; `onAttach` footer swap.
- Extension bridge contract tests (run vitest directly via node, not `npm test`):
  ready→context+token handshake, attach message shape, need-token refresh, close.

## Rollout

- Backend context endpoints + nullable version save reach prod on next push to
  main (dev Neon already migrated by pytest). Frontend embed routes deploy with
  the same push (www.tailrd.ca). Extension is a separate local build pointing at
  the deployed embed origin.
