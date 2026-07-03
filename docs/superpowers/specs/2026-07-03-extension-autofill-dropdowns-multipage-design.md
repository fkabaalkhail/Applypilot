# Extension Autofill: Dropdowns, Demographics, Profile-as-source, Multi-page

**Status:** Approved (design) — 2026-07-03
**Area:** `chrome-extension/` content pipeline + `backend/routers/fill.py` + `prompts/`

## Problem

The AI-assisted autofill answers dropdowns with values that aren't in the
widget's option list (e.g. it answers a race dropdown with "Arab" when only US
Census categories are offered). Multi-page applications (Workday) should fill
page after page. And the AI's answers should be grounded in the user's saved
**Autofill Information**, not guessed from résumé text.

### Root cause (confirmed in code)

- Native `<select>` / radio groups expose their options at scan time, so the AI
  receives them and answers correctly. **Custom / lazy widgets (react-select on
  Greenhouse, Workday button-listboxes) mount their option list only when
  opened**, so `field.options` is empty at the first AI ask. The AI answers
  blind, the fill misses, and only *then* does `fillOnce` harvest the real
  options and re-ask once (`contentScript.ts` → `planReaskFields`). That
  reactive second-guess is why off-list answers appear.
- The answer prompt (`prompts/answer_question.txt`, rule 2) only weakly says
  "respond with one of the options" — it never says "pick the closest listed
  option and never return an off-list value."
- EEO/demographic fields are deliberately never sent to the AI. They fill
  locally from the profile via exact/fuzzy match; on a miss they fall to the
  missing-info modal. There is no "closest option" step, so an unmatched
  demographic value simply fails.
- The `AI_FILL` request (`api/aiFill.ts` → `buildFillRequestBody`) sends
  `resumeText: ""` and job context only — **no profile**. The backend
  (`fill.py`) then builds its AI context from 5 `UserSettings` fields + résumé
  raw text + a hardcoded `Country: Canada`. The rich `UserApplicationProfile`
  (work auth, sponsorship, salary, address, education, experience, skills) that
  drives local fills never reaches the AI.
- Multi-page is already built (`FlowController`: fill → advance → fill, survives
  navigation, handles captcha/validation/login/résumé, never clicks Submit) but
  it **parks after every page and waits for a manual "Next page" click**.

### Evidence — prod telemetry (`autofill_reports`, 2026-07-03, 18 runs)

270 fields, 234 filled, **36 failed**. Failures are almost entirely dropdowns:

| ATS | Failing fields | Reason recorded |
|---|---|---|
| Greenhouse (`job-boards.greenhouse.io`) | `Country*`, `Location (City)*`, `Veteran Status*`, `I have a disability*` | mostly blank (silent combobox miss) + "Value did not stick — fill manually" |
| Workday (`td.wd3.myworkdayjobs.com`) | `Country Phone Code*`, `How Did You Hear About Us?*` | blank (silent combobox miss); + one "Ambiguous checkbox value" |

Blank reason == the combobox/driver path failing without a message.
`Veteran Status` / `Disability` are EEO dropdowns — the same class as the "Arab"
race example.

## Decisions (locked with the user)

1. **Demographics** → on-device closest-match. Race/gender/veteran/disability
   are matched to the nearest available option locally; they are **never** sent
   to any server.
2. **Multi-page** → auto-advance, pause on issues. Auto-advance and fill the
   next page when the current page is clean; pause and hand control back on any
   blocker or unfilled required field. Never clicks the final Submit.
3. **Option harvesting** → harvest up front. Open unknown dropdowns to read
   their real options *before* the AI answers, so the AI only ever picks from
   real options. Scoped to widgets whose options aren't already known.

## Invariants preserved

- **Demographic/EEO data never leaves the device.** The new closest-match runs
  in the content script; EEO is still excluded from every backend request.
- **The flow never clicks a terminal/Submit button.** Auto-advance stops at the
  submit-ready state, exactly as today.
- Runaway guards stay: `MAX_STEPS`, `FLOW_TTL_MS`, same-signature loop check.

---

## Workstream 1 — Harvest options first, then let the AI choose

**Goal:** the AI's *first* answer for a dropdown is constrained to the widget's
real options.

