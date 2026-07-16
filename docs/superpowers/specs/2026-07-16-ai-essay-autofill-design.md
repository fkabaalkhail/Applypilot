# AI-Composed Long-Answer Autofill — Design

**Date:** 2026-07-16
**Status:** Approved, pending implementation plan

## Problem

The extension leaves **open-ended long-answer fields blank** — questions like
"Why do you want to work here?", "Tell us about yourself", "Describe a time you
faced a challenge". The applicant wants these filled with a genuine answer the
AI composes from their real experience + the job posting, since the answer is
not literally present in their profile/resume.

### Root cause

The extension side is already wired for this and is not the blocker:

- Every `textarea` / `contenteditable` is an AI-fill candidate
  (`chrome-extension/src/content/aiFillPlanner.ts:19`).
- Backend answers fill **silently**, with no review gate — `planAiFill` fills
  every non-empty answer and ignores `needsReview`
  (`chrome-extension/src/content/aiFillPlanner.ts:110`).
- The request already carries `jobDescription`, `jobTitle`, `company`, and the
  full `profile` (`chrome-extension/src/api/aiFill.ts`), and the backend loads
  the resume from the DB server-side (`backend/routers/fill.py:224`).

The blocker is the **backend prompt**. `prompts/answer_question.txt` is a strict
*grounding contract* established by
[2026-07-04-ground-truth-autofill-design.md](2026-07-04-ground-truth-autofill-design.md):
Step 1 — "If the context cannot truthfully support an answer, respond with
`__NO_ANSWER__`"; Step 3 — free-text must be "built **only** from projects...
that appear in the context." A motivation/fit/behavioral essay has no literal
answer in a resume, so the model returns the sentinel, `fill.py:329` skips the
field, and it stays blank.

That grounding behavior is **deliberate and must be preserved** for factual
questions (years of experience, degrees, work authorization, salary, IDs), where
a fabricated answer harms the applicant. This design relaxes it **only** for
open-ended essay questions — a scoped exception to the ground-truth contract,
not a reversal of it.

## Decisions (from brainstorming)

1. **Latitude — Balanced.** Compose a genuine answer grounded in the applicant's
   REAL experience + what the job posting says about the role/company. Express
   motivation and fit that follow from those facts. **Never** invent hard facts
   (employers, titles, dates, years, degrees, skills) or specific claims about
   the company (awards, history, products, revenue) that are not in the posting.
2. **Scope — all four open-ended types:** motivation/fit ("why do you want to
   work here", "why this role"), behavioral ("describe a time...", "greatest
   strength/weakness", "a project you're proud of"), self-intro/goals ("tell us
   about yourself", "where do you see yourself"), and company-knowledge ("what
   do you know about us", "what excites you about our mission").
3. **Backend-only.** No extension rebuild/re-submit. The extension already sends
   everything needed and fills the returned answers silently.
4. **In-page review is the safety net.** The flow parks on every form page
   (form pages are user-gated), so composed essays land in the textarea where
   the applicant sees and can edit them before advancing — no new review UI.
5. **Question-cue boundary.** A composed answer is written only when the
   long-text field carries an open-ended *question cue*. A bare "Additional
   comments (optional)" box with no interrogative stays blank (writing an
   unsolicited essay where the applicant intended silence is worse than blank).
   Tunable — widening to "every long-text box" is a one-line change if wanted.
6. **Factual free-text unchanged.** "Describe your experience with Python" and
   similar already work and keep the strict `answer_question.txt` grounding.

## Design

Approach chosen: **deterministic router + dedicated compose prompt.** A cheap,
pure backend heuristic flags open-ended essay fields; those route to a new
`compose_answer.txt`, everything else stays on the untouched
`answer_question.txt`. One LLM call per field either way — no added cost, and the
factual path is byte-for-byte unchanged (zero regression to the grounding
guarantee). Rejected: folding a branch into `answer_question.txt` (risk of
generative rules bleeding into factual answers) and an LLM classifier stage
(extra call per batch; cost is a live concern in this project).

### Component 1 — `is_essay_question(field)` heuristic (`backend/routers/fill.py`)

A pure function, unit-tested in isolation. A field qualifies when **all** hold:

- It is free-text: `field.type == "textarea"` (the extension maps both
  `textarea` and `contenteditable` to this via `mapType`) **and** `not
  field.options`. Short/choice controls (number, select, radio, checkbox) can
  never qualify, so factual screening questions keep strict grounding.
- Its `label` (or `helpText`) carries an open-ended cue. Signal set (case-
  insensitive), covering the four scoped types:
  `why`, `motivat`, `interest`, `excit`, `passion`, `tell us about yourself`,
  `about yourself`, `describe a`, `a time (when|you)`, `challenge`, `proud`,
  `accomplish`, `strength`, `weakness`, `goal`, `see yourself`,
  `what do you know`, `in your own words`, `what makes you`, `why should we`,
  `drawn to`, `fit for this`, `cover letter` — **or** the label is a `?`-question
  of >= 4 words.

The dangerous misroute direction (a short factual question getting generative
treatment) is structurally impossible: only long free-text fields are ever
candidates. A benign misroute (a factual narrative field routed to compose) is
safe because the compose prompt retains the hard-fact guardrails (Component 2).

### Component 2 — `prompts/compose_answer.txt` (new, Balanced contract)

Placeholders `{{QUESTION}}` and `{{CONTEXT}}`, mirroring `answer_question.txt` so
it drops into the existing `_load_prompt` + replace flow. Contract:

