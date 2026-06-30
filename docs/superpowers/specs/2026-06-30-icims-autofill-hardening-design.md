# iCIMS Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design, revised after an empirical probe — see §1.1)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** Second of the "Hard" tier in `docs/ats-coverage.md` (iCIMS). Follows
Workday (1/15).

---

## 1. Context

Continues the ATS coverage work under the established approach: **fixture-driven
verification**, **Approach A** (harden the generic engine, no per-ATS handlers),
one platform per spec → plan → implement cycle.

iCIMS's defining challenge is **iframes**: on the iCIMS-hosted page the application
form lives in a content iframe (`#icims_content_iframe`); embedded on an employer
careers page it is a cross-origin `careers-*.icims.com` iframe.

### 1.1 Empirical finding that shaped this design

A probe (`scanPage` against a form mounted in a same-origin iframe under jsdom)
showed:

- `iframeInput instanceof HTMLInputElement` (top realm) → **false**
- top-frame `scanPage` detected **0** in-iframe fields.

A same-origin iframe is a **separate JS realm**, so `controlTypeOf`'s `instanceof`
checks fail for in-iframe elements and the top frame drops them. This is
real-browser behavior. Consequences:

1. **In production, iCIMS forms are handled by the iframe's own content-script
   instance** (the manifest injects into all frames). That instance scans its own
   realm (where `instanceof` works) and coordinates with the top frame via the
   already-built `crossFrame` announce/adopt + service-worker relay. **This
   coordination already exists, `crossFrame.ts` is unit-tested, and the end-to-end
   multi-frame path is not reproducible in jsdom** (multi-realm + `chrome.*`).
2. A top-frame "observe inside iframes" change would **not** help — the top frame
   cannot classify cross-realm elements regardless. (Observer reach into *shadow
   roots* is a real, same-realm gap, but it belongs to the SuccessFactors cycle.)
3. iCIMS's own field markup is standard labelled inputs, classified/filled by
   whichever frame owns the form — verifiable by mounting that form in the jsdom
   document (the owning instance's view).

### Decisions already made

- **Lean iCIMS:** verify iCIMS field markup from the owning-frame view (fixture);
  rely on the existing `crossFrame` unit tests + a **live spot-check** for the
  iframe coordination. Expect **little-to-no new engine code** — escalate to a
  generic fix only if the fixture exposes a real classification/fill gap.
- Cross-origin / multi-frame coordination is **not** chrome-mocked here.

---

## 2. Goal & definition of done

Confirm the engine correctly **classifies and fills an iCIMS application form** as
the owning frame instance sees it, and that the iframe-coordination primitives stay
sound.

**Done when:**

1. A faithful iCIMS field-markup fixture passes detection + end-to-end fill tests
   (resume + EEO correctly skipped).
2. `crossFrame` unit coverage is green (extended only if a gap appears).
3. The entire existing suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
4. iCIMS flipped `[ ]` → `[x]`, **Progress 1/15 → 2/15** in `docs/ats-coverage.md`.

A live spot-check on a real `*.icims.com` posting (the iframe-coordination path)
is the final real-world confirmation, done by the user when convenient.

---

## 3. Scope

### In

- **Fixture (owning-frame view):** an iCIMS application form mounted directly in the
  test `document` — First/Last Name, Email, Phone, City, a `<select>` Country, a
  labelled resume `<input type="file">`, and EEO `<select>`s — using iCIMS-style
  `name` attributes (e.g. `fields[firstname]`) + real `<label for>` associations.
  Mounted in-document (not in an iframe) **on purpose**: it represents what the
  frame instance that owns the form scans in its own realm (per §1.1); the iframe
  wrapper is a coordination concern verified separately.
- **Tests:** detection (categories, EEO sensitive, resume non-fillable) + end-to-end
  fill via the shared `runAutofill` helper (text/select fill; resume + EEO skipped).
- **Shared test helper:** extract the two-phase `autofill` helper currently inline
  in `test/workday.test.ts` into `test/helpers/autofill.ts` (`runAutofill`), and
  refactor the Workday test to use it (DRY — every ATS test needs it).
- **Engine:** none expected. If the fixture exposes a real gap, fix it generically
  (matcher/scanner) — not with an iCIMS special-case.

### Out

- **Observer reach into iframes** — useless (cross-realm classification fails); not
  added.
- **Observer reach into shadow roots** — real, but a SuccessFactors concern;
  deferred to that cycle.
- **Cross-origin / multi-frame coordination end-to-end** — already built; covered by
  `crossFrame` unit tests + live spot-check (no chrome-mock harness this cycle).
- Structured address, phone sub-dropdowns, captcha, submission — unchanged.

---

## 4. The fixture

`chrome-extension/test/fixtures/icims.ts` exporting `mountIcimsForm(document)`:

- Clears `document.body` and mounts a `<form id="icims_apply_form">` with the fields
  in §3, each a `<label for>` + control, using iCIMS-style `name="fields[…]"`
  attributes.
- Reuses the shared `stubLayout()` helper for jsdom visibility.

File header documents: *"Reproduces iCIMS application field markup as the
owning-frame content-script instance sees it (mounted in-document; the
`#icims_content_iframe` wrapper is a cross-realm coordination concern verified via
crossFrame unit tests + live spot-check — see the design doc §1.1). Reconstructed
from known iCIMS patterns as of 2026-06-30, not copied markup."*

---

## 5. Testing strategy

- `chrome-extension/test/helpers/autofill.ts` — `runAutofill(profile, fillEEO)`:
  the two-phase fill (reconciler for text/select/radio; combobox engine for ARIA
  dropdowns) extracted from `test/workday.test.ts`. `test/workday.test.ts` is
  refactored to import it (and must stay green).
- `chrome-extension/test/icims.test.ts` (vitest/jsdom, `stubLayout` in
  `beforeAll`/`afterAll`):
  - **Detection:** `scanPage(MOCK_PROFILE, false)` finds firstName, lastName, email,
    phone, location; EEO selects flagged sensitive; resume file non-fillable.
  - **Fill:** `runAutofill(MOCK_PROFILE, false)` fills name/email/phone/city and the
    Country select (→ "Canada"); resume + EEO untouched.
- **Regression guard:** full `npx vitest run` + `node test/scan-smoke.mjs`; `npm run
  typecheck` clean. `test/crossFrame.test.ts` stays green (extended only if a gap
  appears).

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Refactor breaks the Workday test | Re-run `test/workday.test.ts` after extracting `runAutofill`; identical logic. |
| iCIMS markup exposes a matcher gap | Treat the failing test as the spec; apply a minimal *generic* fix (debug per systematic-debugging). |
| Over-claiming "covered" when the iframe path isn't unit-tested here | DoD is explicit: fields by fixture, coordination by existing `crossFrame` unit tests + live spot-check; tracker note records the live step. |

---

## 7. Deliverables

1. `test/helpers/autofill.ts` (`runAutofill`); `test/workday.test.ts` refactored to
   use it.
2. `test/fixtures/icims.ts` + `test/icims.test.ts`.
3. `docs/ats-coverage.md`: iCIMS `[x]`, **Progress 2/15**.
4. Commits on `feat/icims-autofill-hardening`, suite + smoke green.
