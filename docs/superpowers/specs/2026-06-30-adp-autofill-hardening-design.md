# ADP Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** Fourth of the "Hard" tier in `docs/ats-coverage.md` (ADP). Follows
Workday (1/15), iCIMS (2/15), Taleo (3/15).

---

## 1. Context

Continues the ATS coverage work: **fixture-driven verification**, **Approach A**
(generic engine, no per-ATS handlers), one platform per cycle.

ADP Recruiting Management is **iframe-heavy** with **inconsistent field naming** that
varies between clients, and `<div>`-based form layouts. Two concerns, mirroring the
other iframe platforms:

1. **Iframe coordination** — same cross-realm story as iCIMS/Taleo (see the iCIMS
   design §1.1): production handles ADP's iframes via the per-frame content-script
   instance + the already-built, unit-tested `crossFrame` announce/adopt. **Not
   jsdom-testable end-to-end** → verified by `crossFrame` unit tests + a live
   spot-check.
2. **Inconsistent field markup** — non-semantic `name`/`id`s, labels supplied via a
   mix of sibling `<label>`/`<span>`, `placeholder`, or `aria-label`.

### Empirical finding (probe)

A probe mounting an ADP-style `<div>` form classified all fields correctly despite
non-semantic names (`name="DFEAAB01"` …):

- sibling `<label>First Name</label>` → `firstName`,
- sibling `<span>Last Name</span>` → `lastName`,
- `placeholder="Email Address"` only → `email`,
- `aria-label="Phone Number"` only → `phone`,
- `<div>`-cap "Home City" + nested input → `location`.

The matcher's signal set (`label` / `ariaLabel` / `placeholder` / `nearby` /
`testId` / `name` / `id`) already absorbs ADP's inconsistent naming + mixed label
sources. **No engine change is required.**

---

## 2. Goal & definition of done

Confirm the engine classifies and fills an ADP-style application form (the
owning-frame view) across mixed label sources + non-semantic names, skipping resume
+ EEO.

**Done when:**

1. An ADP fixture passes detection + end-to-end fill tests.
2. The entire suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
3. ADP flipped `[ ]` → `[x]`, **Progress 3/15 → 4/15** in `docs/ats-coverage.md`.

A live spot-check on a real ADP posting (the iframe path) is the final real-world
confirmation.

---

## 3. Scope

### In

- **Fixture:** `test/fixtures/adp.ts` — a `<div>`-based ADP form with **non-semantic
  `name`s** and labels from a mix of sources: a wrapping/sibling `<label>`, a
  `<span>` caption, a `placeholder`-only field, an `aria-label`-only field; plus a
  Country `<select>`, a labelled resume `<input type="file">`, and EEO `<select>`s.
  Mounted in-document (owning-frame view; iframe wrapper verified separately).
- **Tests:** `test/adp.test.ts` detection (categories, EEO sensitive, resume
  non-fillable) + end-to-end fill via the shared `runAutofill` helper.
- **Engine:** none expected (probe-confirmed). A real gap → minimal generic fix.

### Out

- Iframe coordination end-to-end — pre-built; `crossFrame` unit tests + live.
- Shadow-root observer reach — SuccessFactors concern.
- Structured address, phone sub-dropdowns, captcha, submission — unchanged.

---

## 4. The fixture

`chrome-extension/test/fixtures/adp.ts` exporting `mountAdpForm(document)`: clears
`document.body` and mounts a `<div>`-structured form whose fields carry non-semantic
`name`s and draw their label from varied sources (sibling `<label>`, `<span>`
caption, `placeholder`, `aria-label`), exercising the full matcher signal set.
Reuses `stubLayout()`. File header: *"Reproduces ADP's inconsistent-naming,
div-layout field markup as the owning-frame instance sees it; the iframe wrapper is
a cross-realm coordination concern (see the iCIMS design §1.1). Reconstructed from
known ADP patterns as of 2026-06-30, not copied markup."*

---

## 5. Testing strategy

`chrome-extension/test/adp.test.ts` (vitest/jsdom, `stubLayout` in
`beforeAll`/`afterAll`):

- **Detection:** `scanPage(MOCK_PROFILE, false)` finds firstName, lastName, email,
  phone, location across the mixed label sources; EEO selects sensitive; resume file
  non-fillable.
- **Fill:** `runAutofill(MOCK_PROFILE, false)` fills name/email/phone/city + the
  Country select (→ "Canada"); resume + EEO untouched.
- **Regression guard:** full `npx vitest run` + `node test/scan-smoke.mjs`; `npm run
  typecheck` clean.

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A label source weaker than the probe suggested | Detection test is the gate; a miss → minimal generic matcher fix. |
| Over-claiming "covered" without the iframe path | DoD explicit: fields by fixture, iframe coordination by `crossFrame` unit + live spot-check. |

---

## 7. Deliverables

1. `test/fixtures/adp.ts` + `test/adp.test.ts`.
2. `docs/ats-coverage.md`: ADP `[x]`, **Progress 4/15**.
3. Commits on `feat/adp-autofill-hardening`, suite + smoke green.
