# Autofill Repeating Sections (index-aware resolution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fill every repeating education/employment row a form already shows by resolving each field's row index against the matching profile array entry (`education[N]`/`experience[N]`).

**Architecture:** A pure `detectGroupIndex(signals)` extracts a field's 0-based row index from its name/id; `resolveProfileValue` becomes index-aware for education/employment categories; `formScanner` threads the index through the existing scanner→adapter→resolver path. No DOM mutation; non-repeating fields behave exactly as today.

**Tech Stack:** TypeScript (strict), esbuild (IIFE), vitest + jsdom.

## Global Constraints

- `detectGroupIndex` is pure (reads `signals.nameAttr` then `signals.idAttr`); returns the first `[N]` / `[._-]N[._-]` index, `null` if none, and `null` for spurious indices ≥ 50.
- Index-aware ONLY for education (`school`/`degree`/`graduationYear` → `education[gi ?? 0]`) and employment (`currentCompany`/`currentTitle` → `gi!==null ? experience[gi] : profile.current*`). All other categories ignore `groupIndex`. Out-of-range index → `null` (never throws).
- `groupIndex === null` reproduces pre-Phase-4 behavior byte-for-byte (education `[0]`, top-level `current*`). No DOM mutation; no add-row logic (deferred).
- No backend / Phase-1 driver / Phase-2 adapter-op / Phase-3 AI-fill changes.
- Branch `feature/autofill-repeating-groups`. Run vitest DIRECTLY (`npx vitest run <path>`), `npx tsc --noEmit`, `node build.mjs` — NOT `npm test`/`npm run typecheck` (exit 1, no output). Commit after each task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. TDD.

---

### Task 1: `detectGroupIndex` (pure)

**Files:**
- Create: `chrome-extension/src/content/groupIndex.ts`
- Test: `chrome-extension/test/groupIndex.test.ts`

**Interfaces:**
- Consumes: `FieldSignals` (`./domUtils`).
- Produces: `detectGroupIndex(signals: FieldSignals): number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/groupIndex.test.ts
import { describe, it, expect } from "vitest";
import { detectGroupIndex } from "../src/content/groupIndex";
import type { FieldSignals } from "../src/content/domUtils";

function sig(over: Partial<FieldSignals>): FieldSignals {
  return {
    label: "", ariaLabel: "", placeholder: "", nameAttr: "", testId: "",
    idAttr: "", nearby: "", typeHint: "", autocomplete: "", ...over,
  } as FieldSignals;
}

describe("detectGroupIndex", () => {
  it("reads a bracketed index from the name", () => {
    expect(detectGroupIndex(sig({ nameAttr: "education[1][school_name]" }))).toBe(1);
  });
  it("reads underscore- and dot- and dash-delimited indices", () => {
    expect(detectGroupIndex(sig({ nameAttr: "job_application_employments_attributes_2_title" }))).toBe(2);
    expect(detectGroupIndex(sig({ nameAttr: "edu.0.degree" }))).toBe(0);
    expect(detectGroupIndex(sig({ nameAttr: "emp-3-company" }))).toBe(3);
  });
  it("falls back to the id when the name has no index", () => {
    expect(detectGroupIndex(sig({ nameAttr: "school", idAttr: "education_1_school" }))).toBe(1);
  });
  it("returns null for a plain field", () => {
    expect(detectGroupIndex(sig({ nameAttr: "first_name", idAttr: "first_name" }))).toBeNull();
  });
  it("ignores spurious huge indices (>= 50)", () => {
    expect(detectGroupIndex(sig({ nameAttr: "token[999]" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/groupIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `groupIndex.ts`**

```ts
// chrome-extension/src/content/groupIndex.ts
/**
 * The 0-based repeating-row index encoded in a field's name/id, or null.
 * Recognizes the common ATS shapes: `education[1][school]`, `emp_2_title`,
 * `job.0.company`, `edu-3-degree`. Returns the FIRST index found (the outermost
 * repeating group), preferring `name` over `id`. Indices >= 50 are treated as
 * spurious (not a real repeating row) and yield null.
 */