- You ARE the applicant; write in FIRST PERSON, truthfully.
- This is an **open-ended question** — COMPOSE a genuine, specific answer. Do not
  return `__NO_ANSWER__` merely because the answer is not stated verbatim.
- **Ground every claim** in the applicant's real experience / skills / education
  from the context, and in what the JOB posting says about the role and company.
- You MAY express motivation, enthusiasm, and fit that reasonably follow from
  those facts, and connect a real, relevant piece of the applicant's background
  to what the posting asks for.
- You may NOT invent hard facts: employers, job titles, dates, years-of-
  experience numbers, degrees, certifications, skills the applicant lacks, or
  specific claims about the company (awards, revenue, history, products) that are
  not in the posting.
- If the job posting is absent, focus on the role title + the applicant's real
  experience; do not fabricate company specifics.
- Tone: professional, concrete, specific. No clichés or empty buzzwords.
- Length: concise and substantive — target ~60–150 words (3–7 sentences). If the
  field's help text states a limit, honor it.
- Output ONLY the answer — first person, no preamble, no quotes.
- **Floor:** if there is genuinely no applicant experience to draw on AND no job
  posting, return `__NO_ANSWER__` rather than a content-free platitude.

### Component 3 — `compose_answer()` on the LLM service (`backend/services/openai_service.py`)

Sibling to `answer_question()` (openai_service.py:312):

```python
async def compose_answer(self, question: str, context: str) -> str:
    template = _load_prompt("compose_answer.txt")
    prompt = template.replace("{{QUESTION}}", question).replace("{{CONTEXT}}", context)
    system = (
        "You are a job applicant writing a short, genuine answer to an "
        "open-ended application question in first person. Ground it in the "
        "applicant's real experience and the job posting. Output only the answer."
    )
    return await self._generate(prompt, system=system)
```

Same `{{QUESTION}}` block the caller already builds (label + inputType +
helpText; essay fields have no options), same `context` (TODAY'S DATE +
APPLICANT + RESUME + JOB), so no caller-context change is needed.

### Component 4 — Route in Pass 3 (`backend/routers/fill.py`)

In the per-field loop of Pass 3 (currently `fill.py:314–323`), choose the method:

```python
if is_essay_question(field):
    raw = await llm.compose_answer(question=q, context=context)
else:
    raw = await llm.answer_question(question=q, context=context)
```

Everything downstream is unchanged: sentinel handling (`fill.py:329`) still
leaves the field blank when the compose floor returns `__NO_ANSWER__`; the
options-matching / long-answer-drop guard (`fill.py:338`) does not apply because
essay fields have no options; the answer is emitted as `source="ai"` and flows
through the extension's existing silent-fill path.

### Component 5 — Cross-company reuse guard

An AI-composed "why do you want to work at Acme?" answer must never be pasted
into Beta's form. Verified — no new caching is introduced and no extension change
is required:

- **Backend Question Memory** already categorizes company-specific questions and
  flags them `needsReview` (`fill.py:276`); composed essays are `source="ai"`,
  `needsReview=True`, and are never auto-saved (only `POST /api/answers` writes,
  after an explicit accept that the current silent-fill flow does not perform).
- **Client `answerCache.ts`** is a per-frame, in-memory cache **cleared on
  navigation** — "a page is one job" (`answerCache.ts:7`). Each company's
  application is a separate page load, so a composed essay cached during one
  application is gone before the next company's form. Regenerating a company-
  specific essay per application is exactly the resulting behavior. (The only way
  two companies could share a key is two application forms living in one frame
  lifetime — a same-session SPA hop between different employers' forms — which
  does not occur in practice; accepted.)

### Component 6 — Tests

- **`is_essay_question` (unit, pure):** motivation / behavioral / self-intro /
  company-knowledge textareas → `True`; a `number`/`select` "years of experience"
  → `False`; a cue-less "Additional comments" textarea → `False`; a
  `?`-question textarea of >= 4 words → `True`.
- **Routing (mocked LLM, mirrors `test_fill_sentinel.py`):** an essay field
  invokes `compose_answer`, not `answer_question`; a factual field invokes
  `answer_question`.
- **Compose happy path:** an essay field with profile + JD returns the mocked
  composed answer as a non-empty `FieldAnswer` (not skipped).
- **Regression guard:** an unsupported factual question still yields
  `__NO_ANSWER__` → no `FieldAnswer` emitted (grounding preserved).
- **Compose floor:** `compose_answer` returning `__NO_ANSWER__` leaves the field
  blank.
- **Prompt pins (extend `test_fill_prompt.py`):** assert `compose_answer.txt`
  contains its hard-fact-guardrail phrasing and the first-person / output-only
  discipline, so the contract can't silently erode.

## Out of scope

- **`maxLength` harvesting.** v1 keeps answers concise by default and honors a
  limit only when it appears in help text. Threading the textarea's `maxlength`
  attribute through the extension is a later extension-side change.
- **Any user-visible "AI-drafted" indicator.** The in-page park already lets the
  applicant read/edit each essay before advancing; consistent with the existing
  silent-fill UX.
- **Widening to every long-text box** (Decision 5). Deferred behind the
  question-cue boundary unless the applicant asks.

## Success criteria

- "Why do you want to work here?" and the other three scoped types are filled
  with a first-person answer grounded in the applicant's real experience + the
  job posting — not left blank, not fabricating credentials or company facts.
- Factual questions (years, degrees, work authorization, salary, IDs) are
  byte-for-byte unchanged and still leave unsupported answers blank.
- No extension rebuild is required to ship the behavior.
- A composed company-specific essay is never reused across a different company.