- In `contentScript.ts` `fillOnce`, add a **pre-AI harvest pass** (Phase B,
  before `misses.map(toAiFillField)`): for each backend/AI field that is a
  choice control whose options we don't already have — `combobox`, driver-backed
  (react-select/Workday), or a lazy `<select>` that scanned empty — call the
  existing `harvestComboboxOptions(el)` (open → read → close, sequential so two
  menus never fight) and attach the harvested labels to `field.options`.
- Only then build the AI request. The existing backend path already appends
  options to the question and fuzzy-matches (`fill.py` `_match_option`), so
  constrained answers flow through unchanged.
- Keep the reactive re-ask round (`planReaskFields`) as a **fallback** for
  widgets that only populate options after typing (async typeaheads), where
  up-front harvest returns nothing.
- Strengthen `prompts/answer_question.txt` rule 2:
  > If options are listed you MUST return exactly one of them, verbatim. If none
  > is a perfect fit for the applicant, choose the CLOSEST option. Never return
  > a value that is not in the list. If truly nothing applies and a
  > "Prefer not to answer"/"Decline" option exists, use it.
- Fix `Country*` "Value did not stick": the commit verification in
  `fillAriaCombobox` (`comboboxShowsValue` within `commitWaitMs`) rejects a real
  selection when a dependent dropdown (Country → State) repopulates or commits
  asynchronously. Lengthen/soften verification for driver/combobox commits and
  re-read the displayed value after dependents settle.

**Trade-off:** opening dropdowns up front can briefly flash menus (accuracy-first,
per decision 3). Scoped to only fields with unknown options — native selects and
radio groups are untouched and stay invisible.

**Touchpoints:** `content/contentScript.ts` (`fillOnce`), `content/comboboxEngine.ts`
(harvest + commit verification), `content/aiFillPlanner.ts` (which fields are
"unknown-option choice" candidates), `prompts/answer_question.txt`.

## Workstream 2 — On-device demographic closest-match

**Goal:** an unmatched demographic value picks the nearest available option
locally instead of failing.

- New module `content/demographicMatch.ts`: a pure function
  `closestDemographicOption(category, profileValue, options): string | null`.
  It holds a small built-in synonym / nearest-neighbour table per EEO category
  (race/ethnicity, gender, veteran status, disability) — e.g. Arab /
  Middle-Eastern → "Middle Eastern or North African" if offered, else "White",
  else a "Prefer not to say"/"Decline" option, else `null` (defer to the user).
- Wire into the fill path for `f.sensitive` choice fields (which already fill
  from `proposedValue`): try exact/fuzzy match → `closestDemographicOption` over
  the **harvested** options → only then the missing-info modal. This reuses the
  Workstream-1 harvest so the matcher sees real options.
- Runs entirely in the content script. No EEO value is ever added to an
  `AI_FILL` or any other backend request.

**Trade-off:** closest-match is heuristic; when it returns `null` (low
confidence) the field still defers to the modal rather than guessing wrong.

**Touchpoints:** new `content/demographicMatch.ts`; `content/contentScript.ts`
(sensitive-field branch of the fill / re-ask path); the EEO categories already
in `shared/types.ts` (`EeoAnswers`) and `shared/profileCategories.ts`.

## Workstream 3 — Feed "Autofill Information" to the AI

**Goal:** AI answers are grounded in the user's maintained profile, not just
résumé text.

- Extension: extend `AiFillField`/request building so `buildFillRequestBody`
  (`api/aiFill.ts`) includes a compact, **non-sensitive** `ApplicantProfile`
  derived from the same `UserApplicationProfile` the content script already
  holds (`lastProfile`) — work authorization, sponsorship, salary expectation,
  address (street/city/state/postal/country), current title/company, links,
  and trimmed education / experience / skills. **EEO is excluded.** The
  `AI_FILL` service-worker handler (`serviceWorker.ts`, `AI_FILL` case) passes
  it through.
- Backend `fill.py`: add an optional `profile` object to `FillRequest`; when
  present, build the AI context from it as the **primary** source (replacing the
  5-field `UserSettings` block and the hardcoded `Country: Canada`), and keep
  résumé text appended for free-text depth. Rule-based/profile answers
  (`_rule_based_answer`) prefer the request profile over `UserSettings`.
