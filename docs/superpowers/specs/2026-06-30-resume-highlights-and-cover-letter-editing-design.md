# Resume keyword highlights + cover-letter autofill & editing — Design

**Date:** 2026-06-30
**Status:** Approved

## Problem

Three gaps in the web "Generate Custom Resume" and "Generate Cover Letter" flows
(`frontend/src/components/CustomResumeModal.tsx`, `CoverLetterModal.tsx`):

1. The final tailored resume can highlight job keywords, but the heatmap is **off
   by default** — users don't see which keywords were woven in (Jobright shows them
   highlighted on arrival).
2. Generated cover letters emit bracketed placeholders (`[Your Name]`, `[Address]`,
   `[Date]`) even though the user's profile already has that information.
3. Cover-letter edits live only in a local textarea and vanish on close — there is no
   "edit and save" parity with the resume flow (whose edits persist as versions).

## Feature 1 — Keyword highlights ON by default

The heatmap already exists: `heatmapTerms(analyzeKeywords(jobKeywords, editedDoc))`
returns green marks for present job keywords (matched + woven-in) and is rendered by
`FittedResume` via `highlightTerms`. It is gated behind `highlightOn`, default `false`.

- **`CustomResumeModal.tsx`**: initialize `highlightOn` to `true` so step 3 opens with
  highlights visible. The existing AtsPanel toggle still lets the user turn it off.
- **`lib/resumeExport.ts` (`printResume`)** — correctness fix. `printResume` serializes
  the live preview node (`node.outerHTML`), so the green `<mark>` elements would bleed
  into the downloaded PDF once highlights default on. Add
  `mark{background:transparent!important;padding:0!important;}` to the print
  stylesheet so downloads stay clean regardless of the on-screen toggle. DOCX is built
  from the schema (no marks) and is already unaffected.

No change to `keywordMatch.ts` — "job keywords present" is exactly the existing heatmap.

## Feature 2 — Fill cover-letter contact info instead of brackets

The web flow uses `CoverLetterGenerator` (hardcoded prompts in
`backend/services/cover_letter.py`), fed only `resume.raw_text`. The profile
(`ResumeProfileDB`) has `profile_name`, `email`, `phone`, `location`, `linkedin_url`
— but **no street address**.

- **`cover_letter.py`**: extend `generate(...)` with optional candidate fields
  (`name`, `email`, `phone`, `location`, `linkedin`) and today's date. Update both
  `COVER_LETTER_PROMPT` and `REWRITE_PROMPT` to:
  - Build a real header/signature from the supplied values.
  - **Never** emit bracketed placeholders; if a value is unknown, omit that line
    rather than bracket it.
  - (Rewrite) strip any bracketed placeholders already present in the base text.
- **Safety net** (`_strip_placeholders` helper): after generation, replace any
  remaining known placeholder tokens with profile values where possible and delete
  leftover `[...]` brackets. Guards against the model ignoring instructions.
- **`routers/ai.py` (`cover_letter`)**: pass `resume.profile_name`, `resume.email`,
  `resume.phone`, `resume.location`, `resume.linkedin_url`. Fills name/email/phone/
  city + date; no street line is invented.

## Feature 3 — Edit + save the cover letter

The textarea is already editable; the gap is persistence + an explicit affordance.
The save endpoint and schema already exist (`POST /ai/cover-letters`,
`CoverLetterSaveIn`).

- **`CoverLetterModal.tsx`**: add a footer **Save** button that posts
  `{job_id, company, job_title, job_url, text, tone, set_active:true}`. Track a
  `dirty` flag (text changed since last generate/save) to enable Save; show a
  transient "Saved ✓". Generating/regenerating resets `dirty` and clears the saved
  indicator.

## Out of scope (YAGNI)

- Rich text formatting for the cover letter (stays a plain textarea).
- Loading a previously-saved letter back into the modal on open.
- The unused `prompts/cover_letter.txt` template (not wired into the backend).

## Testing

- Backend: unit-test `_strip_placeholders` (brackets removed / filled) and that
  `generate` injects contact values into the prompt. Existing
  `test_cover_letter_api.py` continues to pass.
- Frontend: type-check / build; manual confirm highlights show in preview but not in
  the printed PDF, and that Save persists.
