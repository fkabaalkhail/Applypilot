# Autofill reliability parity with Jobright 1.15.0 — implementation spec

**Date:** 2026-07-08
**Goal:** Make the Tailrd extension handle all field types, buttons, and ATS as
reliably as Jobright's `1.15.0_0` reference. Fix the header to use the real logo.

## Executive finding (from a full reverse-engineering of `1.15.0_0`)

Our extension is **not architecturally behind** Jobright. Direct comparison:

| Dimension | Jobright 1.15.0 | Tailrd (chrome-extension) | Verdict |
|---|---|---|---|
| ATS site coverage | ~105 host roots | 62 hosts, **all** major families + extras (careerplug, catsone, clearcompany, hiringthing, isolvedhire, prismhr, recruiterflow, ripplehire, sfagent, dover, kula, ycombinator…) | **Parity+** (miss only jibe, welcometothejungle) |
| Combobox/listbox | open→listbox→click option | Same + anti-contamination, commit-verify, multi-select, typeahead filter-clear, SF `title` read | **Ahead** |
| Honeypot/bot-trap detection | none | `isVisible`/`isClipHidden` clip+zero-area | **Ahead** |
| Idempotent write/verify + retry | fire-and-forget queue | reconciler verify-before-write, drift retry | **Ahead** |
| Option value matching | normalized `===` equality | exact→contains→numeric-range→token-overlap→shared-prefix | **Ahead** |
| Field label signals | XPath `preceding::label` + normalize | assoc/aria/labelledby(self-skip)/nearby/testId/widget-host | **Parity+** |

**Conclusion: do NOT rewrite the architecture.** A rewrite to Jobright's
TaskQueue/operations/GPT-centric model would regress the safety logic above. The
real reliability gaps are a handful of **specific field-type + value-commit**
weaknesses. Close those additively, each test-covered.

## The concrete gaps (what actually makes us "struggle on some sites")

### P0 — value-commit robustness (broadest impact, lowest risk)
Our `writeTextLike` fires `focus → nativeSet → input → change → blur`. Jobright's
`fillDefaultInputField` fires a *fuller* cascade whose extra events commit
typeaheads, masked inputs, and validation-on-keyup frameworks that our thinner
sequence leaves half-committed:
- **Enter `keydown`/`keyup` (keyCode/key 13/"Enter")** after change — commits
  autocomplete/typeahead selections and triggers "validate on Enter" handlers.
- **`composed: true`** on the InputEvent — so controls living in an open shadow
  root notify listeners delegated at the document (Workday, web components).
- Optional trailing `keydown`/`keyup` for the last char to wake keystroke-driven
  validators.

**Implement:** enrich `domUtils.dispatchInputEvents` to accept an options bag and
add `composed:true`; add `dispatchCommitKeys(el)` firing Enter down/up. Call the
richer sequence from `writeEngine.writeTextLike`. Keep the native setter.
**Tests:** assert the full event set + order on a spy element (jsdom).

### P0 — web-component / non-standard value setting
`setNativeValue` only walks `HTMLInputElement/TextArea/Select` prototypes. Custom
elements (ADP `sdf-select-simple`, Lightning, some Angular Material) expose value
via an own/instance setter, `setAttribute("value")`, or `setValue()`. When the
standard prototype setter is absent we silently no-op.

**Implement:** `setNativeValue` fallback chain — try prototype setter; then
walk the actual prototype chain for a `value` setter; then `el.value=v`; then
`el.setAttribute("value", v)`; then `el.setValue?.(v)`; OR-ing success. Fire a
`composed` input+change afterward.
**Tests:** custom element whose `value` setter lives on its own prototype; assert
it receives the value + events.

### P1 — date-picker widgets (a whole field class we don't fill)
We only handle native `<input type=date|month>`. ATS commonly render dates as:
1. three separate `<select>`s (Month / Day / Year),
2. three text inputs (MM / DD / YYYY) in a group,
3. a react-datepicker text input + calendar popup.

**Implement:** new `dateWidget.ts`. Detect a date group by label/name/testid
(`date`, `birth`, `graduation`, `start/end date`) or `.react-datepicker` ancestor.
Reuse `writeEngine.parseFlexibleDate` → parts; fill sub-selects via `matchOption`
(month as name **and** number), sub-inputs via the text path. Surface as a new
`RuntimeControl` variant driven async (like combobox). Fall back to the existing
native path untouched.
**Tests:** three-select group, three-input group, month-name vs numeric matching.

### P1 — custom checkbox/radio wrappers (hidden native input)
`writeCheckbox`/`writeRadioGroup` click the native input. When the real input is
visually hidden behind a styled `label`/`div[role=checkbox|radio]` (common on
Greenhouse/Ashby/Workday), clicking the hidden input doesn't drive the widget.

