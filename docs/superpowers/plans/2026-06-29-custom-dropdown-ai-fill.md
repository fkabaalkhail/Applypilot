# Custom dropdown AI fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make custom dropdowns (ARIA comboboxes) readable by the AI so it suggests values for them and autofill snaps to the right option — completing the work that `4eace4d` started.

**Architecture:** `4eace4d` already made comboboxes AI candidates and routed AI/memory answers through the live listbox filler (`fillAriaCombobox`). This plan adds the missing half: read a combobox's options at scan time *when they are already in the DOM* (never opening the menu), map combobox → `"select"` for the backend, and stop the backend from snapping a non-matching AI answer to a placeholder. The reading logic lives in `comboboxEngine.ts` (which already owns combobox DOM knowledge) and is consumed by `formScanner.ts`.

**Tech Stack:** TypeScript (Chrome MV3 content script, esbuild), Vitest + jsdom for extension tests; FastAPI + Pydantic backend, Pytest for backend tests.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-29-custom-dropdown-ai-fill-design.md` — implement only the *remaining* parts (option reading, `mapType`, backend `fill.py`, tests). Parts 2 & 3 are already in `4eace4d`.
- **Branch:** work on `feat/dropdown-ai-fill` (current branch). Do not commit to `main`.
- **Never open a dropdown during scan.** Option reading must be passive — no `click`/`focus`/`mousedown` on the trigger, no listbox mounting. If options aren't already in the DOM, return `undefined` (blind-AI fallback, by design).
- **Extension tests:** run via `node node_modules/vitest/vitest.mjs run <path>` from `chrome-extension/` — NOT `npm test` (known stdio quirk that exits 1 with no output). Environment is jsdom; no network.
- **Backend tests:** add to `backend/tests/test_fill_memory.py`, which uses an isolated SQLite app with mocked embeddings/LLM. Do NOT use `conftest.py`'s `client` fixture — it enters the real app lifespan and migrates the Neon dev DB.
- **TypeScript:** strict; verify with `npm run typecheck` from `chrome-extension/`.
- **Discipline:** DRY, YAGNI, TDD (failing test first), one commit per task.

## File Structure

- `chrome-extension/src/content/comboboxEngine.ts` (modify) — add `readComboboxOptions` + `readComboboxValue` exports; refactor `comboboxShowsValue` to share value-extraction helpers. Owns all combobox DOM reading.
- `chrome-extension/src/content/formScanner.ts` (modify) — call the two new readers when classifying a combobox.
- `chrome-extension/src/content/aiFillPlanner.ts` (modify) — `mapType(combobox) → "select"`.
- `backend/routers/fill.py` (modify) — keep raw AI answer when no option matches.
- `chrome-extension/test/comboboxEngine.test.ts` (modify) — tests for the two readers.
- `chrome-extension/test/formScanner.test.ts` (create) — combobox scan integration test.
- `chrome-extension/test/aiFillPlanner.test.ts` (modify) — `mapType` combobox test.
- `backend/tests/test_fill_memory.py` (modify) — option-snapping tests.

---

### Task 1: Combobox option + value readers

**Files:**
- Modify: `chrome-extension/src/content/comboboxEngine.ts`
- Test: `chrome-extension/test/comboboxEngine.test.ts`

**Interfaces:**
- Consumes: existing `optionText`, `hasOptions`, `deepQueryAll`, `cleanText` in `comboboxEngine.ts`.
- Produces:
  - `readComboboxOptions(trigger: HTMLElement): string[] | undefined` — option labels from an already-mounted listbox, max 60, `aria-disabled` excluded; `undefined` when no listbox is mounted. Never opens the menu.
  - `readComboboxValue(trigger: HTMLElement): string | undefined` — the committed displayed value (single/multi-value element, `aria-activedescendant`, or input value), ignoring raw `<button>` placeholder text; `undefined` when nothing is committed.

- [ ] **Step 1: Write the failing tests**

Add to the top import in `chrome-extension/test/comboboxEngine.test.ts` (replace the existing import line):

```ts
import {
  fillAriaCombobox,
  isAriaCombobox,
  readComboboxOptions,
  readComboboxValue,
} from "../src/content/comboboxEngine";
```

Add this factory after the existing `buttonListbox` helper (it builds a combobox whose listbox is **already** in the DOM — the case the readers handle):

```ts
/** A combobox whose listbox is ALREADY mounted (optionally hidden), referenced
 *  by aria-controls — what readComboboxOptions reads without opening. */
