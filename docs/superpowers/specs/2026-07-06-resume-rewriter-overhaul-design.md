# AI Resume Rewriter overhaul — structure-aware rewrite, honest gaps, dual highlighting

Date: 2026-07-06
Branch: `feat/resume-rewriter-overhaul`
Status: Approved (user granted autonomous approval)

## Problem

The rewriter does the bare minimum: it detects missing JD keywords and weaves
them into existing bullets. It never evaluates structure, achievement framing,
or overall resume strength, so the output passes a naive keyword scan but reads
poorly to a recruiter. **Keyword-injection is the primary mechanism, not a
secondary check.**

Concretely, in `tailor_document()` (`backend/services/resume_tailor.py:120`):

```
before   = MatchEngine.analyze_job(...)                     # LLM: scores + matched/missing keywords
keywords = add_keywords OR before.missing_keywords          # ← the keyword-injection driver
document = llm.tailor_resume_structured(doc, jd, sections, keywords)   # single-pass "weave these in, keep same order"
after    = MatchEngine.analyze_job(tailored_text, ...)      # re-score
```

The rewrite prompt (`backend/services/openai_service.py:264-285`) explicitly
forbids reordering and only rewords bullets/skills/summary.

## Current architecture (confirmed by audit)

**The rewrite is already consolidated** — no duplication to merge:

- Web `POST /ai/custom-resume/{job_id}` (`backend/routers/ai.py:355`),
  extension `POST /api/custom-resume` and `POST /api/tailor-resume`
  (`backend/routers/tailor.py`) **all** funnel through `tailor_document()` →
  `OpenAIService.tailor_resume_structured()`.
- Frontend: the extension renders the **exact same** `CustomResumeModal`
  (`frontend/src/components/CustomResumeModal.tsx`) inside an iframe embed
  (`frontend/src/pages/embed/CustomResumeEmbed.tsx` +
  `chrome-extension/src/content/aiModalBridge.ts` over a MessageChannel). Only
  the analyze/generate callbacks differ (context-keyed `/api/*` vs job-id
  `/ai/*`).

**The anti-fabrication guardrail** is `merge_rewrite()`
(`backend/services/resume_document.py:139`): it takes only `text`/`skills`/
`groups`/`bullets` wording from the LLM and keeps header, section order, titles,
employers, dates, links, and ids from the original. This makes fabricated
employers/dates and reordering structurally impossible — **but it is also what
blocks the "reorder sections / add a summary" goal, and it does not catch
fabricated numbers inside reworded bullets.**

**"Missing keyword" detection** lives in `MatchEngine.analyze_job()`
(`backend/services/match_engine.py:148`, `JOB_ANALYSIS_PROMPT`). A second,
deterministic keyword analysis lives client-side in
`frontend/src/lib/keywordMatch.ts` (`analyzeKeywords`) and drives the inline
heatmap (`HiText`/`HighlightContext` in
`frontend/src/components/ResumeRenderer.tsx`) and `AtsPanel.tsx`.

**Out of scope (legacy, untouched):** `POST /ai/tailor-resume/{job_id}` →
`ResumeTailor.tailor_resume` → `prompts/tailor_resume.txt` (a ~500-word summary
blurb stored in the `TailoredResume` table, used by `AIToolsSidebar.tsx` and
`useApplyFlow.ts`). The dead `tailor_resume_guided()` method is also left as-is.

## Approved decisions (from brainstorming)

1. **Structural freedom:** the AI may reorder sections and add a Professional
   Summary, but factual fields stay locked (ID-based validation), plus a new
   numbers-fabrication check on bullets.
2. **Highlighting:** dual-layer — a "what changed" layer plus the keyword-match
   layer, with a toggle. Keep and improve the existing implementation.
3. **Scope:** overhaul the shared structured pipeline + its Review UI only;
   leave the legacy summary path and callers alone.
4. **Pipeline shape:** one enriched structured LLM call (not a multi-step or
   verifier pipeline).
5. **Numbers guardrail behavior:** **flag** fabricated figures for the user to
   verify; never silently strip them.

## Design

### A. New LLM output contract — `tailor_resume_structured`

The rewrite call returns a top-level object instead of a bare resume document:

```json
{
  "resume":        { ...same ResumeDocument shape, rewritten content only... },
  "section_order": ["<section id>", "<section id>", ...],
  "new_summary":   { "title": "PROFESSIONAL SUMMARY", "text": "..." },
  "gaps":          ["JD requires Kubernetes; no evidence in your experience", ...]
}
```

