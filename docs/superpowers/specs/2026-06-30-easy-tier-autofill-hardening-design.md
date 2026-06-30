# Easy Tier Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** The four "Easy" tier platforms in `docs/ats-coverage.md` (Greenhouse,
Lever, BambooHR, Breezy HR) — the last tier. Follows Hard (5/15) + Medium (11/15).

---

## 1. Context

Final tier of the ATS coverage work, tackled as one **batch** like Medium. These are
the doc's own "easiest to support reliably" platforms: standard, well-labelled HTML
forms (label/for inputs, native `<select>`s, plain `<textarea>`s, native radio
groups).

A probe of the representative Easy markup classified + filled everything correctly
(First Name → firstName, native Country select → location/Canada, Cover Letter
textarea → coverLetter, native sponsorship radio group → sponsorship/No). The
existing `test/scan-smoke.mjs` sample form already exercises this whole shape
end-to-end. **No engine change is required** — this batch is pure fixture-driven
verification.

---

## 2. Goal & definition of done

Cover all four Easy platforms with faithful fixtures + tests.

**Done when:**

1. Fixtures for Greenhouse, Lever, BambooHR, Breezy HR pass detection + end-to-end
   fill tests.
2. The entire suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
3. All four Easy platforms flipped `[ ]` → `[x]`, **Progress 11/15 → 15/15
   (tracker complete)**.

Per-platform live spot-checks on real postings remain the final real-world sign-off.

---

## 3. Scope

### In

- **Fixture:** `test/fixtures/easy.ts` with four builders using self-contained
  standard-HTML helpers (label/for input, native select, textarea, native radio
  group, file field):
  - **Greenhouse** (`mountGreenhouseForm`) — full: First/Last Name, Email, Phone,
    Country `<select>`, LinkedIn, resume file, Cover Letter `<textarea>`, a native
    sponsorship radio group, EEO `<select>`s.
  - **Lever** (`mountLeverForm`) — First/Last Name, Email, Phone, a Cover Letter
    `<textarea>` (Lever's plain textarea), a Country `<select>`.
  - **BambooHR** (`mountBambooHrForm`) — short: First/Last Name, Email, Phone.
  - **Breezy HR** (`mountBreezyForm`) — short: First/Last Name, Email, Phone, a
    Country `<select>`.
- **Tests:** `test/easy.test.ts` detection (expected categories, EEO sensitive,
  resume non-fillable) + end-to-end fill via the shared `runAutofill` (text /
  select / textarea / native radio fill; resume + EEO skipped).
- **Engine:** none (probe-confirmed + `scan-smoke` already covers this shape).

### Out

- Any engine change.
- Deferred cross-cutting items: structured-address sub-fields, phone sub-dropdowns,
  Workday "My Experience" split-date inputs.

---

## 4. Testing strategy

`chrome-extension/test/easy.test.ts` (vitest/jsdom, `stubLayout` in
`beforeAll`/`afterAll`): a `describe` per platform asserting detection
(name/email/phone/location categories; Greenhouse's EEO sensitive + resume
non-fillable + cover-letter + sponsorship) and end-to-end fill via `runAutofill`
(name/email/phone fill; Country select → "Canada"; Lever cover-letter textarea →
profile cover letter; Greenhouse sponsorship radio → "No"; resume + EEO untouched).
Regression guard: full `npx vitest run` + `node test/scan-smoke.mjs`; `tsc` clean.

---

## 5. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A field source weaker than expected | Detection test is the gate; a miss → minimal generic fix (very unlikely — these are the simplest forms and `scan-smoke` already covers them). |
| Over-claiming "covered" | DoD: fields by fixture + the standard live spot-check. |

---

## 6. Deliverables

1. `test/fixtures/easy.ts` + `test/easy.test.ts`.
2. `docs/ats-coverage.md`: all four Easy `[x]`, **Progress 15/15** (tracker
   complete).
3. Commits on `feat/easy-tier-autofill-hardening`, suite + smoke green.
