# Taleo Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** Third of the "Hard" tier in `docs/ats-coverage.md` (Taleo). Follows
Workday (1/15) and iCIMS (2/15).

---

## 1. Context

Continues the ATS coverage work: **fixture-driven verification**, **Approach A**
(generic engine, no per-ATS handlers), one platform per cycle.

Taleo (Oracle) is a legacy product: **iframe-heavy** and built on old web tech with
**table-based form layouts** (labels in an adjacent or preceding `<td>` rather than
via `<label for>`). Two concerns, mirroring iCIMS:

1. **Iframe coordination** — same cross-realm story as iCIMS (design
   `2026-06-30-icims-…` §1.1): a same-origin iframe is a separate JS realm, so the
   top frame can't classify in-iframe fields; production handles Taleo's iframes via
   the per-frame content-script instance + the already-built, unit-tested
   `crossFrame` announce/adopt. **Not jsdom-testable end-to-end** → verified by
   `crossFrame` unit tests + a live spot-check.
2. **Table-layout field markup** — the per-frame instance must classify fields whose
   label sits in a neighboring table cell.

### Empirical finding (probe)

A probe mounting a Taleo-style `<table>` form and running `scanPage` classified all
fields correctly:

- `<td>First Name</td><td><input></td>` (adjacent cell) → `firstName`,
- `<tr><td>Home Address</td></tr><tr><td><input></td></tr>` (label row above) →
  `location`,
- email / phone / last name likewise.

`domUtils.ts` `nearbyText` already walks previous siblings then climbs ancestors
(catching both the adjacent-cell and label-in-row-above cases). **No engine change
is required.**

---

## 2. Goal & definition of done

Confirm the engine classifies and fills a Taleo legacy **table-layout** application
form (the owning-frame view), skipping resume + EEO.

**Done when:**

1. A Taleo table-layout fixture passes detection + end-to-end fill tests.
2. The entire suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
3. Taleo flipped `[ ]` → `[x]`, **Progress 2/15 → 3/15** in `docs/ats-coverage.md`.

A live spot-check on a real `*.taleo.net` posting (the iframe path) is the final
real-world confirmation.

---

## 3. Scope

### In

- **Fixture:** `test/fixtures/taleo.ts` — a Taleo-style `<table>`-based form: First/
  Last Name, Email, Phone, City in `<td>label</td><td>input</td>` rows; a Country
  `<select>`; a labelled resume `<input type="file">`; EEO `<select>`s. Legacy
  `name="p_firstname"`-style attributes, **no `<label for>`** (labels are bare cell
  text — the point of the fixture). Mounted in-document (owning-frame view; the
  iframe wrapper is the cross-realm coordination concern verified separately).
- **Tests:** `test/taleo.test.ts` detection (categories, EEO sensitive, resume
  non-fillable) + end-to-end fill via the shared `runAutofill` helper.
- **Engine:** none expected (probe-confirmed). A real gap → minimal generic fix.

### Out

- Iframe coordination end-to-end — pre-built; `crossFrame` unit tests + live.
- Exotic legacy Taleo widgets beyond standard inputs/selects — defer until a real
  posting shows them.
- Shadow-root observer reach — SuccessFactors concern.
- Structured address, phone sub-dropdowns, captcha, submission — unchanged.

---

## 4. The fixture

`chrome-extension/test/fixtures/taleo.ts` exporting `mountTaleoForm(document)`:
clears `document.body` and mounts `<table>`-structured rows where each field's label
is **bare text in a sibling/preceding `<td>`** (no `for=`), exercising `nearbyText`.
Reuses `stubLayout()`. File header: *"Reproduces Taleo's legacy table-layout field
markup as the owning-frame instance sees it; the iframe wrapper is a cross-realm
coordination concern (see the iCIMS design §1.1). Reconstructed from known Taleo
patterns as of 2026-06-30, not copied markup."*

---

## 5. Testing strategy

`chrome-extension/test/taleo.test.ts` (vitest/jsdom, `stubLayout` in
`beforeAll`/`afterAll`):

- **Detection:** `scanPage(MOCK_PROFILE, false)` finds firstName, lastName, email,
  phone, location (via table-cell labels); EEO selects sensitive; resume file
  non-fillable.
- **Fill:** `runAutofill(MOCK_PROFILE, false)` fills name/email/phone/city + the
  Country select (→ "Canada"); resume + EEO untouched.
- **Regression guard:** full `npx vitest run` + `node test/scan-smoke.mjs`; `npm run
  typecheck` clean.

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Table-cell label association weaker than the probe suggested | Detection test is the gate; a miss → minimal generic `nearbyText`/matcher fix. |
| Over-claiming "covered" without the iframe path | DoD explicit: fields by fixture, iframe coordination by `crossFrame` unit + live spot-check. |

---

## 7. Deliverables

1. `test/fixtures/taleo.ts` + `test/taleo.test.ts`.
2. `docs/ats-coverage.md`: Taleo `[x]`, **Progress 3/15**.
3. Commits on `feat/taleo-autofill-hardening`, suite + smoke green.