- `resume` — same JSON contract as today (ids/types/titles preserved; only
  `text`/`skills`/`groups`/`bullets` may change).
- `section_order` — ids of the existing sections in the recommended order.
  `new_summary` — provided only when the resume has no summary/custom section and
  one would help; `null`/omitted otherwise. `gaps` — JD priorities the candidate
  genuinely cannot support (never inserted into the resume).
- Parsing tolerates the model returning a bare resume (back-compat) or the
  wrapped object. On any JSON-parse failure it falls back to the original
  document with empty `gaps` (as today) — no hard failure.

`tailor_resume_structured` returns a small result object
(`document: ResumeDocument`, `gaps: list[str]`) rather than a bare document.

### B. `merge_rewrite` v2 + guardrails

`merge_rewrite(original, edited, section_order=None, new_summary=None)`:

- **Reorder, never drop:** apply `section_order` by id; any original section id
  missing from the list is appended in original relative order. Unknown ids are
  ignored. Result always contains exactly the original sections (+ optional
  summary), so nothing is lost.
- **Add summary:** if the original has no `summary`/`custom` section and
  `new_summary` is present, prepend a new `Section(type="summary",
  title=new_summary.title or "PROFESSIONAL SUMMARY", text=new_summary.text)`.
  This is the only place new prose enters; it is a summary of existing content
  and is run through the numbers check.
- **Fields stay locked:** unchanged from today — only `text`/`skills`/`groups`/
  `bullets` come from `edited`; header/titles/employers/dates/links/ids from
  `original`.

**Numbers-fabrication check** — new `backend/services/fabrication_check.py`,
rule-based (no LLM):

- `find_unsupported_figures(source_text: str, rewritten_texts: list[str]) -> list[str]`
- Extract numeric tokens (percentages, `$`/currency amounts, integers with
  magnitude words like "k"/"million", multipliers like "3x", durations) from
  each rewritten bullet/summary. A figure is "unsupported" if the same numeric
  value does not appear anywhere in `source_text`.
- Returns a de-duped list of `figures_to_verify` (the offending phrase/number).
  These are **flagged, not stripped**.

**`changes`** — computed **deterministically** in `tailor_document` by diffing
the original vs final `ResumeDocument` (sections reordered, summary added, N
bullets reworded, skills woven). Replaces the current client-side fabricated
change list in `CustomResumeModal.renderStep3`.

### C. New system prompt

Replace the inline prompt string in `openai_service.py:264-285` (adapted from
the Step-3 draft in the task):

1. **Structure review** → recommend `section_order`; propose `new_summary` only
   if none exists and it helps.
2. **Content rewrite** → strong action verbs; outcomes over duties; quantify
   **only from existing material** (hard rule: *never introduce a number not
   present in the source*); cut filler; fix tense.
3. **Job alignment** → read the JD's real priorities (seniority, domain terms,
   emphasis), not just its keyword list.
4. **Keyword check (secondary)** → weave only truthfully-supported terms;
   anything unsupported goes to `gaps`, never into the resume.
5. **Output** → the JSON contract in section A. Keeps the strict "same ids/types/
   titles, only reword these fields" JSON rules; drops the "same order" rule
   (now handled by `section_order`).

Keyword-injection stops being the driver: `keywords` (from `add_keywords` /
`before.missing_keywords`) is passed as *optional emphasis*, subordinate to the
holistic rewrite, and only when truthful.

### D. API / schema

- `TailorResult` (`resume_tailor.py`) gains `changes: list[str]`,
  `gaps: list[str]`, `figures_to_verify: list[str]`.
- `RewriteOut` (`backend/schemas/ai.py`) and `TailorResumeOut`
  (`backend/schemas/tailor.py`) gain the same three fields (default `[]`).
- All three endpoints pass them through; request shapes are unchanged. Web and
  extension iframe stay identical because they share `CustomResumeModal`.

### E. Review UI + dual highlighting

`CustomResumeModal.tsx` (step 3) and `ResumeRenderer.tsx`:

- **Real "What changed"** list rendered from backend `changes` (remove the
  checkbox-derived `changes` array in `renderStep3`).
- **"Gaps to consider"** card — non-blocking — listing `gaps` and, under a
  "Verify these figures" subhead, `figures_to_verify`. Never blocks
  download/attach.
