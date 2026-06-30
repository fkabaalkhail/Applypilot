# SuccessFactors Autofill Hardening — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Tracker:** Fifth and final "Hard" tier platform in `docs/ats-coverage.md`
(SuccessFactors). Follows Workday, iCIMS, Taleo, ADP (4/15).

---

## 1. Context

Continues the ATS coverage work: **fixture-driven verification**, **Approach A**
(generic engine, no per-ATS handlers), one platform per cycle. Unlike the three
iframe-heavy platforms (iCIMS/Taleo/ADP — lean verification cycles), this one needs
a **real, generic engine change**.

SAP SuccessFactors is built on SAP UI5: fields render as **custom elements with
open shadow DOM** (`<ui5-input>` etc., each wrapping a real control in its shadow
root).

### Empirical finding (probe)

A probe mounting a UI5-style custom-element host with an **open** shadow root showed:

- **Discovery + classification work** — `scanPage` found and classified the
  in-shadow fields (`aria-label="First Name"` → `firstName (John)`,
  `aria-label="Email"` → `email`). Open shadow roots are the **same JS realm** as
  the top document, so `deepQueryAll` descends into them (proven in
  `test/domUtils.test.ts`) and `controlTypeOf`'s `instanceof` checks succeed.
- **The rescan observer does NOT fire on shadow-internal mutations** — appending a
  field inside the open shadow root produced **0** `observePage` callbacks.
  `observePage` observes only the top `documentElement`; a `MutationObserver` does
  not see mutations inside a shadow root unless it observes that root directly.

So UI5's dynamic multi-step forms would not be re-detected after a step change. That
is the gap this cycle closes.

### Relevant current behavior (verified)

- `domUtils.ts` `deepQueryAll` descends into open shadow roots; the matcher already
  classifies their fields via `aria-label`/label/`nearby`.
- `formScanner.ts` `observePage` attaches its debounced `MutationObserver` to the
  top `documentElement` only.
- The fill path (`writeEngine`/reconciler) operates on the element directly, so it
  already writes an inner shadow `<input>`.

---

## 2. Goal & definition of done

Close the rescan-observer gap so the engine re-detects fields appearing inside open
shadow roots, and prove discovery/fill/rescan against a faithful UI5-style fixture.

**Done when:**

1. A UI5-style open-shadow-DOM fixture passes detection + end-to-end fill +
   **observer-reach** tests.
2. The entire suite + `node test/scan-smoke.mjs` stay green; `tsc` clean.
3. SuccessFactors flipped `[ ]` → `[x]`, **Progress 4/15 → 5/15** in
   `docs/ats-coverage.md` (completing the Hard tier).

A live spot-check on a real `*.successfactors.com` posting (including UI5 component
value-commit behavior) is the final real-world confirmation.

---

## 3. Engine change (real, generic — the heart of this cycle)

Extend `observePage` (`formScanner.ts`) so its single debounced `MutationObserver`
watches a **set of roots**: the top `documentElement` **plus every open shadow root**
reachable by a deep walk (nested shadow roots included), re-attaching to shadow
roots that appear on later mutations. A `Set` of observed roots keeps re-attach
idempotent; the attach step re-runs whenever a relevant mutation schedules
`onChange`.

A new pure helper `openShadowRoots(root): ShadowRoot[]` does the walk (mirrors
`deepQueryAll`'s shadow traversal, minus iframes), so it can be unit-tested
deterministically.

**Deliberately excludes same-origin iframes.** Unlike shadow roots, iframe fields
are a different JS realm the top frame cannot classify (the iCIMS finding §1.1), so
observing iframe documents would only trigger pointless rescans; iframes are handled
by their own per-frame content-script instance. This implements the shadow-root half
of the long-deferred observer-reach item, scoped to where it is actually useful.

> **Methodology: TDD.** The observer-reach behavioral test + the `openShadowRoots`
> unit test are written first (red — probe shows 0 callbacks today), then the
> minimal `observePage` change makes them green, with the full suite + smoke as the
> regression guard.

---

## 4. The fixture

`chrome-extension/test/fixtures/successfactors.ts` exporting
`mountSuccessFactorsForm(document)`: a light-DOM form of custom-element hosts
(`<ui5-input>` / `<ui5-select>`-style), **each with an open shadow root** containing
the real control carrying an `aria-label` (UI5's accessible-name pattern):

- text inputs (First/Last Name, Email, Phone, City),
- a Country `<select>`,
- a resume `<input type="file">`,
- EEO `<select>`s (gender / ethnicity / veteran).

Host elements carry known ids (e.g. `sf-firstname-host`) so tests reach the inner
control via `host.shadowRoot!.querySelector(...)`. Reuses `stubLayout()` (shadow
elements are same-realm, so the top-window `getClientRects` stub applies). File
header documents it reconstructs UI5/SuccessFactors shadow structure as of
2026-06-30, not copied markup.

---

## 5. Testing strategy

`chrome-extension/test/successfactors.test.ts` (vitest/jsdom, `stubLayout` in
`beforeAll`/`afterAll`):

- **Detection:** `scanPage(MOCK_PROFILE, false)` finds the in-shadow fields
  (firstName, lastName, email, phone, location); EEO sensitive; resume file
  non-fillable.
- **Fill:** `runAutofill(MOCK_PROFILE, false)` fills the inner shadow inputs + the
  Country select (→ "Canada"); resume + EEO untouched (asserted via
  `host.shadowRoot.querySelector`).
- **Observer reach (TDD red→green):** `observePage(cb)`; append a field inside an
  existing open shadow root; wait past the 500 ms debounce (real timer); assert `cb`
  fired. Plus a deterministic unit test of `openShadowRoots(document)` returning the
  shadow roots (and not throwing on a cross-origin iframe present in the tree).

Add the `observePage`/`openShadowRoots` tests to `test/formScanner.test.ts` (same
module) or a new `test/observePage.test.ts`.

- **Regression guard:** full `npx vitest run` + `node test/scan-smoke.mjs`; `npm run
  typecheck` clean.

---

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Observer re-walk cost on large pages | Deduped `Set`; gated to the debounced path; bounded walk. |
| MutationObserver-in-shadow timing flaky under jsdom | Primary proof is the deterministic `openShadowRoots` unit test; the behavioral test uses a real timer (probe showed real-timer shadow mutations are observable once the root is observed). |
| `observePage` change regresses existing rescan behavior | Change is additive (more roots, same debounce/callback); full suite + smoke; new targeted tests. |
| Real UI5 component value-commit unproven here | Engine reaches + writes the inner shadow input (verified); UI5 state sync is an explicit live spot-check. |

---

## 7. Deliverables

1. `observePage` shadow-root reach change + `openShadowRoots` helper in
   `formScanner.ts`.
2. `test/fixtures/successfactors.ts` + `test/successfactors.test.ts` +
   `observePage`/`openShadowRoots` unit tests.
3. `docs/ats-coverage.md`: SuccessFactors `[x]`, **Progress 5/15** (Hard tier
   complete).
4. Commits on `feat/successfactors-autofill-hardening`, suite + smoke green.