**Implement:** if the native control is not visible, also click the associated
`label` or the nearest `[role=checkbox]/[role=radio]` ancestor (Jobright's
`div[role=checkbox]` trick). Guarded so we never double-toggle a working checkbox
(verify desired state after).
**Tests:** hidden input + styled label; assert checked state ends correct, once.

### P1 — native `<select>` fuller commit
Some frameworks bind option selection to `mousedown/mouseup/click` on the
`<option>` and to `input` (not just `change`) on the select. Add those to
`writeSelect` after setting value.
**Tests:** select whose framework listens on option mouse events / `input`.

### P2 — phone country-code + dependent dropdowns
- Phone-code selects: extract `+NNN` from the answer and match an option whose
  text contains the code / `(NNN)` / `+ NNN` (Jobright's phone-code matcher).
- Country→State ordering: when both are comboboxes, fill country first and let
  the reconciler re-resolve state (state options depend on country). Infer
  country from a CA-province / US-state answer when the country field is empty.

### P2 — site registry top-up
Add `jibeapply.com`, `welcometothejungle.com`, and any missing apply-path
patterns so detection matches Jobright's universe exactly.

## Logo fix
Header currently renders an inline SVG brand mark (`overlay.ts` ~L269–282,
`.ap-brand-logo`). Real brand assets exist: `frontend/public/logo-icon.png`,
`frontend/public/logo-full.png`, `logos/`. Replace the inline SVG with the real
Tailrd icon, embedded as a base64 data URI (Shadow-DOM safe, no
web_accessible_resources round-trip, works offline). Keep the wordmark text.
**Verify:** build, load unpacked, header shows real logo; collapsed edge-tab too.

## Non-goals / explicitly preserved
- Keep reconciler verify-before-write idempotency and one-shot combobox drive.
- Keep honeypot/`isClipHidden` guards — never fill clipped/zero-area inputs.
- Keep anti-contamination `getListbox` logic.
- No architectural rewrite; no server/GPT-model change.

## Verification
1. `npm run build` + `npm run typecheck` clean.
2. `npm test` (vitest) green incl. new tests.
3. `npm run test:flow` / browser probes where feasible.
4. Manual load-unpacked smoke on a Greenhouse + Workday form.
5. Commit on a feature branch; do not push unless asked.

---

## OUTCOME — what shipped this session (branch `feat/autofill-reliability-parity`)

**Shipped + tested (662 vitest green, typecheck clean, verified in real Chromium):**
- **P0 value-commit cascade** — `dispatchCommitKeys` (Enter down/up, forced
  keyCode 13) + `composed:true` input/change; wired into `writeTextLike` for
  single-line inputs. Real-browser test confirmed it defeats a React-style
  controlled-input revert.
- **P0 web-component value setting** — `setNativeValue` fallback chain
  (prototype-chain setter → instance value → setAttribute → setValue/
  setAttributeValue). Real-browser test confirmed a custom-element setter fires.
- **P1 split-date `<select>`** — `matchSelectOption` reduces a full-date answer
  to Month/Day/Year when the option set is a date part; write+verify agree; zero
  scanner/contentScript change. Real-browser test: `1995-06-15` → June/15/1995.
- **Site registry parity** — added Jibe + Welcome to the Jungle.
- **Real logo** — header now renders a faithful inline SVG of the Tailrd origami
  paper-dart (CSP-safe), replacing the generic filled glyph.

**Key finding:** our engine was already at/ahead of Jobright on architecture,
combobox anti-contamination, honeypot detection, verify-retry, option matching,
and ATS coverage — so NO architectural rewrite was warranted (it would have
regressed safety logic Jobright lacks). Effort went to the real value-commit gaps.

**Deferred — need live ATS validation before shipping (higher blast radius):**
- **react-datepicker calendar popups** & 3-INPUT (not select) date groups — the
  self-contained select reduction covers the common 3-`<select>` case; calendar
  widgets need a new async driver + live testing.
- **Pure ARIA `role=checkbox`/`role=radio`** not backed by a native input — the
  scanner doesn't surface these; adding a control type is a scanner change best
  validated live.
- **Phone dial-code extraction** (`+NNN` from a phone number) — `matchOption`
  already handles country-name and `+1`-style answers; full dial-code parsing is
  a central-matcher change with regression risk, defer until a real failure case.
- **Custom checkbox/radio styled-wrapper clicking** — `el.click()` already sets
  the correct native value; only pure-CSS-`:checked` widgets that ignore the
  input would benefit, and the double-toggle risk needs live verification.