- **Dual highlighting** — a three-state toggle in `AtsPanel`: **What changed /
  Keyword match / Off** (replaces the current on/off "Highlight matches"
  checkbox; default *What changed*).
  - *Keyword match* — today's green/yellow heatmap, improved: true multi-word
    phrase highlighting and a small legend. Logic stays in `keywordMatch.ts`.
  - *What changed* — new layer marking bullets/summary text the rewrite added or
    reworded, computed from an original↔final document diff; a distinct warning
    mark on any `figures_to_verify` occurrence.
  - Both layers run through `HiText`/`HighlightContext` and render as `<mark>`
    (a shared marker element) so exports strip them uniformly. **`printResume`
    (`resumeExport.ts:54`) currently only neutralizes `<mark>` background +
    padding; extend that strip rule to also clear the new layer's decoration
    (`border`/`border-left`/`box-shadow`/`text-decoration`) so the "what
    changed" underline/border never leaks into the PDF.** DOCX is schema-built
    from the document (no DOM marks) and is already clean.
- The extension's native `tailorCard.ts` is **not** given the new inline
  highlighting; it still benefits from the improved backend rewrite and receives
  `changes`/`gaps` via schema. (The iframe `CustomResumeModal` is the primary,
  shared surface.)

### F. Tests + regression fixture

- **Regression fixture** (committed): a sample structured résumé + JD + a canned
  LLM response, asserting the pipeline **reorders sections, adds a summary,
  rewrites bullets (not just appends keywords), surfaces a gap, and flags a
  fabricated number.** This is the baseline future prompt changes are compared
  against (structure changed vs. keywords added).
- **Unit tests:** `merge_rewrite` v2 (reorder, add-summary, never-drop, fields
  locked); `fabrication_check.find_unsupported_figures`; the improved
  `keywordMatch` phrase matching + the "what changed" diff.
- **Extend:** `backend/tests/test_tailor_api.py`, `backend/tests/test_ai_web_flow.py`
  for the new `changes`/`gaps`/`figures_to_verify` fields; `CustomResumeModal`
  tests for rendering gaps/changes and the toggle.

## Files touched

Backend:
- `backend/services/openai_service.py` — new prompt + wrapped output contract in
  `tailor_resume_structured`.
- `backend/services/resume_document.py` — `merge_rewrite` v2 (reorder + summary).
- `backend/services/fabrication_check.py` — **new**, numbers check.
- `backend/services/resume_tailor.py` — `tailor_document` returns changes/gaps/
  figures; deterministic change diff.
- `backend/routers/ai.py`, `backend/routers/tailor.py` — pass through new fields.
- `backend/schemas/ai.py`, `backend/schemas/tailor.py` — new response fields.

Frontend:
- `frontend/src/components/CustomResumeModal.tsx` — gaps card, real changes,
  toggle wiring.
- `frontend/src/components/ResumeRenderer.tsx` — dual highlight layers.
- `frontend/src/components/AtsPanel.tsx` — three-state toggle.
- `frontend/src/lib/keywordMatch.ts` — phrase matching, "what changed" diff
  helper (or a sibling `resumeDiff.ts`).
- `frontend/src/lib/resumeExport.ts` — extend `printResume`'s highlight-strip
  CSS so the new "what changed" decoration is excluded from the PDF.

## Guardrails summary

| Fabrication vector | Guard |
|---|---|
| Invented employer/title/date/degree | `merge_rewrite` (structural lock, unchanged) |
| Dropped/lost section | `merge_rewrite` always re-includes all originals |
| Reordering into a misleading structure | AI reorders, but only existing sections; user sees "what changed" + can restore via VersionsPanel |
| Invented metric in a bullet | `fabrication_check` flags `figures_to_verify` + inline warning mark |
| Unsupported skill/keyword | Prompt routes to `gaps`; never inserted; secondary keyword weave is truthful-only |
| New summary prose | Allowed only when absent; run through numbers check |

## Open questions / tradeoffs

- **Reorder aggressiveness:** the prompt should reorder only when it clearly
  helps (e.g. Projects above Experience when experience is thin), not churn
  order for its own sake. Tune via prompt wording + the fixture.
- **Native extension card:** left visually unchanged this pass; revisit if the
  iframe modal fully replaces it.
- **`changes` provenance:** deterministic diff is the source of truth (honest);
  the LLM is not asked to self-report changes, avoiding inflated claims.