- Result: "Are you authorized to work?", "Expected salary", "Years of
  experience with X" answer from what the user maintains in Autofill Information.

**Trade-off:** slightly larger request bodies; cap array sizes (e.g. top N
experience/education entries, skills) and truncate long text.

**Touchpoints:** `shared/types.ts` (new `ApplicantProfile` shape), `api/aiFill.ts`
(`buildFillRequestBody`), `background/serviceWorker.ts` (`AI_FILL`),
`backend/routers/fill.py` (`FillRequest`, context building, `_rule_based_answer`).

## Workstream 4 — Multi-page: auto-advance, pause on issues

**Goal:** hands-off page advancement that still stops when a human is needed.

- In `FlowController.run`, replace the "`emit('ready')` → wait for manual
  Next-page click" park with a decision after each page fills and
  `waitWhileBlocked()` clears:
  - **Clean page** — no pause reason (captcha / validation / verification /
    account wall / résumé-upload) **and** no unfilled required field, and a
    non-terminal advance button exists → **auto-advance** (persist state, click
    advance, wait for change) with no manual step.
  - **Issue present** — emit `paused` with the reason and hand control back;
    keep polling so it auto-resumes when the issue clears, and keep the
    "Next page" button as a manual **force-advance** override.
- Add "unfilled required field" as a pause condition: a new `FlowDeps`
  callback `hasUnfilledRequired(snap)` implemented in `contentScript.ts` using
  the existing `controlIsEmpty` over `f.required` fields; surface a new
  `FlowPauseReason` value (e.g. `"unfilled-required"`) in `shared/types.ts` and
  render it in the overlay progress copy.
- Unchanged: never clicks a `terminal` advance button (finishes "done" at
  submit-ready); `MAX_STEPS`, `FLOW_TTL_MS`, and the same-signature loop guard.
- The overlay's `onFlowAdvance` / "Next page" button stays wired — it now means
  "advance anyway" rather than "advance at all."

**Trade-off:** hands-off advancing means less per-page review; the
pause-on-issues checks + never-Submit guard bound the risk.

**Touchpoints:** `content/flowController.ts` (`run`, new dep + decision),
`content/contentScript.ts` (`makeFlowDeps` → `hasUnfilledRequired`),
`shared/types.ts` (`FlowPauseReason`), `content/overlay.ts` (pause copy + button
label).

---

## Verification

- **Live replay** against the real failing URLs from telemetry: a Greenhouse
  `job-boards.greenhouse.io` posting (Country / City / Veteran / Disability) and
  the `td.wd3.myworkdayjobs.com` Workday flow (Country Phone Code / How Did You
  Hear / multi-page advance). Confirm each previously-blank-reason dropdown now
  fills, and that Workday advances page-to-page and pauses on a required gap.
- **Unit tests** (vitest, run via node per the extension's stdio quirk):
  - harvest-first ordering in `fillOnce` (AI request carries real options;
    reactive re-ask only fires for async typeaheads);
  - `demographicMatch` closest-option table (Arab → nearest; unknown → `null`);
  - profile → backend context builder (non-sensitive fields in, EEO out, caps
    applied);
  - `FlowController` auto-advance vs pause decision (clean → advance; blocker or
    unfilled-required → paused; terminal → done).
- **Re-check telemetry** after a fill session: the blank-reason combobox
  failures on Greenhouse/Workday should drop.

## Non-goals

- No change to the captcha policy (fill around it, never suspend).
- No new backend model/provider; the OpenAI path and answer memory stay.
- No auto-clicking of Submit; the human always submits.
- No relaxation of the demographic privacy boundary (decision 1).

## Risks / open questions

- Up-front harvest latency scales with the number of unknown-option dropdowns on
  a page; sequential opening is required for correctness. Acceptable per
  accuracy-first, but worth measuring on a heavy Greenhouse page.
- Async typeahead widgets (some Workday pickers) still won't yield options until
  a query is typed; those keep the reactive re-ask fallback.
- The demographic synonym table is heuristic and US/Canada-centric to start;
  expand as new option sets show up in telemetry.
