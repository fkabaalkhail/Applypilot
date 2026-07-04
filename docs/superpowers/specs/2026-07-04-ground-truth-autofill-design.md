# Ground-Truth-Only Autofill — Design

**Date:** 2026-07-04
**Status:** Approved, pending implementation plan

## Problem

The extension autofill sometimes fills fields with fabricated information the
applicant never provided (guessing), fills fields that don't apply, and doesn't
reliably leave a field blank when it has no grounded answer.

### Root cause

The `/api/fill` AI prompt (`prompts/answer_question.txt`) was written for an
earlier design where a human reviewed every AI answer before it filled. That
review modal was removed in commit `d5aff02`, so the extension now fills **every**
non-empty AI answer silently (`chrome-extension/src/content/aiFillPlanner.ts:106`
— "the backend's `needsReview` verdict is ignored"). The prompt, however, still
explicitly instructs the model to fabricate:

- Rule #7 — invent `GPA 3.5/4.0` when unknown.
- Rule #8 — "Always agree."
- Rule #9 — "give a reasonable professional answer (e.g. '3' for years)",
  "Never say you have zero experience".
- Rule #4 — "NEVER say 'I don't have experience'".

There is currently **no blank path**: the prompt forbids empty output. With the
human gate gone, these fabrications land directly in the form.

Additionally, `_raw_rule_based_answer` in `backend/routers/fill.py` auto-answers
some questions from assumptions rather than the applicant's data (e.g.
`relocate?` → always Yes, `background check?` → Yes, `driver's license?` → Yes).

## Decisions (from brainstorming)

1. **Unknown fields:** leave blank, never guess. Only fill what the resume /
   profile actually supports.
2. **Page context:** yes — send each field's surrounding help text and native
   input type so the AI understands the real question and its format.
3. **Rule shortcuts:** keep only truly universal ones (work authorization,
   sponsorship, 18+, agreement/consent, data-driven "worked here?"); drop
   unfounded assumptions (relocate, driver's license, background check, drug
   test) and route them to the (now-conservative) AI pass.
4. **Date-picker-as-text-input bug:** out of scope; tracked separately.

## Design

### Component 1 — Rewrite `prompts/answer_question.txt`

Flip the contract from "always find something to say" to "answer only what the
applicant's data supports; otherwise leave blank."

- Answer **only** from the provided APPLICANT CONTEXT / RESUME. When the data
  does not support an answer, output a single sentinel token: `__NO_ANSWER__`.
- Remove the fabrication rules (no invented GPA, no "always agree", no made-up
  years of experience, no "never say I lack experience").
- Multiple-choice / dropdown: pick an option **only if the data clearly
  supports one**; otherwise output the sentinel. Keep the existing
  "Prefer not to say" / "Decline to answer" behavior for EEO-style declines.
- Keep the format discipline already in the prompt: first person, no preamble /
  conversational lead-ins, exact option text for multiple choice.

### Component 2 — Backend honors the sentinel (`backend/routers/fill.py`)

In Pass 3 (AI generation), after stripping the raw answer:

- If the answer equals the sentinel `__NO_ANSWER__` (case-insensitive, after
  stripping quotes/whitespace) or is empty, **do not emit a `FieldAnswer`** for
  that field.
- The extension already skips answers with empty/whitespace text
  (`aiFillPlanner.ts:116`), and a field with no emitted answer simply stays
  blank. No client change is required for the blank path itself.

### Component 3 — Forward page context to the AI

The scanner already collects the needed signals in `FieldSignals`
(`chrome-extension/src/content/domUtils.ts:236`) — `nearby` (help/section text)
and `typeHint` (native input type). They are currently dropped before the
`/api/fill` request. Thread them through:

- **Backend:** add `helpText: str = ""` and `inputType: str = ""` to the
  `FormField` model. Inject them into the per-field question block sent to the
  model, e.g. a line like `Field type: date` and the surrounding help text, so
  the model understands format and can judge when a field is optional /
  irrelevant and leave it blank.
- **Client:** in the field-to-`AiFillField` mapping (`aiFillPlanner.ts`), populate
  `helpText` from the field's `nearby` signal and `inputType` from `typeHint`,
  threading them through `DetectedField` (`chrome-extension/src/shared/types.ts`)
  and `formScanner` if they are not already carried there.

### Component 4 — Prune over-eager rules (`_raw_rule_based_answer`)

- **Keep:** work authorization → yes, sponsorship → no, 18-or-older → yes,
  agreement / consent, data-driven "worked here?" (already answered from real
  experience), and the profile lookups (first/last name, email, phone, city,
  linkedin).
- **Remove:** the `relocat`, `driver` + `licen`, `background check`, and
  `drug test` shortcuts. These route to the AI pass, which now leaves them blank
  unless the profile / resume supports a Yes.

### Component 5 — Tests

- **Backend:**
  - A low-context question yields the sentinel → no `FieldAnswer` emitted.
  - `helpText` / `inputType` are threaded into the prompt.
  - Removed rules (relocate, driver's license, background check, drug test) no
    longer auto-answer.
  - Kept rules (authorization, sponsorship, 18+) still auto-answer.
- **Extension:**
  - `aiFillPlanner` forwards `helpText` / `inputType` on the request fields.
  - Empty / sentinel answers produce no fill target (assert existing behavior).

## Out of scope

- The **date-picker-as-text-input** field-detection / writing bug — tracked
  separately.
- Complaint "not filling info it already has": the page-context change should
  help. If a specific field still misfires afterward, diagnose it via the
  `autofill_reports` Neon prod telemetry (exact URL + per-field reasons) rather
  than speculative changes now.

## Success criteria

- A field with no supporting data in the resume / profile is left blank, not
  filled with a fabricated value.
- The AI receives each field's help text and native input type.
- Universal screening questions (authorization, sponsorship, 18+, consent) still
  auto-fill; assumption-based ones (relocate, driver's license, background check,
  drug test) no longer auto-fill from a hardcoded Yes.