function staticCombobox(
  options: string[],
  opts: { value?: string; hidden?: boolean } = {}
): HTMLInputElement {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", lbId);
  if (opts.value) {
    const sv = document.createElement("div");
    sv.className = "select__single-value";
    sv.textContent = opts.value;
    wrap.append(sv);
  }
  const lb = document.createElement("div");
  lb.id = lbId;
  lb.setAttribute("role", "listbox");
  if (opts.hidden) lb.setAttribute("hidden", "");
  for (const label of options) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    lb.append(o);
  }
  wrap.append(input, lb);
  document.body.append(wrap);
  return input;
}
```

Add these describe blocks at the end of the file:

```ts
describe("readComboboxOptions", () => {
  it("reads options from a mounted listbox without opening", () => {
    const el = staticCombobox(["United States", "Canada", "Mexico"]);
    expect(readComboboxOptions(el)).toEqual(["United States", "Canada", "Mexico"]);
    expect(el.getAttribute("aria-expanded")).toBe("false"); // never opened
  });

  it("reads options even when the listbox is hidden", () => {
    const el = staticCombobox(["A", "B"], { hidden: true });
    expect(readComboboxOptions(el)).toEqual(["A", "B"]);
  });

  it("returns undefined when the menu is not mounted (react-select, closed)", () => {
    const el = reactSelect(["A", "B"]); // listbox only renders on open
    expect(readComboboxOptions(el)).toBeUndefined();
    expect(el.getAttribute("aria-expanded")).toBe("false");
  });

  it("skips aria-disabled options", () => {
    const el = staticCombobox(["A", "B"]);
    el.ownerDocument.querySelectorAll('[role="option"]')[1].setAttribute("aria-disabled", "true");
    expect(readComboboxOptions(el)).toEqual(["A"]);
  });
});

