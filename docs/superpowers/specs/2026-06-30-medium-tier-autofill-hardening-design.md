# Medium Tier Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** All six "Medium" tier platforms in `docs/ats-coverage.md` (Ashby,
Workable, SmartRecruiters, Jobvite, Rippling, Bullhorn). Follows the completed Hard
tier (5/15).

---

## 1. Context

The Hard tier is complete. Per the user's choice, the Medium tier is tackled as one
**batch** (single branch, one tier-level spec + plan) rather than six separate
cycles, because the engine is now mature and most Medium platforms are lean
verification cycles.

A probe of representative Medium markup established the split:

| Pattern (platforms) | Result |
| --- | --- |
| react-select combobox (Ashby, Workable) | detected + classified (`location:combobox`) — handled |
| standard React field (Rippling, Bullhorn, SmartRecruiters) | detected + classified — handled |
| ARIA `role="radiogroup"` (Jobvite custom radios) | **not detected** — real gap |

So **5 of 6 are lean** (fixtures + tests, no engine change), and **Jobvite needs a
real, generic engine change**: support for ARIA radio groups.

---

## 2. Goal & definition of done

Cover all six Medium platforms with faithful fixtures + tests, and close the ARIA
radiogroup gap generically.

**Done when:**

1. ARIA radiogroup support is implemented + unit-tested.
2. Fixtures for all six platforms pass detection + end-to-end fill tests.
3. The entire suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
4. All six Medium platforms flipped `[ ]` → `[x]`, **Progress 5/15 → 11/15**.

Per-platform live spot-checks on real postings remain the final real-world sign-off.

---

## 3. Engine change — ARIA radiogroup support (generic)

Modern React radio groups (react-aria / Radix — Jobvite's "custom radio
implementations") render `role="radiogroup"` containing `role="radio"` **divs**, not
native `<input type="radio">`. The scanner misses them (not in `CANDIDATE_SELECTOR`;
no `controlTypeOf` case). Add first-class support, driven by clicks (the reconciler's
synchronous write+verify model — no async):

- **`src/shared/types.ts`**: add `"ariaRadioGroup"` to the `ControlType` union.
- **`src/content/formScanner.ts`**:
  - add `[role="radiogroup"]` to `CANDIDATE_SELECTOR`;
  - `controlTypeOf` → returns `"ariaRadioGroup"` when `el.getAttribute("role") ===
    "radiogroup"` (checked before the generic element fallbacks);
  - options from descendant `role="radio"` text (a new `ariaRadioOptions` helper);
  - `currentValueOf` → the text of the `aria-checked="true"` option;
  - the control is a single-element control (`el` = the group), surfaced in the
    main scan path (not the native-radio grouping path); `fillable: true`.
- **`src/content/writeEngine.ts`**: `writeControl`/`verifyControl` cases for
  `"ariaRadioGroup"` → find the matching `role="radio"` via the shared `matchOption`
  (text / `data-value`), `click()` it, and verify via `aria-checked === "true"`.

**No `fieldMatcher` change needed:** because options are read for an ariaRadioGroup,
`hasYesNoOptions` already makes a Yes/No group resolve correctly
(`isYesNoChoice → toYesNo`). This support benefits any ATS using ARIA radios.

> **Methodology: TDD.** A scan+fill test for an interactive `role="radiogroup"` is
> written first (red — probe shows it isn't detected today), then the change across
> the three files makes it green, with the full suite + smoke as the regression
> guard. TypeScript's exhaustive `switch`es in `writeEngine`/`formScanner` force the
> new case to be handled.

---

## 4. Fixtures + tests

One `chrome-extension/test/fixtures/medium.ts` exporting six builders (sharing
internal helpers), and one `chrome-extension/test/medium.test.ts` with a `describe`
per platform:

- **Ashby** (`mountAshbyForm`) — React text inputs + a react-select country dropdown.
- **Workable** (`mountWorkableForm`) — standard inputs + a react-select country
  dropdown.
- **SmartRecruiters** (`mountSmartRecruitersForm`) — standard inputs + one custom
  screening question (classified `unknown`, surfaced for review, not mis-filled).
- **Jobvite** (`mountJobviteForm`) — standard inputs + an **interactive ARIA
  radiogroup** (sponsorship: `role="radio"` divs that set `aria-checked` on click) +
  EEO selects — exercises §3.
- **Rippling** (`mountRipplingForm`) — clean React text inputs.
- **Bullhorn** (`mountBullhornForm`) — simple standard inputs.

Each `describe`: detection (expected categories, EEO sensitive, resume
non-fillable) + end-to-end fill via the shared `runAutofill` (text / select /
combobox / aria-radio fill; resume + EEO skipped). Reuses `stubLayout()`. The
react-select builders reuse the proven interactive react-select pattern from
`comboboxEngine.test.ts` (menu mounts on click, commits on option click). Fixture
header notes each reconstructs the platform's markup as of 2026-06-30, not copied.

---

## 5. Testing strategy

- **Engine unit test:** a focused ARIA-radiogroup test (scan detects a
  `role="radiogroup"` as `ariaRadioGroup` with its options + checked value; the write
  engine selects the matching radio and verifies `aria-checked`). Lives in
  `test/writeEngine.test.ts` (or a small new file).
- **Per-platform** detection + fill in `test/medium.test.ts`.
- **Regression guard:** full `npx vitest run` + `node test/scan-smoke.mjs`; `npm run
  typecheck` clean after each step.

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| ARIA radiogroup change touches 3 core files | TDD; full 157-test suite + smoke as regression guard; the new control type is additive (new enum case + new `switch` branches the compiler forces). |
| react-select fill flakiness | Reuse the proven interactive react-select pattern + injectable instant sleep. |
| Fixture fidelity across 6 platforms | Documented; live spot-check is per-platform sign-off; a real classification gap → minimal generic fix. |
| Overlay rendering of a new control type | The serializable `DetectedField` only carries `controlType` as a string; the autofill path (`scanPage`→`runAutofill`) is unaffected; no overlay change in scope. |

---

## 7. Deliverables

1. ARIA radiogroup support: `src/shared/types.ts`, `src/content/formScanner.ts`,
   `src/content/writeEngine.ts` + its unit test.
2. `test/fixtures/medium.ts` + `test/medium.test.ts` (6 platforms).
3. `docs/ats-coverage.md`: all six Medium `[x]`, **Progress 11/15**.
4. Commits on `feat/medium-tier-autofill-hardening`, suite + smoke green.
