# Checkbox Group Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix multi-checkbox "select all that apply" autofill (the "Ambiguous checkbox value" bug) by modeling related native checkboxes as one `checkboxGroup` multi-select field.

**Architecture:** Mirror native `radioGroup` grouping, but multi-select: group checkboxes sharing a `fieldset`/`[role=group]` (≥2), classify by the group's question, fill by checking the matching option(s). Extension-only (no backend change). TDD.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `fix/checkbox-group-support` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only**; preserve hard guarantees (never fill EEO unless toggle on + profile has it; never script file inputs; never submit). Standalone consent checkboxes stay excluded (existing `isConsentField`).
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: `checkboxGroup` control type — group, fill, verify, AI-eligible

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (ControlType)
- Modify: `chrome-extension/src/content/formScanner.ts` (RuntimeControl, grouping, signals, emission)
- Modify: `chrome-extension/src/content/writeEngine.ts` (write + verify)
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (candidate + type mapping)
- Test: `chrome-extension/test/checkboxGroup.test.ts` (new)

**Interfaces:**
- Produces: `ControlType` gains `"checkboxGroup"`; `RuntimeControl` gains `checkboxes?: HTMLInputElement[]`; `scanPage` emits one `checkboxGroup` per qualifying fieldset; `writeControl`/`verifyControl` check the matching boxes.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/checkboxGroup.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

function selectAllThatApply(legend: string, options: string[]): void {
  const fs = document.createElement("fieldset");
  const lg = document.createElement("legend");
  lg.textContent = legend;
  fs.append(lg);
  for (const opt of options) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = opt;
    cb.name = "q[]";
    label.append(cb, document.createTextNode(opt));
    fs.append(label);
  }
  document.body.append(fs);
}

const checkedValues = () =>
  Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map((c) => (c as HTMLInputElement).value);

describe("checkbox group — detection", () => {
  it("scans a 'select all that apply' fieldset as ONE checkboxGroup classified by its question", () => {
    selectAllThatApply("How did you hear about this opportunity? (select all that apply)", [
      "LinkedIn",
      "Glassdoor",
      "Notion Blog",
      "Conference or Meetup",
    ]);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields).toHaveLength(1);
    const f = fields[0];
    expect(f.controlType).toBe("checkboxGroup");
    expect(f.category).toBe("unknown"); // the question, not the option text
    expect(f.options).toEqual(["LinkedIn", "Glassdoor", "Notion Blog", "Conference or Meetup"]);
    expect(f.proposedValue).toBeNull(); // never writes a profile URL into it
  });
});

describe("checkbox group — fill", () => {
  it("checks the matching options without 'Ambiguous checkbox value'", () => {
    selectAllThatApply("How did you hear about this opportunity?", ["LinkedIn", "Glassdoor", "Notion Blog"]);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const control = registry.get(fields[0].id)!;

    const res = writeControl(control, "LinkedIn, Glassdoor");
    expect(res.written).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(verifyControl(control, "LinkedIn, Glassdoor")).toBe(true);
    expect(checkedValues().sort()).toEqual(["Glassdoor", "LinkedIn"]);
  });

  it("checks a single option for a single-value answer", () => {
    selectAllThatApply("How did you hear about us?", ["LinkedIn", "Glassdoor", "Notion Blog"]);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const control = registry.get(fields[0].id)!;
    expect(writeControl(control, "Notion Blog").written).toBe(true);
    expect(checkedValues()).toEqual(["Notion Blog"]);
  });
});

describe("standalone checkbox — unchanged", () => {
  it("a lone checkbox (no fieldset) stays a single boolean", () => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "relocate";
    label.append(cb, document.createTextNode("Willing to relocate"));
    document.body.append(label);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const f = fields[0];
    expect(f.controlType).toBe("checkbox");
    expect(writeControl(registry.get(f.id)!, "Yes").written).toBe(true);
    expect((document.getElementById("relocate") as HTMLInputElement).checked).toBe(true);
  });
});