describe("readComboboxValue", () => {
  it("reads a committed single-value", () => {
    const el = staticCombobox(["A", "B"], { value: "B" });
    expect(readComboboxValue(el)).toBe("B");
  });

  it("ignores a button placeholder (no real selection)", () => {
    const btn = buttonListbox(["A", "B"]); // textContent is the 'Select…' placeholder
    expect(readComboboxValue(btn)).toBeUndefined();
  });

  it("returns undefined when nothing is selected", () => {
    const el = staticCombobox(["A", "B"]);
    expect(readComboboxValue(el)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/comboboxEngine.test.ts`
Expected: FAIL — `readComboboxOptions is not a function` / `readComboboxValue is not a function`.

- [ ] **Step 3: Implement the two readers**

In `chrome-extension/src/content/comboboxEngine.ts`, add the following exported functions plus two private helpers (place them in the "Listbox + option lookup" section, e.g. just after `findOption`). Function declarations are hoisted, so ordering relative to existing code does not matter:

```ts
/**
 * Read a combobox's option labels WITHOUT opening it — only when the listbox is
 * already mounted in the DOM. Many widgets keep a hidden listbox; react-select
 * mounts it lazily on open, so this returns undefined there (the AI then answers
 * from the label alone). Visibility is ignored on purpose: a mounted-but-hidden
 * listbox is a valid source.
 */
export function readComboboxOptions(trigger: HTMLElement): string[] | undefined {
  const listbox = findMountedListbox(trigger);
  if (!listbox) return undefined;
  const labels = deepQueryAll(listbox, '[role="option"]')
    .filter((o) => o.getAttribute("aria-disabled") !== "true")
    .map((o) => optionText(o))
    .filter((t) => t.length > 0)
    .slice(0, 60);
  return labels.length > 0 ? labels : undefined;
}

/** The combobox's listbox if it is already in the DOM (no opening, any visibility). */
function findMountedListbox(trigger: HTMLElement): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const ids = `${trigger.getAttribute("aria-controls") ?? ""} ${trigger.getAttribute("aria-owns") ?? ""}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const lb = (el.getAttribute("role") === "listbox" ? el : el.querySelector('[role="listbox"]')) as HTMLElement | null;
    if (lb && hasOptions(lb)) return lb;
  }
  // Same-container fallback: a listbox rendered next to the trigger (not a
  // document-wide search, which could grab an unrelated open menu at scan time).
  const container =
    trigger.closest('[class*="select" i], [class*="combobox" i], [role="combobox"]') ?? trigger.parentElement;
  const lb = container?.querySelector('[role="listbox"]') as HTMLElement | null;
  return lb && hasOptions(lb) ? lb : null;
}

/**
 * The combobox's currently-displayed value, if one is committed — best-effort,
 * for scan-time "already answered?" detection. Deliberately ignores raw <button>
 * text (often a "Select…" placeholder) and reads only strong selection signals.
 */
export function readComboboxValue(trigger: HTMLElement): string | undefined {
  const candidates = [
    trigger instanceof HTMLInputElement ? trigger.value : "",
    activeDescendantText(trigger),
    ...valueContainerTexts(trigger),
  ];
  for (const c of candidates) {
    const v = cleanText(c);
    if (v) return v;
  }
  return undefined;
}

/** Text of the option referenced by aria-activedescendant, if any. */
function activeDescendantText(trigger: HTMLElement): string {
  const active = trigger.getAttribute("aria-activedescendant");
  if (!active) return "";
  const opt = trigger.ownerDocument.getElementById(active);
  return opt ? optionText(opt) : "";
}

/** Texts of react-select-style single/multi-value display elements near the trigger. */
function valueContainerTexts(trigger: HTMLElement): string[] {
  const container =
    trigger.closest('[class*="select" i], [class*="combobox" i], [role="combobox"]') ??
    trigger.parentElement ??
    trigger;
  return Array.from(
    container.querySelectorAll(
      '[class*="single-value" i], [class*="singlevalue" i], [class*="multi-value" i], [class*="multivalue" i]'
    )
  ).map((e) => cleanText(e.textContent));
}
```

Then refactor the existing `comboboxShowsValue` to reuse these helpers (keeps the fill-path behaviour identical — it still includes `<button>` text). Replace the current body:

```ts
/** Whether the combobox's committed/displayed value reflects the target. */
function comboboxShowsValue(trigger: HTMLElement, value: string): boolean {
  const candidates: string[] = [];
  if (trigger instanceof HTMLInputElement && trigger.value) candidates.push(trigger.value);
  if (trigger.tagName === "BUTTON") candidates.push(cleanText(trigger.textContent));
  const active = activeDescendantText(trigger);
  if (active) candidates.push(active);
  candidates.push(...valueContainerTexts(trigger));
  return candidates.some((c) => textMatches(c, value));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/comboboxEngine.test.ts`
Expected: PASS (all `readComboboxOptions`, `readComboboxValue`, and the unchanged `fillAriaCombobox`/`isAriaCombobox` suites green).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/comboboxEngine.ts chrome-extension/test/comboboxEngine.test.ts
git commit -m "feat(extension): read combobox options + value without opening the menu

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Surface combobox options + current value in the scanner

**Files:**
- Modify: `chrome-extension/src/content/formScanner.ts:192` (options assignment) and `currentValueOf` (`formScanner.ts:252`)
- Test: `chrome-extension/test/formScanner.test.ts` (create)

**Interfaces:**
- Consumes: `readComboboxOptions`, `readComboboxValue` from Task 1; existing `scanPage(profile, fillEEO)`.
- Produces: a `DetectedField` with `controlType: "combobox"` now carries `options` (when mounted) and `currentValue` (when committed).

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/formScanner.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

/** A combobox with a mounted listbox and an aria-label (so the scanner's
 *  relaxed-visibility path accepts it under jsdom, which reports zero rects). */
function labeledCombobox(
  options: string[],
  opts: { label: string; value?: string }
): void {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", opts.label);
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", lbId);
  if (opts.value) {
    const sv = document.createElement("div");
    sv.className = "select__single-value";
    sv.textContent = opts.value;
    wrap.append(sv);
  }
  const lb = document.createElement("div");
  lb.id = lbId;
  lb.setAttribute("role", "listbox");
  for (const label of options) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    lb.append(o);
  }
  wrap.append(input, lb);
  document.body.append(wrap);
}

describe("scanPage — custom dropdowns", () => {
  it("surfaces a combobox's options and committed value", () => {
    labeledCombobox(["United States", "Canada"], { label: "Country", value: "Canada" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.options).toEqual(["United States", "Canada"]);
    expect(combo!.currentValue).toBe("Canada");
  });

  it("reads options for an empty combobox and leaves currentValue undefined", () => {
    labeledCombobox(["Yes", "No"], { label: "Authorized to work?" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo!.options).toEqual(["Yes", "No"]);
    expect(combo!.currentValue).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/formScanner.test.ts`
Expected: FAIL — `combo.options` is `undefined` (scanner doesn't read combobox options yet), so `toEqual(["United States", "Canada"])` fails.

- [ ] **Step 3: Wire the readers into the scanner**

In `chrome-extension/src/content/formScanner.ts`, update the import from `./comboboxEngine` (currently `import { isAriaCombobox } from "./comboboxEngine";`):

```ts
import { isAriaCombobox, readComboboxOptions, readComboboxValue } from "./comboboxEngine";
```

Replace the options assignment (currently `formScanner.ts:192-193`):

```ts
    const options =
      el instanceof HTMLSelectElement
        ? selectOptions(el)
        : controlType === "combobox"
          ? readComboboxOptions(el)
          : undefined;
```

In `currentValueOf` (`formScanner.ts:252`), add a combobox branch before the final `return undefined;`:

```ts
  if (controlType === "combobox") {
    return readComboboxValue(el);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/formScanner.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/test/formScanner.test.ts
git commit -m "feat(extension): surface custom-dropdown options and value in the scan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Map combobox to a select choice field for the AI

**Files:**
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (`mapType`, `aiFillPlanner.ts:51`)
- Test: `chrome-extension/test/aiFillPlanner.test.ts`

**Interfaces:**
- Consumes: existing `toAiFillField(field)` / `mapType(controlType)`; `field()` test factory.
- Produces: `toAiFillField` for a combobox returns `type: "select"` (so the backend treats it as a constrained choice when options are present).

- [ ] **Step 1: Write the failing test**

In `chrome-extension/test/aiFillPlanner.test.ts`, add inside the existing `describe("toAiFillField", …)` block:

```ts
  it("maps a custom dropdown (combobox) to a select choice field", () => {
    expect(toAiFillField(field({ controlType: "combobox", options: ["A", "B"] })).type).toBe("select");
    expect(toAiFillField(field({ controlType: "combobox", options: ["A", "B"] })).options).toEqual(["A", "B"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/aiFillPlanner.test.ts`
Expected: FAIL — received `"text"` (combobox currently hits the `default` branch), expected `"select"`.

- [ ] **Step 3: Add the combobox case to `mapType`**

In `chrome-extension/src/content/aiFillPlanner.ts`, add a case to the `mapType` switch (before `default`):

```ts
    case "checkbox":
      return "checkbox";
    // Custom ARIA dropdown — a single-choice control; the backend snaps the
    // answer to one of `options` when present (see backend/routers/fill.py).
    case "combobox":
      return "select";
    default:
      return "text";
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/aiFillPlanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/aiFillPlanner.ts chrome-extension/test/aiFillPlanner.test.ts
git commit -m "feat(extension): map combobox to a select field for AI fill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Stop the backend snapping non-matching answers to a placeholder

**Files:**
- Modify: `backend/routers/fill.py:216-218`
- Test: `backend/tests/test_fill_memory.py`

**Interfaces:**
- Consumes: existing `/api/fill` endpoint, `_match_option(answer, options)`, the isolated test app + `client`/`db_session` fixtures + `_ANSWER` mock target in `test_fill_memory.py`.
- Produces: when no option matches the AI answer, the response keeps the raw AI answer instead of `options[0]`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_fill_memory.py`:

```python
def test_ai_answer_kept_when_no_option_matches(client):
    # No saved answers -> straight to the AI pass. The field HAS options but the
    # AI answer matches none; it must NOT be snapped to options[0] ("Select…").
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, AsyncMock(return_value="Gold")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "Gold"  # not "Select…"
    assert ans["source"] == "ai"


def test_ai_answer_snaps_to_a_matching_option(client):
    body = {
        "fields": [{
            "id": "f1",
            "label": "Favourite metal?",
            "type": "select",
            "options": ["Select…", "Silver", "Bronze"],
        }]
    }
    with patch(_ANSWER, AsyncMock(return_value="silver")):
        resp = client.post("/api/fill", json=body)
    assert resp.status_code == 200
    ans = resp.json()["answers"][0]
    assert ans["answer"] == "Silver"  # snapped to the real option, original casing
```

- [ ] **Step 2: Run the tests to verify the new failing one fails**

Run (from repo root): `python -m pytest backend/tests/test_fill_memory.py -v`
Expected: `test_ai_answer_kept_when_no_option_matches` FAILS (`assert "Select…" == "Gold"`); `test_ai_answer_snaps_to_a_matching_option` already PASSES (snapping works today).

- [ ] **Step 3: Keep the raw answer when nothing matches**

In `backend/routers/fill.py`, replace the option-snapping block (currently lines 216-218):

```python
                    # Match to options if applicable. Keep the AI's raw answer
                    # when nothing matches — the client fuzzy-matches (writeSelect
                    # / fillAriaCombobox); snapping to options[0] used to silently
                    # select a "Select…" placeholder.
                    if field.options:
                        matched_opt = _match_option(answer, field.options)
                        if matched_opt:
                            answer = matched_opt
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from repo root): `python -m pytest backend/tests/test_fill_memory.py -v`
Expected: PASS (both new tests, plus the four pre-existing memory tests still green).

- [ ] **Step 5: Commit**

```bash
git add backend/routers/fill.py backend/tests/test_fill_memory.py
git commit -m "fix(backend): keep AI answer when no option matches (no placeholder snap)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only).

**Interfaces:** confirms Tasks 1-4 integrate cleanly.

- [ ] **Step 1: Type-check the extension**

Run (from `chrome-extension/`): `npm run typecheck`
Expected: no output, exit 0 (clean `tsc --noEmit`).

- [ ] **Step 2: Run the full extension test suite**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run`
Expected: PASS — all suites, including the pre-existing `aiFillPlanner`, `comboboxEngine`, `writeEngine`, `reconciler`, and `crossFrame` tests, plus the new `formScanner` suite.

- [ ] **Step 3: Run the backend fill tests**

Run (from repo root): `python -m pytest backend/tests/test_fill_memory.py -v`
Expected: PASS (six tests).

- [ ] **Step 4: Confirm clean tree and branch**

Run: `git status` (expect clean) and `git branch --show-current` (expect `feat/dropdown-ai-fill`).

---

## Self-Review

**Spec coverage:**
- Part 1 (read combobox options at scan time) → Task 1 (`readComboboxOptions` + `readComboboxValue`) + Task 2 (wire into `formScanner`). ✓
- `mapType(combobox) → "select"` → Task 3. ✓
- Part 4 (backend `options[0]` fallback) → Task 4. ✓
- Part 5 tests → Tasks 1-4 each ship tests; Task 5 runs the full suites. ✓
- Parts 2 & 3 (AI candidacy + routing) → already in `4eace4d`, intentionally not re-implemented (per spec "Implementation status"). ✓
- Non-goals (open at scan, multi-select, drift-tracking) → respected: readers never open; single-value only; no reconciler changes. ✓

**Placeholder scan:** every code step contains complete code; no TBD/TODO/"handle edge cases". ✓

**Type consistency:** `readComboboxOptions` returns `string[] | undefined` (consumed by `formScanner` options, typed `string[] | undefined` on `DetectedField`, coalesced to `[]` by `toAiFillField`). `readComboboxValue` returns `string | undefined` (matches `currentValueOf`'s `string | undefined`). `mapType` returns `AiFillField["type"]` and `"select"` is a member. Backend `answer` stays `str`. ✓