import type { FieldSignals } from "./domUtils";

const MAX_INDEX = 50;

function firstIndex(s: string): number | null {
  if (!s) return null;
  // `[N]` first (most specific), then `.N.` / `_N_` / `-N-` delimited.
  const bracket = s.match(/\[(\d{1,3})\]/);
  const delimited = s.match(/[._-](\d{1,3})(?=[._-])/);
  const raw = bracket?.[1] ?? delimited?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n < MAX_INDEX ? n : null;
}

export function detectGroupIndex(signals: FieldSignals): number | null {
  return firstIndex(signals.nameAttr) ?? firstIndex(signals.idAttr);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/groupIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0.
```bash
git add chrome-extension/src/content/groupIndex.ts chrome-extension/test/groupIndex.test.ts
git commit -m "feat(repeating): detectGroupIndex — parse a repeating-row index from a field name/id" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: index-aware `resolveProfileValue`

**Files:**
- Modify: `chrome-extension/src/content/fieldMatcher.ts` (`resolveProfileValue` — widen `control`, education/employment cases)
- Test: `chrome-extension/test/fieldMatcher.test.ts` (extend)

**Interfaces:**
- Produces: `resolveProfileValue(category, profile, control: { controlType; options?; groupIndex?: number | null }, fillEEO): string | null` — index-aware for education/employment.

- [ ] **Step 1: Write the failing tests**

Append to `chrome-extension/test/fieldMatcher.test.ts` (reuse existing vitest imports; add `resolveProfileValue`/`UserApplicationProfile` imports only if not already present):

```ts
import { resolveProfileValue } from "../src/content/fieldMatcher";
import type { UserApplicationProfile } from "../src/shared/types";

function riProfile(): UserApplicationProfile {
  return {
    education: [
      { school: "MIT", degree: "BS", graduationYear: "2018" },
      { school: "Stanford", degree: "MS", graduationYear: "2020" },
    ],
    experience: [
      { company: "Acme", title: "Engineer", startDate: "2020", endDate: "2022", description: "" },
      { company: "Globex", title: "Senior Engineer", startDate: "2022", endDate: "", description: "" },
    ],
    currentCompany: "Globex",
    currentTitle: "Senior Engineer",
  } as unknown as UserApplicationProfile;
}

describe("resolveProfileValue — index-aware repeating sections", () => {
  const p = riProfile();
  const sel = { controlType: "text" as const };
  it("resolves an indexed education field to that education entry", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: 1 }, false)).toBe("Stanford");
    expect(resolveProfileValue("degree", p, { ...sel, groupIndex: 1 }, false)).toBe("MS");
    expect(resolveProfileValue("graduationYear", p, { ...sel, groupIndex: 0 }, false)).toBe("2018");
  });
  it("resolves education without an index to entry [0] (unchanged)", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: null }, false)).toBe("MIT");
    expect(resolveProfileValue("school", p, sel, false)).toBe("MIT");
  });
  it("resolves an indexed employment field to that experience entry", () => {
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: 0 }, false)).toBe("Acme");
    expect(resolveProfileValue("currentTitle", p, { ...sel, groupIndex: 0 }, false)).toBe("Engineer");
  });
  it("resolves employment without an index to the top-level current fields", () => {
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: null }, false)).toBe("Globex");
    expect(resolveProfileValue("currentTitle", p, sel, false)).toBe("Senior Engineer");
  });
  it("returns null for an out-of-range index (no throw)", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: 9 }, false)).toBeNull();
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: 9 }, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/fieldMatcher.test.ts -t "index-aware"`
Expected: FAIL — `groupIndex` not honored (indexed cases return entry [0] / current*).

- [ ] **Step 3: Implement — widen `control` + index-aware cases**

In `fieldMatcher.ts`, change the `resolveProfileValue` signature's `control` param:
```ts
  control: { controlType: ControlType; options?: string[]; groupIndex?: number | null },
