# Workday Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** First of the "Hard" tier in `docs/ats-coverage.md` (Workday).

---

## 1. Context

The extension autofills job-application forms via a single **generic** pipeline —
`scan → classify → resolve value → reconcile (fill + verify + drift-correct)` — with
no per-ATS handlers. Every ATS in `docs/ats-coverage.md` (including all five "Hard"
platforms) is already *targeted* (host patterns live in
`src/shared/constants.ts`) but none has been platform-hardened or proven with a
faithful test.

This is the first of five "Hard" platforms. Each gets its own
spec → plan → implement cycle. **Workday is first** (highest-impact enterprise ATS;
the reconciler was built for its re-render behavior; its fixes seed the rest).

### Decisions already made

- **Definition of "covered" is fixture-driven.** This environment has no browser
  and no access to live Workday postings, so a checkmark is earned when a *faithful
  DOM reproduction* passes an end-to-end test here. A live spot-check is the final
  human sign-off, done when convenient.
- **Approach A — generic-signal hardening.** No per-platform adapter layer and no
  host-branching. We extend the *shared* engine in ways that fix Workday and benefit
  every other ATS, escalating to a small generic helper only for a genuinely
  Workday-shaped quirk. The full existing test suite is the regression guard.

### Relevant current behavior (verified in code)

- `domUtils.ts` `collectSignals` builds `FieldSignals` from
  `label / ariaLabel / placeholder / nameAttr / idAttr / nearby / autocomplete /
  typeHint`. **It does not read `data-automation-id` or any `data-*` test id.**
- `fieldMatcher.ts` `classifyField` scores those signals via `SOURCE_WEIGHTS`;
  `normalize()` already splits camelCase and separators
  (`legalNameSection_firstName` → `legal name section first name`). Negative
  patterns already veto phone-type / extension / country-code mis-fires.
- `comboboxEngine.ts` drives ARIA comboboxes / `aria-haspopup="listbox"` buttons by
  opening the listbox and clicking the matching `role="option"`. Handles portaled
  listboxes, typeahead, and shadow roots. Workday button-listboxes route here.
- `formScanner.ts` `observePage` observes only the **top document's light DOM**
  subtree. Top-level React re-renders (Workday step transitions) fire it; mutations
  *inside* shadow roots / same-origin iframes do not.
- `contentScript.ts` orchestrates fill: text/select/checkbox/radio via
  `AutofillReconciler`; comboboxes via `fillComboboxTargets` (sequential, one-shot).
- **Tests:** `vitest` (jsdom, `test/*.test.ts`) for logic + comboboxes (jsdom has no
  layout, so `isVisible` rejects text inputs unless `getClientRects` is stubbed);
  `test/scan-smoke.mjs` loads `test/sample-form.html`, stubs `getClientRects`, and
  runs the full pipeline with DOM assertions. The Workday integration test follows
  the smoke-test model but lives in the `vitest` suite.

---

## 2. Goal & definition of done

Make the generic engine reliably autofill a **faithful reproduction of Workday's
"My Information" step** (the universal first page of every Workday application) and
correctly *detect-and-skip* the sensitive / manual fields there.

**Done when:**

1. New Workday integration test (full scan → fill → verify against the fixture) is
   green.
2. Targeted unit tests for each generic change are green.
3. The **entire existing suite still passes** (no regressions).
4. Workday is flipped `[ ]` → `[x]` and **Progress** bumped to **1 / 15** in
   `docs/ats-coverage.md`.

A live spot-check on a real `myworkdayjobs.com` posting is the final real-world
confirmation, performed by the user when convenient.

---

## 3. Scope

### In — My Information + screening + voluntary disclosure

