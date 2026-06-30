# Checkbox Group Support — Design

**Date:** 2026-06-30
**Status:** Approved (design)
**Scope:** Chrome extension (`chrome-extension/`) autofill engine
**Type:** Bug fix (root-cause) — multi-checkbox "select all that apply" questions.

---

## 1. Problem & root cause

On a Notion/Greenhouse "How did you hear about this opportunity? (select all that
apply)" question (native checkboxes), the extension throws **"Ambiguous checkbox
value"** and the AI lists options as free text instead of selecting them. Free-text
questions work; multi-checkbox questions don't.

**Root cause (reproduced via probe):** the engine has **no concept of a checkbox
group**. Native radios are grouped into one logical `radioGroup` field, but
checkboxes are each scanned as an **independent boolean**. So a "select all that
apply" question becomes N checkboxes, each classified by its **option text** (and
leaking adjacent option text through nearby-text):

```
[checkbox] "LinkedIn"   => linkedin  value "https://linkedin.com/in/johndoe"
[checkbox] "Glassdoor"  => linkedin  value "https://linkedin.com/in/johndoe"
[checkbox] "Notion Blog"=> portfolio value "https://johndoe.com"
```

Options whose text matches a profile category get a non-boolean profile **value**
(a URL), and `writeCheckbox` only accepts yes/no/true/false → **"Ambiguous checkbox
value."** Options matching no category go to the AI labelled with the bare option
text (no question context), so the AI replies with free text / lists that also
can't be written to a boolean. The group **question** lives in a `<legend>` and is
never treated as a field.

---

## 2. Goal & definition of done

Model a set of related native checkboxes as **one logical multi-select field** so a
"select all that apply" question is classified by its question and filled by
*checking* the matching option(s).

**Done when:**

1. A faithful "select all that apply" fixture is detected as **one** `checkboxGroup`
   field (question-classified, options = the checkbox labels) — not N mis-classified
   booleans — and filling checks the matching box(es) with **no "Ambiguous checkbox
   value"**.
2. A standalone checkbox (e.g. "I agree") still behaves as a single boolean.
3. An EEO "select all that apply" group is detected sensitive and skipped unless the
   EEO toggle is on (then the matching box is checked).
4. Full suite + `node test/scan-smoke.mjs` green; `tsc` clean.

**Decision (made):** **extension-only.** The AI answers the group via the existing
"select" path with the real question + options; the extension checks every option
named in the answer. No backend change. A single-option answer checks one box; a
multi-value answer ("LinkedIn, Glassdoor") checks both.

---

## 3. Design (mirrors `radioGroup` / `ariaRadioGroup`, multi-select)

- **`src/shared/types.ts`**: add `"checkboxGroup"` to `ControlType`; add
  `checkboxes?: HTMLInputElement[]` to `RuntimeControl`.
- **`src/content/formScanner.ts`**:
  - Group checkboxes that share an enclosing `fieldset` / `[role="group"]`
    **when that container holds ≥2 checkboxes** (`container.querySelectorAll('input[type="checkbox"]').length >= 2`). Such checkboxes are deferred (like radios) and emitted as one `checkboxGroup`; a standalone checkbox (no such container, or a container with one) flows through the existing single-`checkbox` path unchanged.
  - Signals from the group container's legend / `aria-label` (generalize
    `radioGroupSignals` into `groupSignals(members, containerSelector)` used by both
    radios — `fieldset, [role="radiogroup"]` — and checkbox groups — `fieldset,
    [role="group"]`). So the **question** is classified, not the options.
  - `options` = the checkbox labels; `currentValue` = the checked labels joined;
    `fillable: true`; `required` if any member is required.
- **`src/content/writeEngine.ts`**: `writeControl`/`verifyControl` for
  `"checkboxGroup"` — split the answer on `, ; newline`; for each part find the
  matching checkbox via the shared `matchOption` (label / value) and `click()` it if
  unchecked; verify that every matched part is checked (and ≥1 matched). Additive —
  never unchecks the user's existing selections.
- **`src/content/aiFillPlanner.ts`**: `isAiCandidate` includes `checkboxGroup`;
  `mapType` → `"select"` (so the AI gets the question + options).

No `fieldMatcher` change: profile resolution is category-based, and the group's
write matches the resolved value (e.g. EEO `eeoRace` → "Asian") against the options.
No `contentScript` change: `checkboxGroup` is not a combobox, so it already routes
through the reconciler's `writeControl`.

> **Methodology: TDD.** A failing scan+fill test for a "select all that apply" group
> (reproducing the probe) is written first, then the change makes it green, with the
> full suite + smoke as the regression guard.

---

## 4. Testing

`chrome-extension/test/checkboxGroup.test.ts` (vitest/jsdom, `stubLayout`):

- **Detection:** a Notion-style `<fieldset><legend>How did you hear…?</legend>` with
  ≥2 checkbox options → exactly **one** `checkboxGroup` field, category `unknown`
  (the question), `options` = the labels; **no** per-option `linkedin`/`portfolio`
  mis-classification; with a profile, `proposedValue` is null (unknown) so the
  profile pass never writes a URL into it.
- **Fill:** `writeControl(group, "LinkedIn")` checks only the LinkedIn box;
  `writeControl(group, "LinkedIn, Glassdoor")` checks both; `verifyControl` agrees;
  no "Ambiguous checkbox value".
- **Standalone checkbox:** a lone `<label><input type=checkbox>I agree</label>` still
  scans as a single `checkbox` and fills from "Yes".
- **EEO group:** a "Race/Ethnicity (select all that apply)" fieldset → `checkboxGroup`
  sensitive; untouched with `fillEEO=false`; the matching box checked with
  `fillEEO=true` + `profile.eeo.race`.
- Regression guard: full `npx vitest run` + `node test/scan-smoke.mjs`; `tsc` clean.

---

## 5. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Over-grouping unrelated checkboxes sharing a fieldset | Require an enclosing `fieldset`/`[role=group]` **with ≥2 checkboxes** — the dominant "select all that apply" shape; standalone consent checkboxes are untouched. |
| New control type misses a `switch` branch | TypeScript exhaustiveness in `writeEngine`/`formScanner` forces the new case; full suite guards. |
| AI returns one option for a true multi-select | Acceptable (often the right answer for "how did you hear"); a multi-value answer is honored. Backend multiselect is a deferred follow-up. |

---

## 6. Deliverables

1. `checkboxGroup` support: `types.ts`, `formScanner.ts`, `writeEngine.ts`,
   `aiFillPlanner.ts`.
2. `test/checkboxGroup.test.ts`.
3. Commits on `fix/checkbox-group-support`, suite + smoke green.