describe("EEO checkbox group — gated", () => {
  it("is sensitive and skipped unless the EEO toggle is on", () => {
    selectAllThatApply("Race/Ethnicity (select all that apply)", ["Asian", "White", "Decline to self-identify"]);
    const off = scanPage(MOCK_PROFILE, false).fields[0];
    expect(off.category).toBe("eeoRace");
    expect(off.sensitive).toBe(true);
    expect(off.proposedValue).toBeNull();

    const withEeo: UserApplicationProfile = { ...MOCK_PROFILE, eeo: { race: "Asian" } };
    const on = scanPage(withEeo, true).fields[0];
    expect(on.proposedValue).toBe("Asian");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checkboxGroup.test.ts`
Expected: FAIL — checkboxes are scanned individually today (the fieldset yields 4 fields, mis-classified), so the detection assertions fail and there is no `checkboxGroup` control type.

- [ ] **Step 3: Add the control type**

In `chrome-extension/src/shared/types.ts`, add to the `ControlType` union (after `"radioGroup"`):
```ts
  | "radioGroup"
  | "checkboxGroup"
```

- [ ] **Step 4: Group checkboxes in the scanner**

In `chrome-extension/src/content/formScanner.ts`:

Add `checkboxes` to `RuntimeControl`:
```ts
export interface RuntimeControl {
  id: string;
  controlType: ControlType;
  /** Single element controls. */
  el?: HTMLElement;
  /** Radio groups: all members, in DOM order. */
  radios?: HTMLInputElement[];
  /** Native checkbox groups ("select all that apply"): all members, in DOM order. */
  checkboxes?: HTMLInputElement[];
}
```

Generalize `radioGroupSignals` into `groupSignals(members, containerSelector)` — replace the existing function:
```ts
function groupSignals(members: HTMLInputElement[], containerSelector: string): FieldSignals {
  const first = members[0];
  const container = first.closest(containerSelector);
  let label = "";
  if (container) {
    const legend = container.querySelector("legend");
    label = cleanText(legend?.textContent) || cleanText(container.getAttribute("aria-label"));
    if (!label) {
      const ids = container.getAttribute("aria-labelledby");
      if (ids) {
        label = cleanText(
          ids
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        );
      }
    }
  }
  const base = collectSignals(first);
  return {
    ...base,
    // The group question; individual option labels ("Yes"/"LinkedIn") are options.
    label: label || base.nearby,
    placeholder: "",
    typeHint: "",
  };
}
```

Update the radio-group call site (in the radio-groups emission loop) from
`radioGroupSignals(radios)` to:
```ts
    const signals = groupSignals(radios, 'fieldset, [role="radiogroup"]');
```

In `scanPage`, declare a checkbox-group accumulator next to `radioGroups`:
```ts
  const radioGroups = new Map<string, HTMLInputElement[]>();
  const checkboxGroups = new Map<Element, HTMLInputElement[]>();
```

In the candidate loop, immediately AFTER the radio-grouping `if (... el.type === "radio") { ... continue; }` block, add checkbox grouping:
```ts
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      const container = el.closest('fieldset, [role="group"]');
      if (container && container.querySelectorAll('input[type="checkbox"]').length >= 2) {
        const group = checkboxGroups.get(container) ?? [];
        group.push(el);
        checkboxGroups.set(container, group);
        continue; // emitted as one checkboxGroup below
      }
      // standalone checkbox → falls through to the single-control path
    }
```

After the radio-groups emission loop (the `for (const radios of radioGroups.values())` block), add the checkbox-groups emission loop:
```ts
  // Native checkbox groups ("select all that apply") become one logical field.
  for (const checkboxes of checkboxGroups.values()) {
    const first = checkboxes[0];
    const id = ensureFieldId(first);
    const signals = groupSignals(checkboxes, 'fieldset, [role="group"]');
    const { category, confidence, sensitive } = classifyField(signals);
    const options = checkboxes.map(radioOptionLabel).filter(Boolean).slice(0, 30);

    registry.set(id, { id, controlType: "checkboxGroup", checkboxes });

    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType: "checkboxGroup", options }, fillEEO)
      : null;

    const checkedLabels = checkboxes.filter((c) => c.checked).map(radioOptionLabel).filter(Boolean);
    fields.push({
      id,
      category,
      confidence,
      label: bestDisplayLabel(signals),
      controlType: "checkboxGroup",
      required: checkboxes.some((c) => isRequiredField(c, signals)),
      proposedValue,
      fillable: true,
      sensitive,
      note: noteFor("checkboxGroup", category),
      options,
      currentValue: checkedLabels.length ? checkedLabels.join(", ") : undefined,
    });
  }
```

(`radioOptionLabel` is reused for checkbox option labels — it reads `input.labels[0]` text or `value`, which is correct for checkboxes too.)

- [ ] **Step 5: Fill + verify `checkboxGroup` in the write engine**

In `chrome-extension/src/content/writeEngine.ts`:

Add the `writeControl` case (after the `radioGroup` case):
```ts
    case "checkboxGroup":
      return writeCheckboxGroup(control.checkboxes ?? [], value);
```

Add the `verifyControl` case (after the `radioGroup` case):
```ts
    case "checkboxGroup": {
      const live = (control.checkboxes ?? []).filter((c) => c.isConnected);
      if (live.length === 0) return false;
      const matched = answerParts(value)
        .map((p) => matchCheckbox(live, p))
        .filter((c): c is HTMLInputElement => c !== null);
      return matched.length > 0 && matched.every((c) => c.checked);
    }
```

Add these helpers near `matchRadio`:
```ts
/** Split a multi-select answer ("LinkedIn, Glassdoor") into option parts. */
function answerParts(value: string): string[] {
  const parts = value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [value.trim()].filter(Boolean);
}

function matchCheckbox(boxes: HTMLInputElement[], value: string): HTMLInputElement | null {
  const labelOf = (c: HTMLInputElement): string => cleanText(c.labels?.[0]?.textContent) || c.value;
  return matchOption(boxes, labelOf, (c) => c.value, value);
}

function writeCheckboxGroup(checkboxes: HTMLInputElement[], value: string): WriteResult {
  const live = checkboxes.filter((c) => c.isConnected);
  if (live.length === 0) return { written: false, reason: STALE };
  let any = false;
  for (const part of answerParts(value)) {
    const match = matchCheckbox(live, part);
    if (match) {
      if (!match.checked) match.click(); // additive — never unchecks the user's picks
      any = true;
    }
  }
  if (!any) return { written: false, reason: `No option matches "${truncate(value)}"` };
  return { written: true };
}
```

- [ ] **Step 6: Make `checkboxGroup` AI-eligible**

In `chrome-extension/src/content/aiFillPlanner.ts`:

In `isAiCandidate`, add `checkboxGroup` to the choice list:
```ts
  if (
    field.controlType === "select" ||
    field.controlType === "radioGroup" ||
    field.controlType === "checkbox" ||
    field.controlType === "checkboxGroup" ||
    field.controlType === "combobox"
  ) {
    return true;
  }
```

In `mapType`, add the case (so the AI gets the question + options):
```ts
    case "radioGroup":
      return "radio";
    case "checkboxGroup":
      return "select";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/checkboxGroup.test.ts`
Expected: PASS (5 tests). One `checkboxGroup` classified `unknown` (the question), options preserved, no profile URL written; "LinkedIn, Glassdoor" checks both boxes; single answer checks one; standalone checkbox unchanged; EEO group gated.

- [ ] **Step 8: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green; typecheck clean (the new `switch` cases satisfy exhaustiveness; if any other exhaustive `controlType` switch surfaces, add the `checkboxGroup` branch).

- [ ] **Step 9: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/formScanner.ts chrome-extension/src/content/writeEngine.ts chrome-extension/src/content/aiFillPlanner.ts chrome-extension/test/checkboxGroup.test.ts
git commit -m "fix(extension): model native checkbox groups (select all that apply)

A multi-checkbox 'select all that apply' question was scanned as N independent
booleans, each classified by its option text — so options matching a profile
category (LinkedIn, blog->portfolio) got a URL written into a checkbox, throwing
'Ambiguous checkbox value', and others went to the AI as contextless booleans.
Group checkboxes sharing a fieldset/[role=group] (>=2) into one checkboxGroup
classified by the question; fill by checking the matching option(s). Extension-only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Confirm regression + commit the spec/plan

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `checkboxGroup.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED` (the sample form's standalone/EEO checkboxes are unaffected).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit the spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-checkbox-group-support-design.md docs/superpowers/plans/2026-06-30-checkbox-group-support.md
git commit -m "docs: add checkbox-group support spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD (group detection, fill, standalone unchanged, EEO gated, suite/smoke green) → Task 1 tests + Task 2; §3 design (types/formScanner/writeEngine/aiFillPlanner) → Task 1 Steps 3–6; §4 testing → Task 1 Step 1 + Task 2; §6 deliverables → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** `"checkboxGroup"` added to `ControlType` and handled in `writeControl`/`verifyControl`; `RuntimeControl.checkboxes` defined (formScanner) + read (writeEngine via the imported type); `groupSignals(members, selector)` replaces `radioGroupSignals` and is called by both group loops; `answerParts`/`matchCheckbox`/`writeCheckboxGroup` defined once and used in both write + verify; `radioOptionLabel` reused for checkbox labels; `aiFillPlanner` choice list + `mapType` updated. ✓

**Empirical basis:** the per-option mis-classification + "Ambiguous checkbox value" is probe-reproduced; grouping by `fieldset`/`[role=group]` with ≥2 checkboxes targets the "select all that apply" shape while leaving standalone consent checkboxes (already filtered by `isConsentField`) and lone checkboxes untouched.