- **Text:** First Name, Last Name, Email, Phone Number, City.
- **Button-listbox dropdowns:** Country/Region; Source ("how did you hear about
  us") — detected, classified `unknown`, surfaced for review (no profile mapping).
- **Screening booleans:** legally-authorized-to-work (Yes/No combobox),
  requires-sponsorship (Yes/No radio group).
- **Links:** LinkedIn, when present.
- **Resume:** file upload → detected, **never scripted** (manual; existing
  guarantee).
- **Voluntary disclosures / EEO** (gender, ethnicity, veteran): detected, **not
  filled** unless the EEO toggle is on *and* the profile has the answer.
- **Multi-step:** a step swap (DOM replacement) triggers a rescan that re-detects
  the new step's fields.

### Out — deferred, each can be its own follow-up

- **Structured address** — Address Line 1, State/Province, Postal Code split into
  distinct fields. The profile model holds a single `location` string and the
  product's accepted convention (`scan-smoke.mjs`) fills that whole string into a
  city-style field; correct multi-field address fill needs location
  parsing/sub-categorization, a cross-ATS change tracked separately.
- **Phone sub-dropdowns** — Phone Device Type, Country Phone Code (no profile
  mapping; "device type" also needs a phone negative-pattern tweak).
- "My Experience" split Month/Year **date spinbuttons** (work/education dates,
  graduation year rendered as separate inputs).
- Skills pickers; repeatable "Add Another" sections.
- **Closed** shadow DOM — Workday's candidate site does not use it; that is a
  SuccessFactors concern.
- File scripting, captcha handling, form submission — permanent hard guarantees.

---

## 4. Engine changes (generic, Approach A)

Driven by what the fixture test exposes. Expected change set:

### 4.1 Matcher signal — developer test-ids *(most likely needed)*

- Add a `testId` field to `FieldSignals` in `domUtils.ts`, populated by
  `collectSignals` from the first present of
  `data-automation-id` (Workday), `data-testid`, `data-test`, `data-qa`.
- Add `{ key: "testId", weight: ~0.7 }` to `SOURCE_WEIGHTS` in `fieldMatcher.ts`
  (between `nameAttr` 0.72 and `idAttr` 0.66 / `nearby` 0.6 — a developer-assigned
  semantic id, slightly below a real `name`).
- `normalize()` already handles the camelCase/underscore shapes. Existing negative
  patterns block the obvious mis-fires (`phoneType` → "phone type" → vetoed for
  `phone`).
- Benefits every ATS that ships stable test-ids, not just Workday.

### 4.2 Combobox committed-value / option markup

- Confirm `comboboxShowsValue`, `getListbox`, and `findOption` handle Workday's
  button-listbox: committed value rendered as the button's own text; options carry
  `data-automation-id="promptOption"` with label text in a child node.
- **Tighten only if the fixture exposes a gap** — the engine already covers most of
  this.

### 4.3 Rescan observer reach — *deferred from this plan*

Extending `observePage` to also observe open shadow roots / same-origin iframe
documents is genuinely useful but **not needed for Workday**: Workday's multi-step
transitions are top-level React re-renders, which the existing top-`documentElement`
observer already catches (proven by the multi-step test in §6). Shadow/iframe
observer reach matters for the later shadow-DOM (SuccessFactors) and iframe (iCIMS /
Taleo / ADP) platforms, so it is deferred to whichever of those plans first needs
it, keeping this first plan tight and low-risk.

> **Methodology: TDD.** The faithful fixture + integration test is written first
> (red); then the *minimum* generic change is made to go green, with the full suite
> as the regression guard. §4 is the *expected* change set, not a blank check — the
> failing test decides what actually changes.

---

## 5. The fixture (faithful reproduction)

A **TypeScript builder module**, `chrome-extension/test/fixtures/workday.ts`,
exporting `mountWorkdayMyInfo(document)` — **not** a static `.html` file. Reason:
Workday dropdowns mount their listbox *on click* and commit *on option click*; only
interactive DOM (elements with event listeners) lets the real `comboboxEngine` drive
them under jsdom. A static HTML string loaded via `innerHTML` cannot carry that
behavior. This matches the existing test helpers (`buttonListbox`, `reactSelect` in
`comboboxEngine.test.ts`).

The builder mirrors real Workday markup:

- `data-automation-id` on every control (e.g. `legalNameSection_firstName`, `email`,
  `phoneNumber`, `countryDropdown`, `workAuthorization`).
- `aria-labelledby` / `<label for>` associations (Workday's real pattern).
- `<button aria-haspopup="listbox">` dropdowns that mount a **portaled**
  `role="listbox"` of `role="option"` items (each `data-automation-id="promptOption"`)
  on click and write the chosen label back into the button.
- A resume zone with a labelled `<input type="file">`.
- Voluntary-disclosure `<select>`s for gender / ethnicity / veteran.

File header documents: *"Structure mirrors the Workday candidate experience as of
2026-06-30; reconstructed from known Workday DOM patterns, not copied markup."*

**Fidelity caveat:** the fixture reproduces Workday's structure from knowledge of its
patterns. The user's live spot-check is the final confirmation; if a real form
differs, we update the fixture and re-harden.

---

## 6. Testing strategy

### 6.1 Integration test — `chrome-extension/test/workday.test.ts` (vitest/jsdom)

- A shared `stubLayout()` helper in `chrome-extension/test/helpers/layout.ts`
  (extracted from `scan-smoke.mjs`'s `getClientRects` shim), applied in
  `beforeAll`/`afterAll` so other suites are unaffected, makes controls "visible"
  under jsdom.
- `mountWorkdayMyInfo(document)`, then run the **real** pipeline mirroring
  `contentScript.onAutofill`: `scanPage(profile, fillEEO)` → reconciler
  (`AutofillReconciler({ sleep: instant, observe: false }).run(...)`) for
  text/select/radio targets → `fillAriaCombobox(el, value, { sleep: instant })` per
  combobox target.
- Assertions:
  - First/Last name, email, phone, city (the whole `location` string, per existing
    convention), LinkedIn are filled.
  - Country combobox commits **Canada** (token match against "Ottawa, ON, Canada").
  - Work-authorization combobox commits **Yes**; sponsorship radio selects **No**.
  - Resume file detected, its `value` untouched, flagged manual / not fillable.
  - EEO selects detected and **untouched** with `fillEEO=false`; **filled** with
    `fillEEO=true` when the profile carries the answer.
  - Source dropdown (no profile mapping) is classified `unknown` and not mis-filled.
  - A simulated step swap (replace the form subtree, re-`scanPage`) detects the new
    step's fields.

### 6.2 Unit tests (extend existing files)

- `fieldMatcher` test: `data-automation-id` drives classification; weight ordering;
  negatives still hold.
- `formScanner` / `domUtils` test: `collectSignals` populates `testId`; observer
  reach (if 4.3 is included).
- `comboboxEngine` test: Workday option markup is matched and committed value read
  (only if 4.2 changes anything).

### 6.3 Regression guard

`npm run test` (`vitest run`) must stay fully green. (Per project note, run vitest
directly via node if the npm wrapper reports a stdio quirk.) `test/scan-smoke.mjs`
must still pass.

---

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| New matcher signal regresses other ATSs | Full existing suite + scoped weight + existing negatives + new targeted tests. |
| Fixture not faithful to live Workday | Documented date; fixture kept easy to update; user live spot-check is sign-off. |
| Combobox async flakiness in tests | Injectable instant `sleep` (already supported by `comboboxEngine` + reconciler). |
| Scope creep into My Experience dates | Explicitly out of scope; tracked as a follow-up. |

---

## 8. Deliverables

1. Engine change per §4.1 (generic `testId` matcher signal); §4.2 only if the
   fixture exposes a gap; §4.3 deferred.
2. `test/helpers/layout.ts` + `test/fixtures/workday.ts` + `test/workday.test.ts` +
   `test/fieldMatcher.test.ts` (unit coverage for the new signal).
3. `docs/ats-coverage.md`: Workday `[x]`, **Progress: 1 / 15**.
4. Commits (on a feature branch off `main`) covering all of the above, suite green.
