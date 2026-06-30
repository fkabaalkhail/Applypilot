# Custom dropdown AI fill — design

- **Date:** 2026-06-29
- **Status:** Approved (ready for implementation plan)
- **Area:** chrome-extension (content script), backend `/api/fill`

## Problem

Users report that the extension and AI cannot handle dropdown fields: the AI gives
no suggestions for dropdowns, and autofill does not fill them even when an answer
exists. Investigation confirms this for **custom dropdowns** (ARIA comboboxes —
react-select, Workday, Greenhouse, Lever, Ashby), which are the common case on
modern ATS forms. Native `<select>` dropdowns already work end to end.

Custom dropdowns (`controlType === "combobox"`) are second-class in the pipeline:

1. **Options are never read.** `formScanner.ts:192` extracts options only when the
   element is an `HTMLSelectElement`; a combobox gets `options === undefined`.
2. **They are excluded from the AI.** `aiFillPlanner.ts:31`:
   `if (field.controlType === "combobox") return false;` (comment: "Out of scope
   for AI fill for now"). The AI is never asked about them, so there are no
   suggestions.
3. **They fill only from a direct profile match.** `contentScript.ts:208` skips any
   combobox with `proposedValue === null`. The combobox filler (`comboboxEngine.ts`)
   works, but is never handed an AI-derived or memory-derived answer.

The fill executors confirm the gap: `writeEngine.ts:51` returns `UNFILLABLE` for
comboboxes (they must be driven asynchronously), and both AI fill paths route
through `writeControl` — silent simple targets via the reconciler
(`contentScript.ts:252`) and accepted review drafts via `onInsertAnswer`
(`contentScript.ts:263`, reached from `overlay.ts:1343`).

Backend context: `fill.py` snaps the AI's answer to a real option **only when
`options` is provided** (`fill.py:216`). With no options sent for comboboxes, the
AI answers as free text. Separately, `fill.py:218` falls back to `options[0]` when
no option matches, which can silently select a "Select…" placeholder.

## Implementation status (as of 2026-06-29)

Commit `4eace4d` ("wire custom dropdowns into the AI fill pipeline"), recovered
onto `feat/dropdown-ai-fill`, already landed the **routing half** of this design:

- **Part 2 (AI candidacy):** `isAiCandidate` treats a combobox as a choice field
  (still skips sensitive/EEO). Done. *Remaining:* `mapType(combobox) → "select"`
  is not yet done — it still falls through to the `"text"` default.
- **Part 3 (route AI answers to the live filler):** `fillComboboxFields` was
  generalised to `fillComboboxTargets({ fieldId, value }[])`; the `isComboboxField`
  helper, the silent-target combobox/non-combobox split, the `onInsertAnswer`
  combobox branch, and the extra `tallyOutcomes` group are all in place. Done.
- **Part 5 (tests):** the `isAiCandidate` combobox test is added. Partial.

The implementation plan therefore covers only the **remaining** work: part 1
(cheap option reading in `comboboxEngine` + `formScanner`), the `mapType` tweak,
part 4 (backend `fill.py`), and the remaining tests. The blind-AI behaviour that
`4eace4d` shipped is most likely why dropdowns still fail in practice — part 1 is
what lets the AI see the real options and snap to them.

## Goal

Make custom dropdowns first-class in the read → suggest → fill pipeline, matching
native `<select>` behaviour, **without opening any menu during the page scan**
(opening at scan time causes focus theft, flicker, and churn the existing design
deliberately avoids; chosen approach: reuse the live filler + cheap option reads).

### Non-goals

- Opening dropdowns during scan to harvest exhaustive option lists.
- Multi-select comboboxes (single value only, as today).
- Drift-tracking comboboxes — they remain one-shot, filled during the autofill
  pass and never re-driven on mutation (`contentScript.ts:196-216` rationale).

## Design

### 1. Read combobox options cheaply — `comboboxEngine.ts` + `formScanner.ts`

Add an exported helper to `comboboxEngine.ts` (it already owns combobox DOM
knowledge: `getListbox`, `optionText`):

```ts
/** Read a combobox's options WITHOUT opening it. Returns undefined when the
 *  options are not already present in the DOM (the blind-AI fallback case). */
export function readComboboxOptions(trigger: HTMLElement): string[] | undefined;
```

Behaviour:

- Resolve the referenced listbox via `aria-controls` / `aria-owns`
  (`document.getElementById`), then a same-container `[role="listbox"]` fallback.
- Read `[role="option"]` labels via the existing `optionText`, dropping
  `aria-disabled="true"` and empty entries, trimmed to 60 (mirrors
  `selectOptions` in `formScanner.ts`).
- Do **not** open the menu and do **not** require visibility — a mounted-but-hidden
  listbox is a valid cheap source.
- Return `undefined` when nothing is found.

In `formScanner.ts`, change the options assignment (currently line 192):

```ts
const options =
  el instanceof HTMLSelectElement
    ? selectOptions(el)
    : controlType === "combobox"
      ? readComboboxOptions(el)
      : undefined;
```

Add a best-effort `combobox` case to `currentValueOf` (`formScanner.ts:252`) using
the combobox's displayed value (button text / input value / `[class*="single-value"]`
element). Extract this from the existing `comboboxShowsValue` logic in
`comboboxEngine.ts` into a small exported `readComboboxValue(trigger): string | undefined`
that both functions reuse. This stops an already-selected dropdown from being
re-suggested (`aiFillCandidates` filters on `!f.currentValue`).