```
Add at the top of the function body (after the `orNull` helper):
```ts
  const gi = control.groupIndex ?? null;
  const edu = profile.education[gi ?? 0];
```
Replace the education + employment cases:
```ts
    case "school":
      return orNull(edu?.school);
    case "degree":
      return orNull(edu?.degree);
    case "graduationYear":
      return orNull(edu?.graduationYear);
```
```ts
    case "currentCompany":
      return orNull(gi !== null ? profile.experience[gi]?.company : profile.currentCompany);
    case "currentTitle":
      return orNull(gi !== null ? profile.experience[gi]?.title : profile.currentTitle);
```
Leave every other case (including `education` → `formatEducation`, `experience` → `formatExperience`) unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/fieldMatcher.test.ts`
Expected: PASS (new index-aware + all existing fieldMatcher tests still green — the default `groupIndex` is `null`, so unchanged behavior).

- [ ] **Step 5: Typecheck + commit**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0. (Callers pass `control` without `groupIndex` today — it's optional, so they still type-check.)
```bash
git add chrome-extension/src/content/fieldMatcher.ts chrome-extension/test/fieldMatcher.test.ts
git commit -m "feat(repeating): index-aware resolveProfileValue for education/employment rows" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: thread `groupIndex` through the scanner + adapters

**Files:**
- Modify: `chrome-extension/src/content/adapters/types.ts` (`AnswerContext.control.groupIndex?`); `chrome-extension/src/content/adapters/apply.ts` (widen `resolveAnswerWithAdapter`'s `control` param type); `chrome-extension/src/content/formScanner.ts` (compute `detectGroupIndex` + pass in the 3 branches)
- Test: `chrome-extension/test/scanPageAdapter.test.ts` (extend — a two-row education fixture)

**Interfaces:**
- Consumes: `detectGroupIndex` (Task 1), index-aware `resolveProfileValue` (Task 2).

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/scanPageAdapter.test.ts` (reuse existing imports). IMPORTANT: plain `<input>`s are invisible in jsdom (zero client rects) so the scanner filters them — this file already uses a `stubLayout()` helper (from `./helpers/layout`) to make elements visible; ensure it's applied for this test (via the file's existing `beforeEach`, or call it at the start of the `it`) exactly as the other `scanPage` tests in this file do.

```ts
describe("scanPage — repeating education rows (index-aware)", () => {
  it("fills each education row from the matching profile entry", () => {
    // If stubLayout() isn't already applied in a shared beforeEach, call it here first.
    document.body.innerHTML = `
      <label for="s0">School</label><input id="s0" name="education[0][school]" />
      <label for="s1">School</label><input id="s1" name="education[1][school]" />`;
    const profile = {
      education: [
        { school: "MIT", degree: "BS", graduationYear: "2018" },
        { school: "Stanford", degree: "MS", graduationYear: "2020" },
      ],
    } as unknown as import("../src/shared/types").UserApplicationProfile;
    const { fields } = scanPage(profile, false, null);
    const byName = (n: string) => fields.find((f) => document.querySelector(`[name="${n}"]`)?.getAttribute("data-ap-field") === f.id);
    expect(byName("education[0][school]")?.proposedValue).toBe("MIT");
    expect(byName("education[1][school]")?.proposedValue).toBe("Stanford");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/scanPageAdapter.test.ts -t "repeating education"`
Expected: FAIL — both rows resolve to "MIT" (index not threaded yet).

- [ ] **Step 3: `types.ts` — add `groupIndex` to `AnswerContext.control`**

In `chrome-extension/src/content/adapters/types.ts`, change `AnswerContext`'s `control`:
```ts
  control: { controlType: ControlType; options?: string[]; groupIndex?: number | null };
```

- [ ] **Step 4: `apply.ts` — widen `resolveAnswerWithAdapter`'s `control` param**

In `chrome-extension/src/content/adapters/apply.ts`, change the `control` parameter type of `resolveAnswerWithAdapter`:
```ts
  control: { controlType: ControlType; options?: string[]; groupIndex?: number | null },
```
(The function already passes `control` through to both the adapter's `AnswerContext` and `resolveProfileValue` — no body change needed.)

- [ ] **Step 5: `formScanner.ts` — compute + thread `groupIndex`**

Add the import:
```ts
import { detectGroupIndex } from "./groupIndex";
```
In each of the THREE branches, immediately after `const signals = collectSignals(el);` (single-control) or `const signals = groupSignals(...);` (radio/checkbox groups), add:
```ts
    const groupIndex = detectGroupIndex(signals);
```
and add `groupIndex` to the `control` object passed to `resolveAnswerWithAdapter`. E.g. the single-control branch's resolve call becomes:
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType, options, groupIndex }, fillEEO, el);
```
and the radio-group / checkbox-group branches:
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType: "radioGroup", options, groupIndex }, fillEEO, first);
```
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType: "checkboxGroup", options, groupIndex }, fillEEO, first);
```

- [ ] **Step 6: Run the new test + regression**

Run: `cd chrome-extension && npx vitest run test/scanPageAdapter.test.ts test/formScanner.test.ts test/fieldMatcher.test.ts`
Expected: PASS (repeating-education fills each row; existing scanner/matcher tests unchanged — non-repeating fields yield `groupIndex === null`).

- [ ] **Step 7: Typecheck + build + full suite**

Run: `cd chrome-extension && npx tsc --noEmit && node build.mjs && npx vitest run`
Expected: tsc exit 0; build emits 3 bundles; all tests green.

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/content/adapters/types.ts chrome-extension/src/content/adapters/apply.ts chrome-extension/src/content/formScanner.ts chrome-extension/test/scanPageAdapter.test.ts
git commit -m "feat(repeating): thread groupIndex from scan through adapters into resolution" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: docs + final verification

**Files:**
- Modify: `docs/autofill-rebuild/jobright-reference-analysis.md`

- [ ] **Step 1: Full verification**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run && node build.mjs`
Expected: tsc exit 0; all tests green; 3 bundles emit.

- [ ] **Step 2: Record Phase 4 status**

In `docs/autofill-rebuild/jobright-reference-analysis.md` §15, add after the Phase 4 line:
```markdown
> **Phase 4 status (2026-07-02):** Implemented on branch `feature/autofill-repeating-groups` — index-aware resolution for repeating education/employment sections: `detectGroupIndex` parses a field's row index (`education[1][school]` → 1) and `resolveProfileValue` resolves it against `profile.education[N]` / `profile.experience[N]`, threaded through the scanner→adapter→resolver path. Fills all *present* rows; auto-adding rows (DOM mutation) deferred with rationale. See the spec and plan dated 2026-07-02.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autofill-rebuild/jobright-reference-analysis.md
git commit -m "docs(autofill): mark Phase 4 repeating-section resolution complete" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review notes
- **Spec coverage:** detectGroupIndex (Task 1 → §4.1), index-aware resolveProfileValue (Task 2 → §4.2), threading via types/apply/formScanner (Task 3 → §4.3), docs (Task 4). Acceptance 1-5 → Tasks 2/3 + verification.
- **No regression:** `groupIndex` defaults to `null`/absent everywhere → education `[0]` + top-level `current*`, identical to today; existing fieldMatcher/formScanner tests must stay green (Task 2 Step 4, Task 3 Step 6).
- **Type consistency:** `detectGroupIndex(signals): number|null`; `control.groupIndex?: number|null` added consistently to `resolveProfileValue`, `AnswerContext.control`, and `resolveAnswerWithAdapter`'s param; `formScanner` passes it in all 3 branches.
- **Out-of-range safety:** `profile.education[gi]?` / `profile.experience[gi]?` optional-chain to `undefined` → `orNull` → `null`; never throws.