### 2. Let comboboxes reach the AI — `aiFillPlanner.ts`

- In `isAiCandidate`, delete the combobox early-return (line 31) and add `combobox`
  to the choice-control branch that returns `true` (alongside `select`,
  `radioGroup`, `checkbox`).
- In `mapType`, add `case "combobox": return "select";`.
- `toAiFillField` is unchanged — `options: field.options ?? []` already coalesces
  the `undefined` (no cheap options) case to `[]`.

### 3. Route AI answers to the live filler — `contentScript.ts`

`writeControl` / `verifyControl` stay unchanged (comboboxes remain `UNFILLABLE`
there — they are async by nature). The routing changes live entirely in
`contentScript.ts`:

- **Refactor `fillComboboxFields`** to take explicit values rather than reading
  `proposedValue`:
  ```ts
  async function fillComboboxFields(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ fieldId: string; ok: boolean }[]>
  ```
  Phase 1b (profile fill) passes
  `selected.filter(combobox).map(f => ({ fieldId: f.id, value: f.proposedValue }))`.

- **AI simple targets** (rule / generic-memory answers, `needsReview === false`):
  in `onAutofill` Phase 2, split `plan.simpleTargets` by the registry control type.
  Combobox targets go through `fillComboboxFields`; the rest through
  `getEngine().addTargets(...)` as today.

- **Accepted AI drafts** (`onInsertAnswer`, `contentScript.ts:263`): if the
  registered control is a combobox, `await fillAriaCombobox(el, value)` and map the
  `ComboboxResult` to `{ ok, reason }`; otherwise `writeControl` + `verifyControl`
  as today.

- Fold the combobox outcomes from both AI sub-paths into `tallyOutcomes`
  (`contentScript.ts:260`).

This reuses the battle-tested `fillAriaCombobox`, which opens the menu live and
fuzzy-matches the answer (`comboboxEngine.ts` → `findOption` → `matchOption`,
including verbose-answer matching already covered by tests).

### 4. Backend robustness — `fill.py`

In the AI generation pass, change the option-snapping fallback (`fill.py:216-218`):

```python
if field.options:
    matched_opt = _match_option(answer, field.options)
    if matched_opt:
        answer = matched_opt
    # else: keep the AI's raw answer; let the client fuzzy-match or surface
    # "select manually" instead of silently picking options[0] (often "Select…").
```

The client matchers (`writeSelect` for native, `fillAriaCombobox` for custom) then
get a fair attempt, and a real no-match surfaces honestly. Benefits both native
`<select>` and custom dropdowns. This touches the shared `/api/fill` endpoint used
by both the extension and the web frontend.

## Data flow (after change)

```
scanPage (formScanner)
  combobox → readComboboxOptions() [no open] → options (maybe), currentValue (maybe)
        │
        ▼
aiFillCandidates → combobox now eligible (empty + no proposed value)
        │  toAiFillField: type "select", options ?? []
        ▼
POST /api/fill
  rule/profile → silent;  generic memory → silent;
  AI → needsReview=true (snapped to option only when options present;
       otherwise raw answer, no options[0] coercion)
        │
        ▼
planAiFill
  needsReview=false → simpleTargets       needsReview=true → drafts (review cards)
        │                                          │
   split by control type                    user Accept → onInsertAnswer
   combobox → fillComboboxFields            combobox → fillAriaCombobox
   else     → reconciler.addTargets         else     → writeControl
        └──────────────┬─────────────────────────┘
                       ▼
                  tallyOutcomes
```

## Testing

- **`aiFillPlanner.test.ts`**: combobox is an AI candidate; `aiFillCandidates`
  includes an empty combobox; `mapType("combobox") === "select"`; options pass
  through `toAiFillField`.
- **`comboboxEngine.test.ts`**: `readComboboxOptions` reads labels from an
  `aria-controls` listbox without opening and without requiring visibility;
  returns `undefined` when no listbox is present; `readComboboxValue` reads a
  selected single-value.
- **`formScanner`** (jsdom): a combobox field surfaces `options` and `currentValue`;
  an empty combobox is offered to AI fill.
- **Backend `test_fill_memory.py`**: when the AI answer matches no option, the
  returned answer is the raw answer (not `options[0]`); when it matches, it snaps.

## Risks & trade-offs

- **Blind AI when options can't be read.** When a combobox keeps its options out of
  the DOM until opened, the AI answers from the label alone. Mitigated by the
  filler's fuzzy matching and the option snapping that still happens whenever cheap
  options are available.
- **Shared backend endpoint.** The `fill.py` change affects the web frontend too;
  it is strictly more honest (no placeholder coercion) but is a behaviour change to
  call out in review.
- **One-shot fill semantics preserved.** Comboboxes are still not handed to the
  reconciler for drift tracking, so no new focus-stealing churn is introduced.
