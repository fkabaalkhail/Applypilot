# Workday Widgets, Faithful Gap Modal, and the Advance Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four defects reported from a live Workday application — date spinbuttons and the Field of Study dropdown never fill, the "Questions we couldn't answer" modal renders the wrong control so its answers don't land, the advance gate is off-brand green and never appears on the account-creation page, and the résumé drop zone never auto-attaches.

**Architecture:** Every Workday `data-automation-id` lives in `adapters/workdaySelectors.ts` (data only, no logic); `adapters/workday.ts` holds the logic that reads them. The panel (`overlay.ts`) is pure rendering over serializable `DetectedField`s and reaches live DOM only through `OverlayCallbacks`, which `crossFrame.ts` marshals to the form-owning frame. `flowController.ts` is pure orchestration over injected deps and unit-tests with scripted fakes. Follow those boundaries — do not reach for `document` from `overlay.ts`, and do not put a selector string in `workday.ts`.

**Tech Stack:** TypeScript, esbuild (`node build.mjs`), vitest + jsdom for unit tests, Playwright + a local `http` server for browser probes.

## Global Constraints

- **Scope is `chrome-extension/` only.** No backend change, no Neon migration, no `frontend/` change. `fieldOfStudy` is *derived*, never stored.
- **Run tests with `npx vitest run <file>`.** `npm test` exits 1 with no output in this shell — that is a known harness quirk, not a failure.
- Every new Workday selector string goes in `src/content/adapters/workdaySelectors.ts`. That file imports types only — it must never import `./registry`.
- Sensitive/EEO behaviour is untouched. Do not change what is transmitted.
- The controller's invariant holds: **never click a terminal (submit) button.** Task 8 narrows what counts as terminal on an account wall; it does not weaken the invariant on form pages.
- Commit after each task, staging **only the files that task names** — other sessions share this checkout and have unrelated modified files in the working tree.
- Spec: `docs/superpowers/specs/2026-08-08-workday-widgets-and-gate-design.md`.

---

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/content/adapters/workdaySelectors.ts` | all Workday selectors + pure readers (data) | 2, 3, 4 |
| `src/content/adapters/workday.ts` | Workday classify / resolve / fill logic | 2, 3, 4 |
| `src/content/formScanner.ts` | `currentValueOf` placeholder normalisation | 1 |
| `src/content/fieldMatcher.ts` | `fieldOfStudy` rule + derivation from degree | 3 |
| `src/content/comboboxEngine.ts` | Workday searchBox typeahead + multiselect probes | 3 |
| `src/content/fileUpload.ts` | attribute-based drop-zone / file-input discovery | 4 |
| `src/content/overlay.ts` | gap-modal controls, gate colour, `showsAdvanceGate` | 5, 6, 7, 9 |
| `src/content/contentScript.ts` | `onHarvestGapOptions` implementation over the registry | 6 |
| `src/content/crossFrame.ts` + `src/shared/types.ts` | marshal the new op to the form frame | 6 |
| `src/content/advance.ts` | wall advance beats a terminal match | 8 |
| `src/content/flowController.ts` | manual override of a clearable pause | 9 |

---

## Task 1: Workday's empty date parts stop reading as filled

Workday renders an *empty* date part as `value="0"`. `aiFillPlanner.ts:51` and `answerGaps.ts:117` both skip any field with a non-empty `currentValue`, so the part is invisible to the AI pass **and** to the gaps modal.

**Files:**
- Modify: `src/content/formScanner.ts` (`currentValueOf`, around line 668)
- Test: `test/workdayDateParts.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a scanned Workday date-part input now reports `currentValue === undefined`. Tasks 2 and 3 rely on this — without it their fills are never attempted.

- [ ] **Step 1: Write the failing test**

Create `test/workdayDateParts.test.ts`:

```ts
/**
 * Workday renders a date as sibling spinbuttons whose EMPTY value is "0", not
 * "". Both fill paths skip a field with a non-empty currentValue, so an empty
 * Workday date was invisible to the AI pass and to the gaps modal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

/** One Workday date widget (month/day/year spinbuttons), as reported live. */
function mountWorkdayDate(prefix = "workExperience-10--startDate"): void {
  document.body.innerHTML = `
    <div data-automation-id="formField-startDate">
      <div data-automation-id="dateWidget">
        <label for="${prefix}-dateSectionMonth-input">Month</label>
        <input role="spinbutton" aria-label="Month" aria-valuemin="1" aria-valuemax="12"
               aria-valuetext="0" aria-valuenow="0" value="0"
               id="${prefix}-dateSectionMonth-input" data-automation-id="dateSectionMonth-input">
        <label for="${prefix}-dateSectionDay-input">Day</label>
        <input role="spinbutton" aria-label="Day" aria-valuemin="1" aria-valuemax="31"
               aria-valuetext="0" aria-valuenow="0" value="0"
               id="${prefix}-dateSectionDay-input" data-automation-id="dateSectionDay-input">
        <label for="${prefix}-dateSectionYear-input">Year</label>
        <input role="spinbutton" aria-label="Year" aria-valuemin="1" aria-valuemax="9999"
               aria-valuetext="0" aria-valuenow="0" value="0" aria-invalid="true"
               id="${prefix}-dateSectionYear-input" data-automation-id="dateSectionYear-input">
      </div>
    </div>`;
}

describe("Workday date spinbuttons", () => {
  it("reads an empty (value=0) spinbutton as empty, not as already filled", () => {
    mountWorkdayDate();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const year = fields.find((f) => f.label.toLowerCase().includes("year"));
    expect(year, "expected the Year spinbutton to be scanned").toBeDefined();
    expect(year!.currentValue).toBeUndefined();
  });

  it("still reports a real spinbutton value", () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    year.value = "2025";
    year.setAttribute("aria-valuetext", "2025");
    year.setAttribute("aria-valuenow", "2025");
    const { fields } = scanPage(MOCK_PROFILE, false);
    const scanned = fields.find((f) => f.label.toLowerCase().includes("year"));
    expect(scanned!.currentValue).toBe("2025");
  });

  it("leaves an ordinary number input alone — 0 is a legitimate answer there", () => {
    document.body.innerHTML = `<label>Years of experience <input type="number" value="0"></label>`;
    const { fields } = scanPage(MOCK_PROFILE, false);
    const n = fields.find((f) => f.label.toLowerCase().includes("years"));
    expect(n!.currentValue).toBe("0");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/workdayDateParts.test.ts`
Expected: FAIL — the first test reports `currentValue` is `"0"`, not `undefined`.

- [ ] **Step 3: Implement the placeholder rule**

In `src/content/formScanner.ts`, add this helper immediately **above** `currentValueOf`:

```ts
/**
 * Workday's segmented date widget renders each EMPTY part as a spinbutton
 * reading "0" — and its own `aria-valuemin="1"` says 0 is out of range. Read
 * that as empty, or the part looks already-filled and both fill paths skip it
 * (aiFillPlanner's `!f.currentValue`, answerGaps' currentValue guard).
 *
 * Gated on role=spinbutton + a minimum above zero so an ordinary
 * <input type=number> where 0 IS the answer ("years of experience: 0") is
 * untouched.
 */
function isEmptySpinbutton(el: HTMLElement, raw: string): boolean {
  if (el.getAttribute("role") !== "spinbutton") return false;
  if (raw.trim() !== "0") return false;
  const min = Number(el.getAttribute("aria-valuemin"));
  return Number.isFinite(min) && min > 0;
}
```

Then in `currentValueOf`, replace the `text`/`textarea` branch:

```ts
  if (controlType === "text" || controlType === "textarea") {
    const v = (el as HTMLInputElement | HTMLTextAreaElement).value;
    if (!v) return undefined;
    return isEmptySpinbutton(el, v) ? undefined : v;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/workdayDateParts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Guard the rest of the suite**

Run: `npx vitest run`
Expected: no NEW failures. Pre-existing failures are recorded in the baseline memory (`pre-existing-test-failures-baseline`) — compare before blaming this change.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/test/workdayDateParts.test.ts
git commit -m "fix(extension): Workday's empty date spinbuttons no longer read as filled"
```

---

## Task 2: The split-date fill path actually fires

`adapters/workday.ts:86` calls `ctx.el.closest("[data-automation-id]")`, which **matches the element itself** — the year input's own automation-id (`dateSectionYear-input`) satisfies `/date/i`, so the month/day/year lookups search the input's own empty subtree and the operation always bails. Separately, `parseDate` only accepts `YYYY-MM-DD` / `M/D/YYYY`, but the profile stores work-experience dates as `"2025-05"`.

**Files:**
- Modify: `src/content/adapters/workdaySelectors.ts` (add `dateContainerOf`, `DATE_PART_SELECTOR`)
- Modify: `src/content/adapters/workday.ts` (`parseDate`, `fillOperation`)
- Test: `test/workdayDateParts.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: Task 1's `currentValue === undefined` (otherwise nothing proposes a value to fill).
- Produces:
  ```ts
  // workdaySelectors.ts
  export const DATE_PART_SELECTOR: string;                       // matches any month/day/year part input
  export function dateContainerOf(el: HTMLElement): HTMLElement | null;
  ```
  Task 3 does not use these; Task 4 does not use these.

- [ ] **Step 1: Write the failing test**

Append to `test/workdayDateParts.test.ts`:

```ts
import { workdayAdapter } from "../src/content/adapters/workday";
import { dateContainerOf } from "../src/content/adapters/workdaySelectors";

describe("Workday split-date container", () => {
  it("never treats a date PART as its own container", () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input")!;
    const container = dateContainerOf(year);
    expect(container).not.toBe(year);
    expect(container!.getAttribute("data-automation-id")).toBe("dateWidget");
  });

  /** FillContext is `{ control, value, el }` — see adapters/types.ts. */
  const fillCtx = (el: HTMLInputElement, value: string) => ({
    control: { id: "f1", controlType: "text" as const, el },
    value,
    el,
  });

  it("writes month, day and year from one ISO value", async () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    const op = workdayAdapter.fillOperation!(fillCtx(year, "2025-05-14"));
    expect(op, "expected the adapter to claim this field").toBeDefined();
    await op;
    expect((document.getElementById("workExperience-10--startDate-dateSectionMonth-input") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("workExperience-10--startDate-dateSectionDay-input") as HTMLInputElement).value).toBe("14");
    expect(year.value).toBe("2025");
  });

  it("accepts a year-month profile value (the shape the profile stores)", async () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    await workdayAdapter.fillOperation!(fillCtx(year, "2025-05"));
    expect((document.getElementById("workExperience-10--startDate-dateSectionMonth-input") as HTMLInputElement).value).toBe("5");
    expect(year.value).toBe("2025");
  });

  it("accepts a bare year (graduation year)", async () => {
    mountWorkdayDate("education-11--endDate");
    const year = document.getElementById("education-11--endDate-dateSectionYear-input") as HTMLInputElement;
    await workdayAdapter.fillOperation!(fillCtx(year, "2026"));
    expect(year.value).toBe("2026");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/workdayDateParts.test.ts`
Expected: FAIL — `dateContainerOf` is not exported.

- [ ] **Step 3: Add the container reader to workdaySelectors.ts**

Replace the existing `DATE_CONTAINER_RE` / `DATE_PART_FRAGMENTS` block with:

```ts
/** Ancestor automation-id marking the segmented month/day/year date widget. */
export const DATE_CONTAINER_RE = /date/i;
/** Automation-id fragments of the three spinbutton inputs inside that widget. */
export const DATE_PART_FRAGMENTS = { month: "month", day: "day", year: "year" } as const;

/** Any one of the widget's part inputs. */
export const DATE_PART_SELECTOR =
  'input[data-automation-id*="dateSection" i], input[role="spinbutton"]';

/**
 * The date WIDGET wrapping a part input — never the part itself.
 *
 * `Element.closest()` matches the element it is called on, and a part's own
 * automation-id ("dateSectionYear-input") satisfies DATE_CONTAINER_RE, so
 * `el.closest("[data-automation-id]")` returned the INPUT and every
 * `container.querySelector("input[...]")` searched an empty subtree. Climb from
 * the parent instead, and require the candidate to actually hold a part input.
 */
export function dateContainerOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const id = node.getAttribute("data-automation-id");
    if (id && DATE_CONTAINER_RE.test(id) && node.querySelector(DATE_PART_SELECTOR)) return node;
  }
  return null;
}
```

- [ ] **Step 4: Rewrite `parseDate` and `fillOperation` in workday.ts**

Replace `parseDate`:

```ts
/** Parse the date shapes the profile and the page actually use: ISO
 *  (2025-05-14), year-month (2025-05 — how experience start/end dates are
 *  stored), US (5/14/2025), and a bare year (2026 — graduation). Missing parts
 *  come back as "" and are simply not written. */
function parseDate(v: string): { month: string; day: string; year: string } | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    return { year: iso[1], month: String(Number(iso[2])), day: iso[3] ? String(Number(iso[3])) : "" };
  }
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { month: String(Number(us[1])), day: String(Number(us[2])), year: us[3] };
  const bare = v.match(/^(\d{4})$/);
  if (bare) return { year: bare[1], month: "", day: "" };
  return null;
}
```

Replace `fillOperation`:

```ts
  fillOperation(ctx: FillContext): Promise<AdapterFillResult> | undefined {
    const container = dateContainerOf(ctx.el);
    if (!container) return undefined;
    const q = (frag: string) =>
      container.querySelector<HTMLInputElement>(`input[data-automation-id*="${frag}" i]`);
    const month = q(DATE_PART_FRAGMENTS.month);
    const day = q(DATE_PART_FRAGMENTS.day);
    const year = q(DATE_PART_FRAGMENTS.year);
    const parts = parseDate(ctx.value);
    if (!parts || (!month && !day && !year)) return undefined;
    return (async () => {
      // A part the value doesn't carry (no day in "2025-05") is left alone
      // rather than zeroed — Workday reads 0 as empty and flags it invalid.
      if (month && parts.month) setInput(month, parts.month);
      if (day && parts.day) setInput(day, parts.day);
      if (year && parts.year) setInput(year, parts.year);
      return { filled: true };
    })();
  },
```

Update the import block at the top of `workday.ts` — drop `DATE_CONTAINER_RE`, add `dateContainerOf`:

```ts
import {
  ADVANCE_BUTTON_SELECTOR,
  COVER_LETTER_SECTION_RE,
  DATE_PART_FRAGMENTS,
  ENTRY_BUTTON_SELECTOR,
  FIELD_RULES,
  RESUME_SECTION_RE,
  WD_HOST,
  automationId,
  automationIdChain,
  dateContainerOf,
} from "./workdaySelectors";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/workdayDateParts.test.ts test/workdayAdapter.test.ts test/workdayExperience.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add chrome-extension/src/content/adapters/workday.ts chrome-extension/src/content/adapters/workdaySelectors.ts chrome-extension/test/workdayDateParts.test.ts
git commit -m "fix(extension): Workday split-date fill fires (closest() matched the part itself)"
```

---

## Task 3: Date parts and Field of Study get the right category

Date parts carry no category rule, so they fall through to the generic matcher on "Year"/"Month". Field of Study is folded into the **degree** rule (`fieldMatcher.ts:304`), so Workday's separate Field-of-Study dropdown is fed "BSc Computer Science" and matches nothing.

**Files:**
- Modify: `src/shared/types.ts` (add `fieldOfStudy` to `FieldCategory`)
- Modify: `src/shared/constants.ts` (label for the new category)
- Modify: `src/content/fieldMatcher.ts` (split the rule, add the derivation)
- Modify: `src/content/adapters/workdaySelectors.ts` (`SECTION_DATE_RULES`, searchBox/multiselect constants)
- Modify: `src/content/adapters/workday.ts` (`classify` consults `SECTION_DATE_RULES` first)
- Modify: `src/content/comboboxEngine.ts` (`isTypeahead`, `isMultiSelect`)
- Test: `test/workdayFieldOfStudy.test.ts` (create), `test/workdayDateParts.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `dateContainerOf` is already in place (not called here).
- Produces:
  ```ts
  // shared/types.ts — FieldCategory gains: | "fieldOfStudy"
  // fieldMatcher.ts
  export function deriveFieldOfStudy(degree: string): string | null;
  // workdaySelectors.ts
  export const SECTION_DATE_RULES: ReadonlyArray<readonly [RegExp, FieldCategory]>;
  export const SEARCH_BOX_FRAGMENT: string;      // "searchBox"
  export const MULTISELECT_ID_ATTR: string;      // "data-uxi-multiselect-id"
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/workdayFieldOfStudy.test.ts`:

```ts
/**
 * Workday shows Degree and Field of Study as two separate typeahead dropdowns.
 * The matcher folded "field of study" into the degree rule, so both received
 * the degree value and Field of Study matched no option.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { deriveFieldOfStudy } from "../src/content/fieldMatcher";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

/** Workday's education row: Degree and Field of Study, both selectinput. */
function mountEducationRow(): void {
  document.body.innerHTML = `
    <div data-automation-id="educationSection">
      <label for="education-11--degree">Degree</label>
      <input id="education-11--degree" data-automation-id="searchBox" placeholder="Search"
             data-uxi-widget-type="selectinput" data-uxi-multiselect-id="aaa" autocomplete="off">
      <label for="education-11--fieldOfStudy">Field of Study</label>
      <input id="education-11--fieldOfStudy" data-automation-id="searchBox" placeholder="Search"
             data-uxi-widget-type="selectinput" data-uxi-multiselect-id="bbb" autocomplete="off">
    </div>`;
}

describe("deriveFieldOfStudy", () => {
  it("takes the subject out of a degree string", () => {
    expect(deriveFieldOfStudy("BSc Computer Science")).toBe("Computer Science");
    expect(deriveFieldOfStudy("Bachelor of Science in Computer Science")).toBe("Computer Science");
    expect(deriveFieldOfStudy("Master's Degree in Mechanical Engineering")).toBe("Mechanical Engineering");
    expect(deriveFieldOfStudy("B.S. Electrical Engineering")).toBe("Electrical Engineering");
  });

  it("returns null when the degree names no subject", () => {
    expect(deriveFieldOfStudy("Bachelor's Degree")).toBeNull();
    expect(deriveFieldOfStudy("PhD")).toBeNull();
    expect(deriveFieldOfStudy("")).toBeNull();
  });
});

describe("Workday education row", () => {
  it("classifies Field of Study separately from Degree", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const fos = fields.find((f) => f.label.toLowerCase().includes("field of study"));
    const deg = fields.find((f) => f.label.toLowerCase() === "degree");
    expect(fos!.category).toBe("fieldOfStudy");
    expect(deg!.category).toBe("degree");
  });

  it("proposes the subject, not the degree, for Field of Study", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const fos = fields.find((f) => f.category === "fieldOfStudy");
    // MOCK_PROFILE education[0].degree is "BSc Computer Science".
    expect(fos!.proposedValue).toBe("Computer Science");
  });

  it("drives the searchBox through the listbox engine, not as a text input", () => {
    mountEducationRow();
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "fieldOfStudy")!.controlType).toBe("combobox");
  });
});
```

Append to `test/workdayDateParts.test.ts`:

```ts
describe("Workday date-part categories", () => {
  it("reads the section from the element id", () => {
    mountWorkdayDate("workExperience-10--startDate");
    const { fields } = scanPage(MOCK_PROFILE, false);
    for (const part of ["month", "day", "year"]) {
      const f = fields.find((x) => x.label.toLowerCase().includes(part));
      expect(f!.category, part).toBe("experienceStartDate");
    }
  });

  it("maps an education end date to the graduation year", () => {
    mountWorkdayDate("education-11--endDate");
    const { fields } = scanPage(MOCK_PROFILE, false);
    const year = fields.find((f) => f.label.toLowerCase().includes("year"));
    expect(year!.category).toBe("graduationYear");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/workdayFieldOfStudy.test.ts test/workdayDateParts.test.ts`
Expected: FAIL — `deriveFieldOfStudy` is not exported; categories are `degree` / not `experienceStartDate`.

- [ ] **Step 3: Add the category to the shared types**

In `src/shared/types.ts`, in the `FieldCategory` union, add `fieldOfStudy` directly after `"degree"`:

```ts
  | "degree"
  | "fieldOfStudy"
  | "graduationYear"
```

In `src/shared/constants.ts`, beside the existing `degree: "Degree",` entry:

```ts
  fieldOfStudy: "Field of Study",
```

- [ ] **Step 4: Split the matcher rule and add the derivation**

In `src/content/fieldMatcher.ts`, replace the `degree` rule and add a `fieldOfStudy` rule after it:

```ts
  {
    category: "degree",
    patterns: [
      { re: /\bdegree\b/ },
      { re: /\b(highest )?(level of )?education( level)?\b/, weight: 0.75 },
      { re: /\bqualification\b/, weight: 0.7 },
    ],
    // Workday shows Degree and Field of Study side by side; a "field of study"
    // label must never resolve here or the subject dropdown gets "BSc …".
    negative: /\bfield of study\b|\bmajor\b|\bdiscipline\b|\bconcentration\b/,
  },
  {
    category: "fieldOfStudy",
    patterns: [
      { re: /\bfield of study\b|\bmajor\b/ },
      { re: /\bdiscipline\b|\bconcentration\b|\bcourse of study\b/, weight: 0.85 },
    ],
  },
```

Add the derivation as an exported function (place it beside `formatEducation`):

```ts
/** Qualification words that PREFIX a degree string, with an optional joining
 *  "in"/"of". Ordered longest-first so "Bachelor of Science" is consumed whole
 *  before the bare "Bachelor" alternative can match. */
const DEGREE_PREFIX_RE =
  /^\s*(bachelor(?:'?s)?(?:\s+of\s+(?:science|arts|engineering|commerce|business))?|master(?:'?s)?(?:\s+of\s+(?:science|arts|engineering|business administration))?|doctor(?:ate)?(?:\s+of\s+philosophy)?|ph\.?\s?d\.?|b\.?\s?(?:sc?|a|eng|comm)\.?|m\.?\s?(?:sc?|a|eng|ba)\.?|associate(?:'?s)?|diploma|certificate)\b[\s,]*(?:degree\b[\s,]*)?(?:in|of)?\b[\s,]*/i;

/**
 * The subject of a degree string — Workday's "Field of Study" dropdown, which
 * is a SEPARATE control from "Degree" and rejects the degree's own text.
 *
 * "BSc Computer Science" / "Bachelor of Science in Computer Science" →
 * "Computer Science". A degree naming no subject ("Bachelor's Degree", "PhD")
 * returns null, which routes the field to the grounded AI pass rather than
 * writing something invented.
 */
export function deriveFieldOfStudy(degree: string): string | null {
  const rest = (degree || "").replace(DEGREE_PREFIX_RE, "").trim();
  return rest && rest.toLowerCase() !== (degree || "").trim().toLowerCase() ? rest : null;
}
```

In `resolveProfileValue`, add the case immediately after `case "degree":`:

```ts
    case "fieldOfStudy":
      return edu?.degree ? deriveFieldOfStudy(edu.degree) : null;
```

- [ ] **Step 5: Add the Workday section-date rules**

In `src/content/adapters/workdaySelectors.ts`, add after `FIELD_RULES`:

```ts
/**
 * Workday namespaces a repeating row in the element **id**
 * ("workExperience-10--startDate-dateSectionYear-input"), not in the
 * automation-id — which is section-agnostic ("dateSectionYear-input"). Matched
 * against the id and consulted BEFORE FIELD_RULES, since the id is the more
 * specific signal. All three parts of one widget resolve to the same category;
 * the adapter's fillOperation then writes every part from that one value.
 */
export const SECTION_DATE_RULES: ReadonlyArray<readonly [RegExp, FieldCategory]> = [
  [/workexperience.*startdate/i, "experienceStartDate"],
  [/workexperience.*enddate/i, "experienceEndDate"],
  [/education.*(graduation|enddate|completiondate)/i, "graduationYear"],
];

/** Workday's typeahead search input inside a prompt/multiselect widget. */
export const SEARCH_BOX_FRAGMENT = "searchBox";
/** Attribute Workday puts on the multiselect's own input (not an ancestor). */
export const MULTISELECT_ID_ATTR = "data-uxi-multiselect-id";
```

- [ ] **Step 6: Consult the rules in the adapter**

In `src/content/adapters/workday.ts`, add `SECTION_DATE_RULES` to the import block, then insert at the top of `classify`, **before** the résumé/cover-letter chain check:

```ts
  classify(ctx) {
    // Date parts first: their automation-id is section-agnostic
    // ("dateSectionYear-input"), so only the element id says which date this is.
    const elId = ctx.el.id || "";
    if (elId) {
      for (const [re, category] of SECTION_DATE_RULES) {
        if (re.test(elId)) return { category, confidence: 0.95, sensitive: false };
      }
    }
```

- [ ] **Step 7: Teach the combobox engine about the searchBox widget**

In `src/content/comboboxEngine.ts`, add to the import from `./adapters/workdaySelectors`:

```ts
  MULTISELECT_ID_ATTR as WD_MULTISELECT_ID_ATTR,
  SEARCH_BOX_FRAGMENT as WD_SEARCH_BOX_FRAGMENT,
```

In `isMultiSelect`, before the `trigger.closest(...)` return, add:

```ts
  // Workday puts the multiselect marker on the INPUT itself, not an ancestor
  // (data-uxi-multiselect-id on education-N--fieldOfStudy).
  if (trigger.hasAttribute(WD_MULTISELECT_ID_ATTR)) return true;
```

Replace `isTypeahead`:

```ts
function isTypeahead(trigger: HTMLElement): boolean {
  if (!(trigger instanceof HTMLInputElement)) return false;
  // Workday's searchBox has NO aria-autocomplete and an empty listbox until
  // text is typed — opening it and reading options finds nothing.
  const testId = trigger.getAttribute("data-automation-id") ?? "";
  if (testId.toLowerCase().includes(WD_SEARCH_BOX_FRAGMENT.toLowerCase())) return true;
  const ac = (trigger.getAttribute("aria-autocomplete") || "").toLowerCase();
  return ac === "list" || ac === "both" || ac === "inline" || trigger.type === "text";
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/workdayFieldOfStudy.test.ts test/workdayDateParts.test.ts test/workdayRealDropdowns.test.ts test/fieldMatcher.test.ts`
Expected: PASS. If an existing matcher test asserted "major" → `degree`, update it to `fieldOfStudy` — that is the intended behaviour change.

- [ ] **Step 9: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/shared/types.ts chrome-extension/src/shared/constants.ts \
        chrome-extension/src/content/fieldMatcher.ts chrome-extension/src/content/comboboxEngine.ts \
        chrome-extension/src/content/adapters/workday.ts chrome-extension/src/content/adapters/workdaySelectors.ts \
        chrome-extension/test/workdayFieldOfStudy.test.ts chrome-extension/test/workdayDateParts.test.ts
git commit -m "fix(extension): Field of Study is its own category; Workday date parts carry their section"
```

---

## Task 4: The Workday résumé drop zone auto-attaches

`resumeUpload` classification needs the literal token *resume* / *cv* in the field's signals. On the reported drop zone the only "resume" token is `id="resumeAttachments--attachments"` — an element **id** on the button, read by neither `automationIdChain` (reads `data-automation-id`) nor `uploadZoneText` (reads text). The field classifies `unknown`, so `resumeFieldNeedingFile` never returns it and the flow's existing auto-attach never targets it.

**Files:**
- Modify: `src/content/adapters/workdaySelectors.ts` (upload selectors + widget-id regexes)
- Modify: `src/content/adapters/workday.ts` (`classify` upload branch)
- Modify: `src/content/fileUpload.ts` (`findFileInput`, `injectResumeFile`)
- Test: `test/workdayResume.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // workdaySelectors.ts
  export const FILE_DROP_ZONE_SELECTOR: string;
  export const FILE_INPUT_SELECTOR: string;
  export const SELECT_FILES_SELECTOR: string;
  export const UPLOAD_WIDGET_ID_RE: RegExp;
  export const COVER_WIDGET_ID_RE: RegExp;
  export function uploadWidgetIds(el: HTMLElement): string;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/workdayResume.test.ts`:

```ts
import { findFileInput } from "../src/content/fileUpload";

/**
 * The drop zone as reported from a live Workday application: hashed CSS
 * classes, NO "Upload your resume" heading, and the only "resume" token is an
 * element id on the Select-files button.
 */
function mountBareDropzone(): void {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowPage">
      <div class="css-wtpnzt">
        <div data-automation-id="file-upload-drop-zone" class="css-1ikudie">
          <div class="css-1ge88gr">Drop files here</div>
          <div class="css-xszj4y">
            <div class="css-1j5bq6h">or</div>
            <button type="button" data-automation-id="select-files"
                    id="resumeAttachments--attachments" class="css-ne6lk6">Select files</button>
          </div>
        </div>
        <input data-automation-id="file-upload-input-ref" type="file" multiple class="css-1hyfx7x">
      </div>
    </div>`;
}

describe("Workday drop zone with no document heading", () => {
  it("classifies as a résumé upload from the widget's element id", () => {
    mountBareDropzone();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume, "expected a resumeUpload field").toBeDefined();
    expect(resume!.controlType).toBe("file");
  });

  it("finds the real file input from the drop zone (hashed classes match nothing)", () => {
    mountBareDropzone();
    const zone = document.querySelector('[data-automation-id="file-upload-drop-zone"]') as HTMLElement;
    const input = findFileInput(zone);
    expect(input).not.toBeNull();
    expect(input!.getAttribute("data-automation-id")).toBe("file-upload-input-ref");
  });

  it("routes a cover-letter widget to coverLetter, not résumé", () => {
    document.body.innerHTML = `
      <div data-automation-id="file-upload-drop-zone">
        <button data-automation-id="select-files" id="coverLetter--attachments">Select files</button>
        <input data-automation-id="file-upload-input-ref" type="file">
      </div>`;
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.some((f) => f.category === "coverLetter")).toBe(true);
    expect(fields.some((f) => f.category === "resumeUpload")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/workdayResume.test.ts`
Expected: FAIL — no `resumeUpload` field (the widget classifies as `unknown`).

- [ ] **Step 3: Add the upload selectors to workdaySelectors.ts**

Append to the "Custom widgets" section:

```ts
// ---------------------------------------------------------------------------
// File upload (drop zone)
// ---------------------------------------------------------------------------

/** Workday's drag-and-drop upload zone. */
export const FILE_DROP_ZONE_SELECTOR = '[data-automation-id="file-upload-drop-zone"]';
/** The real (visually hidden) <input type=file> beside that zone. */
export const FILE_INPUT_SELECTOR = '[data-automation-id="file-upload-input-ref"]';
/** The zone's "Select files" button — where the document name lives, as an id. */
export const SELECT_FILES_SELECTOR = '[data-automation-id="select-files"]';

/**
 * Workday's upload widget carries no automation-id and no visible text naming
 * the document — its CSS classes are hashed per tenant ("css-1ikudie") and the
 * zone reads only "Drop files here / or / Select files". The one place the
 * document IS named is the element **id** on the Select-files button
 * ("resumeAttachments--attachments"), which neither the automation-id chain nor
 * the zone text ever sees. These match against that.
 */
export const UPLOAD_WIDGET_ID_RE = /resume|curriculum.?vitae|\bcv\b/i;
export const COVER_WIDGET_ID_RE = /cover.?letter/i;

/** Element ids inside (and on) the upload widget wrapping `el`, space-joined. */
export function uploadWidgetIds(el: HTMLElement): string {
  const zone = el.closest<HTMLElement>(FILE_DROP_ZONE_SELECTOR)?.parentElement
    ?? el.closest<HTMLElement>(FILE_DROP_ZONE_SELECTOR)
    ?? el.parentElement;
  if (!zone) return el.id ?? "";
  const ids = [zone.id, el.id];
  for (const node of zone.querySelectorAll<HTMLElement>("[id]")) ids.push(node.id);
  return ids.filter(Boolean).join(" ");
}
```

- [ ] **Step 4: Add the upload branch to the adapter's classify**

In `src/content/adapters/workday.ts`, add to the import block:

```ts
  COVER_WIDGET_ID_RE,
  FILE_DROP_ZONE_SELECTOR,
  UPLOAD_WIDGET_ID_RE,
  uploadWidgetIds,
```

In `classify`, replace the résumé/cover-letter block with:

```ts
    // Resume / cover-letter uploads: Workday tags the SECTION, not the input, so
    // scan the ancestor automation-id chain. Best-effort across Workday layouts
    // (resumeSection / quickApplyResume / fileUpload… under a resume section).
    const chain = automationIdChain(ctx.el);
    if (RESUME_SECTION_RE.test(chain)) {
      return { category: "resumeUpload", confidence: 0.9, sensitive: false };
    }
    if (COVER_LETTER_SECTION_RE.test(chain)) {
      return { category: "coverLetter", confidence: 0.9, sensitive: false };
    }
    // A drop zone whose classes are hashed and whose text is only "Drop files
    // here": the document is named in an element id on its Select-files button
    // ("resumeAttachments--attachments"). Without this the field classifies as
    // unknown, so the flow's auto-attach never targets it.
    const isUpload =
      (ctx.el instanceof HTMLInputElement && ctx.el.type === "file") ||
      ctx.el.closest(FILE_DROP_ZONE_SELECTOR) !== null;
    if (isUpload) {
      const ids = uploadWidgetIds(ctx.el);
      if (COVER_WIDGET_ID_RE.test(ids)) return { category: "coverLetter", confidence: 0.9, sensitive: false };
      // A Workday drop zone with no document signal at all is the résumé: it is
      // the only upload that appears before the cover-letter section, and
      // leaving it `unknown` is exactly today's failure.
      if (UPLOAD_WIDGET_ID_RE.test(ids) || ctx.el.closest(FILE_DROP_ZONE_SELECTOR)) {
        return { category: "resumeUpload", confidence: 0.9, sensitive: false };
      }
    }
```

- [ ] **Step 5: Give fileUpload attribute-based selectors**

In `src/content/fileUpload.ts`, add the import:

```ts
import { FILE_DROP_ZONE_SELECTOR, FILE_INPUT_SELECTOR } from "./adapters/workdaySelectors";
```

Replace the `closest` call in `findFileInput`:

```ts
  let node: HTMLElement | null =
    el.closest<HTMLElement>(
      `form, ${FILE_DROP_ZONE_SELECTOR}, [class*='dropzone' i], [class*='upload' i], [class*='attach' i], [class*='field' i]`
    ) ?? el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    // Workday's input is a SIBLING of the zone, so prefer the attribute match
    // before the generic one — its classes are hashed and match nothing.
    const wd = node.querySelector<HTMLInputElement>(`input${FILE_INPUT_SELECTOR}:not([disabled])`);
    if (wd) return wd;
    const input = node.querySelector<HTMLInputElement>('input[type="file"]:not([disabled])');
    if (input) return input;
    if (node.tagName === "FORM") break;
  }
```

In `injectResumeFile`, replace the dropzone lookup:

```ts
  const dropzone = target.closest(
    `${FILE_DROP_ZONE_SELECTOR},[class*='dropzone' i],[class*='drop' i]`
  ) as HTMLElement | null;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/workdayResume.test.ts test/workdayAdapter.test.ts`
Expected: PASS — including the two pre-existing tests in `workdayResume.test.ts`, which cover the heading-bearing variant of the same widget.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/content/adapters/workday.ts chrome-extension/src/content/adapters/workdaySelectors.ts \
        chrome-extension/src/content/fileUpload.ts chrome-extension/test/workdayResume.test.ts
git commit -m "fix(extension): Workday drop zone classifies as a résumé upload and auto-attaches"
```

---

## Task 5: The gap modal renders the page's real control

`overlay.gapInputHTML` renders a `<select>` when options exist, a Yes/No `<select>` for a bare checkbox, and a text input otherwise. A radio group on the page becomes a dropdown in the modal.

**Files:**
- Modify: `src/content/overlay.ts` (`gapInputHTML`, `saveGaps`, gap CSS)
- Test: `test/answerGapsModal.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // overlay.ts — exported for unit test
  export function gapInputHTML(gap: AnswerGap, i: number): string;
  export function readGapAnswer(root: ParentNode, i: number): string;
  ```
  Task 6 calls neither; it only mutates `overlayState.gaps[i].options` before `renderGaps()` runs.

- [ ] **Step 1: Write the failing test**

Create `test/answerGapsModal.test.ts`:

```ts
/**
 * The modal must offer the SAME control the page offers. Rendering every
 * question as a <select> meant a radio group's answer was picked from a
 * dropdown, and a combobox with no harvested options became a free-text box
 * whose typed answer the widget then rejected.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { gapInputHTML, readGapAnswer } from "../src/content/overlay";
import type { AnswerGap } from "../src/content/answerGaps";

const gap = (extra: Partial<AnswerGap> = {}): AnswerGap => ({
  fieldId: "f1",
  question: "Are you legally authorized to work in Canada?",
  controlType: "text",
  category: "unknown",
  options: [],
  required: true,
  sensitive: false,
  ...extra,
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("gapInputHTML", () => {
  it("renders a radio group as real radios, one per option", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(2);
    expect([...radios].map((r) => r.value)).toEqual(["Yes", "No"]);
    expect(root.querySelector("select")).toBeNull();
  });

  it("renders an ARIA radio group the same way", () => {
    const root = mount(gapInputHTML(gap({ controlType: "ariaRadioGroup", options: ["A", "B"] }), 0));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it("renders a checkbox group as checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(3);
  });

  it("renders a dropdown for a select and a combobox with known options", () => {
    for (const controlType of ["select", "combobox", "customDropdown"] as const) {
      const root = mount(gapInputHTML(gap({ controlType, options: ["One", "Two"] }), 0));
      const sel = root.querySelector("select");
      expect(sel, controlType).not.toBeNull();
      expect(sel!.options.length).toBe(3); // placeholder + 2
      root.remove();
    }
  });

  it("renders a bare checkbox as a Yes/No pair", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkbox" }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect([...radios].map((r) => r.value)).toEqual(["Yes", "No"]);
  });

  it("honours a date / number input hint", () => {
    const root = mount(gapInputHTML(gap({ inputType: "date" }), 0));
    expect(root.querySelector("input")!.getAttribute("type")).toBe("date");
  });
});

describe("readGapAnswer", () => {
  it("reads the checked radio", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked = true;
    expect(readGapAnswer(root, 0)).toBe("No");
  });

  it("joins the ticked checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes[0].checked = true;
    boxes[2].checked = true;
    expect(readGapAnswer(root, 0)).toBe("X, Z");
  });

  it("returns empty when nothing is chosen", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    expect(readGapAnswer(root, 0)).toBe("");
  });

  it("reads a select and a text input", () => {
    const sel = mount(gapInputHTML(gap({ controlType: "select", options: ["One", "Two"] }), 0));
    sel.querySelector("select")!.value = "Two";
    expect(readGapAnswer(sel, 0)).toBe("Two");

    const txt = mount(gapInputHTML(gap({ controlType: "text" }), 1));
    txt.querySelector("input")!.value = "  Ottawa  ";
    expect(readGapAnswer(txt, 1)).toBe("Ottawa");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/answerGapsModal.test.ts`
Expected: FAIL — `gapInputHTML` and `readGapAnswer` are not exported.

- [ ] **Step 3: Rewrite `gapInputHTML` and add `readGapAnswer`**

In `src/content/overlay.ts`, replace `gapInputHTML` with:

```ts
/** Control types whose answer is one of a fixed set the page already shows. */
const GAP_CHOICE_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "radioGroup",
  "ariaRadioGroup",
]);
const GAP_MULTI_TYPES: ReadonlySet<ControlType> = new Set<ControlType>(["checkboxGroup"]);

/**
 * The control for one question — the SAME shape the page shows.
 *
 * A radio group rendered as a dropdown is not the question the form asked, and
 * a constrained control rendered as a text box produces an answer the widget
 * will reject. Falls back to a text input only when the page genuinely offers
 * free text (or a dropdown yielded no options — see harvestGapOptions).
 */
export function gapInputHTML(gap: AnswerGap, i: number): string {
  const id = `ap-gap-${i}`;
  const opts = gap.options ?? [];

  if (opts.length > 0 && GAP_CHOICE_TYPES.has(gap.controlType)) {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="radio">${opts
      .map(
        (o, k) => `<label class="ap-gap-choice">
          <input type="radio" name="${id}" value="${esc(o)}" id="${id}-${k}" />
          <span>${esc(o)}</span>
        </label>`
      )
      .join("")}</div>`;
  }

  if (opts.length > 0 && GAP_MULTI_TYPES.has(gap.controlType)) {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="checkbox">${opts
      .map(
        (o, k) => `<label class="ap-gap-choice">
          <input type="checkbox" name="${id}" value="${esc(o)}" id="${id}-${k}" />
          <span>${esc(o)}</span>
        </label>`
      )
      .join("")}</div>`;
  }

  if (opts.length > 0) {
    const options = opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    return `<select class="ap-gap-input" id="${id}" data-i="${i}">
      <option value="">Select an answer…</option>${options}
    </select>`;
  }

  if (gap.controlType === "checkbox") {
    return `<div class="ap-gap-choices" data-i="${i}" data-kind="radio">
      <label class="ap-gap-choice"><input type="radio" name="${id}" value="Yes" /><span>Yes</span></label>
      <label class="ap-gap-choice"><input type="radio" name="${id}" value="No" /><span>No</span></label>
    </div>`;
  }

  const type = gap.inputType === "date" || gap.inputType === "number" ? gap.inputType : "text";
  return `<input class="ap-gap-input" id="${id}" data-i="${i}" type="${esc(type)}" placeholder="Your answer" />`;
}

/** The answer the user gave for question `i`, whatever control it rendered as.
 *  "" when unanswered — an unanswered question is skipped, not an error. */
export function readGapAnswer(root: ParentNode, i: number): string {
  const group = root.querySelector<HTMLElement>(`.ap-gap-choices[data-i="${i}"]`);
  if (group) {
    const picked = [...group.querySelectorAll<HTMLInputElement>("input:checked")].map((el) => el.value);
    return picked.join(", ");
  }
  const single = root.querySelector<HTMLInputElement | HTMLSelectElement>(`.ap-gap-input[data-i="${i}"]`);
  return (single?.value ?? "").trim();
}
```

Add `ControlType` to the type import from `../shared/types` at the top of `overlay.ts` if it is not already there.

- [ ] **Step 4: Read answers through `readGapAnswer` in `saveGaps`**

Replace the collection block at the top of `saveGaps`:

```ts
  const answers: { gap: AnswerGap; value: string }[] = [];
  overlayState.gaps.forEach((gap, i) => {
    const value = readGapAnswer(refs!.gapsBody, i);
    if (value) answers.push({ gap, value });
  });
```

- [ ] **Step 5: Style the new choice list**

In the panel CSS, immediately after the `.ap-gap-input:focus` rule:

```css
.ap-gap-choices { display: flex; flex-direction: column; gap: 6px; }
.ap-gap-choice {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border: 1px solid var(--stripe-hairline); border-radius: 8px;
  font-size: 13px; color: var(--stripe-ink); cursor: pointer; background: #fff;
}
.ap-gap-choice:hover { border-color: var(--stripe-primary-soft); }
.ap-gap-choice input { accent-color: var(--stripe-primary); margin: 0; flex: 0 0 auto; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/answerGapsModal.test.ts test/answerGaps.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/content/overlay.ts chrome-extension/test/answerGapsModal.test.ts
git commit -m "feat(extension): gap modal renders the page's real control (radios, checkboxes, dropdowns)"
```

---

## Task 6: The modal harvests a dropdown's real options

A combobox's options are not in the DOM until it is opened, so a gap for one renders as a text box and its answer is rejected by the widget. The overlay only holds serializable `DetectedField`s — reaching the live control means a new `OverlayCallbacks` op, marshaled cross-frame like every other.

**Files:**
- Modify: `src/shared/types.ts` (`FormOpName`)
- Modify: `src/content/crossFrame.ts` (`ALL_OPS`)
- Modify: `src/content/overlay.ts` (`OverlayCallbacks`, `openGapsModal`, `harvestGapOptions`)
- Modify: `src/content/contentScript.ts` (implement the op over the registry)
- Test: `test/answerGapsModal.test.ts` (extend), `test/crossFrame.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `gapInputHTML` — once `options` is populated it renders a real control with no further change.
- Produces:
  ```ts
  // overlay.ts — OverlayCallbacks gains:
  onHarvestGapOptions: (fieldIds: string[]) => Promise<Record<string, string[]>>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/answerGapsModal.test.ts`:

```ts
import { harvestGapOptions } from "../src/content/overlay";

describe("harvestGapOptions", () => {
  const combo = (fieldId: string): AnswerGap =>
    gap({ fieldId, controlType: "combobox", options: [], question: `Q ${fieldId}` });

  it("asks only about constrained controls with no known options", async () => {
    const asked: string[][] = [];
    const gaps = [
      combo("a"),
      gap({ fieldId: "b", controlType: "text" }),                      // free text — never asked
      gap({ fieldId: "c", controlType: "select", options: ["Yes"] }),  // already known — never asked
    ];
    await harvestGapOptions(gaps, async (ids) => { asked.push(ids); return {}; });
    expect(asked).toEqual([["a"]]);
  });

  it("writes the harvested options back onto the gap", async () => {
    const gaps = [combo("a")];
    await harvestGapOptions(gaps, async () => ({ a: ["Canada", "United States"] }));
    expect(gaps[0].options).toEqual(["Canada", "United States"]);
  });

  it("leaves a widget that yields nothing as free text", async () => {
    const gaps = [combo("a")];
    await harvestGapOptions(gaps, async () => ({}));
    expect(gaps[0].options).toEqual([]);
  });

  it("survives a harvest that throws", async () => {
    const gaps = [combo("a")];
    await expect(
      harvestGapOptions(gaps, async () => { throw new Error("frame gone"); })
    ).resolves.toBeUndefined();
    expect(gaps[0].options).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/answerGapsModal.test.ts`
Expected: FAIL — `harvestGapOptions` is not exported.

- [ ] **Step 3: Declare the op on the callback surface**

In `src/content/overlay.ts`, add to `OverlayCallbacks` after `onAnswerGaps`:

```ts
  /**
   * Read the REAL options of the given fields' controls, by opening each
   * dropdown on the page and closing it again. Keyed by field id; a widget that
   * yields nothing is simply absent from the result.
   */
  onHarvestGapOptions: (fieldIds: string[]) => Promise<Record<string, string[]>>;
```

In `src/shared/types.ts`, add `| "onHarvestGapOptions"` to `FormOpName`.
In `src/content/crossFrame.ts`, add `"onHarvestGapOptions",` to `ALL_OPS` (**not** to `VOID_OPS` — it returns a value).

- [ ] **Step 4: Add the harvest pass to the overlay**

In `src/content/overlay.ts`, beside `renderGaps`:

```ts
/** Constrained controls whose options may not be in the DOM until opened. */
const GAP_HARVEST_TYPES: ReadonlySet<ControlType> = new Set<ControlType>([
  "combobox",
  "customDropdown",
  "select",
]);

/**
 * Fill in the real options for any dropdown the scan could not read.
 *
 * A combobox's listbox is mounted lazily, so `gap.options` is empty and the
 * modal would offer a text box — whose answer the widget then rejects. Opening
 * each dropdown briefly is a visible side effect on the page; it is the price
 * of the modal offering the page's own choices, and it was chosen deliberately
 * over a silent free-text box. Mutates `gaps` in place. Never throws: a frame
 * that has gone away just leaves the questions as free text.
 */
export async function harvestGapOptions(
  gaps: AnswerGap[],
  harvest: (fieldIds: string[]) => Promise<Record<string, string[]>>
): Promise<void> {
  const wanted = gaps.filter((g) => GAP_HARVEST_TYPES.has(g.controlType) && (g.options?.length ?? 0) === 0);
  if (wanted.length === 0) return;
  try {
    const found = await harvest(wanted.map((g) => g.fieldId));
    for (const g of wanted) {
      const opts = found[g.fieldId];
      if (opts && opts.length > 0) g.options = opts;
    }
  } catch {
    // Leave them as free text — an honest fallback, and the pre-existing shape.
  }
}
```

Replace `openGapsModal`:

```ts
function openGapsModal(): void {
  if (!refs || overlayState.gaps.length === 0) return;
  renderGaps();
  refs.gapsError.style.display = "none";
  refs.gapsModal.classList.add("visible");
  // Harvest AFTER showing the modal so it never delays opening; each dropdown
  // that yields options is re-rendered in place when the pass completes.
  if (!callbacks) return;
  const harvest = callbacks.onHarvestGapOptions;
  void harvestGapOptions(overlayState.gaps, harvest).then(() => {
    if (refs?.gapsModal.classList.contains("visible")) renderGaps();
  });
}
```

In `renderGaps`, show a placeholder while a dropdown's options are still unknown — replace the `gapInputHTML(g, i)` interpolation with:

```ts
        ${
          GAP_HARVEST_TYPES.has(g.controlType) && (g.options?.length ?? 0) === 0
            ? `<div class="ap-gap-loading">Loading choices…</div>`
            : gapInputHTML(g, i)
        }
```

Add the style beside `.ap-gap-choices`:

```css
.ap-gap-loading { font-size: 12.5px; color: var(--stripe-ink-mute); padding: 8px 0; }
```

- [ ] **Step 5: Implement the op in the content script**

In `src/content/contentScript.ts`, add the import:

```ts
import { harvestComboboxOptions } from "./comboboxEngine";
```

(If `comboboxEngine` is already imported, extend that import instead of adding a second one.)

Add the callback beside `onAnswerGaps`:

```ts
    /**
     * Read the real options of each field's control for the gaps modal.
     * Sequential and budgeted: each harvest opens and closes a dropdown on the
     * page, and doing several at once would leave two listboxes open at the
     * same time — which several ATS treat as a click-away and close both.
     */
    onHarvestGapOptions: async (fieldIds) => {
      const HARVEST_BUDGET_MS = 4000;
      const PER_WIDGET_MS = 600;
      const out: Record<string, string[]> = {};
      const deadline = Date.now() + HARVEST_BUDGET_MS;
      for (const id of fieldIds) {
        if (Date.now() >= deadline) break;
        const el = registry.get(id)?.el;
        if (!el) continue;
        const options = await harvestComboboxOptions(el, { openWaitMs: PER_WIDGET_MS }).catch(() => undefined);
        if (options && options.length > 0) out[id] = options;
      }
      return out;
    },
```

- [ ] **Step 6: Cover the cross-frame wiring**

Append to `test/crossFrame.test.ts`:

```ts
it("marshals the gap-option harvest and returns its value", async () => {
  const seen: { op: string; args: unknown[] }[] = [];
  const proxy = makeProxyCallbacks(async (op, args) => {
    seen.push({ op, args });
    return { ok: true, value: { f1: ["Yes", "No"] } };
  });
  await expect(proxy.onHarvestGapOptions(["f1"])).resolves.toEqual({ f1: ["Yes", "No"] });
  expect(seen[0].op).toBe("onHarvestGapOptions");
  expect(seen[0].args).toEqual([["f1"]]);
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/answerGapsModal.test.ts test/crossFrame.test.ts`
Expected: PASS. `test/crossFrame.test.ts` already exists — append the new case inside its existing `makeProxyCallbacks` describe block rather than adding a second one.

- [ ] **Step 8: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/crossFrame.ts \
        chrome-extension/src/content/overlay.ts chrome-extension/src/content/contentScript.ts \
        chrome-extension/test/answerGapsModal.test.ts chrome-extension/test/crossFrame.test.ts
git commit -m "feat(extension): gap modal harvests a dropdown's real options before asking"
```

---

## Task 7: The advance gate wears the app's colour

`.ap-flow-next` is `#10cf7f` — a green that appears nowhere else in the panel.

**Files:**
- Modify: `src/content/overlay.ts` (CSS at lines 914–921)
- Test: `test/overlayFlow.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `test/overlayFlow.test.ts`:

```ts
import { STYLES } from "../src/content/overlay";

describe("advance gate styling", () => {
  it("uses the app primary, not the old green", () => {
    const rule = STYLES.slice(
      STYLES.indexOf(".ap-flow-next {"),
      STYLES.indexOf(".ap-flow-next:hover")
    );
    expect(rule).toContain("var(--stripe-primary)");
    for (const green of ["#10cf7f", "#0bb96f", "#0aa563"]) {
      expect(STYLES, green).not.toContain(green);
    }
  });
});
```

`STYLES` is the exported panel stylesheet string (`src/content/overlay.ts`, just below the "Styles" banner comment) — the `.ap-flow-next` rules live there, not in `buildHTML()`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/overlayFlow.test.ts`
Expected: FAIL — the rule still contains `#10cf7f`.

- [ ] **Step 3: Recolour the gate**

Replace the three `.ap-flow-next` rules:

```css
.ap-flow-next {
  width: 100%; padding: 13px 14px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, var(--stripe-primary) 0%, var(--stripe-primary-deep) 100%);
  color: #fff;
  font-family: inherit; font-size: 14px; font-weight: 700; letter-spacing: 0.01em;
  cursor: pointer; transition: box-shadow 0.15s;
  box-shadow: 0 4px 12px rgba(var(--stripe-primary-rgb), 0.25);
}
.ap-flow-next:hover { box-shadow: 0 6px 16px rgba(var(--stripe-primary-rgb), 0.35); }
.ap-flow-next:active { background: var(--stripe-primary-press); box-shadow: none; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/overlayFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/overlay.ts chrome-extension/test/overlayFlow.test.ts
git commit -m "style(extension): advance gate uses the app primary instead of green"
```

---

## Task 8: A wall's own advance beats a terminal match

`advance.findAdvanceButton` returns `{ kind: "terminal" }` on the first `TERMINAL_RE` hit in the scope — and `/\bapply\b/` matches the job posting's "Apply" button, which is still in the document when Workday's account gate shares its scope. The controller then finishes `"done"` and the gate is never offered.

**Files:**
- Modify: `src/content/advance.ts`
- Test: `test/advance.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change — `findAdvanceButton(scope, adapter, { extraAdvance })` behaviour changes only while `extraAdvance` is set.

- [ ] **Step 1: Write the failing test**

Append to `test/advance.test.ts` (it already exists — add `SIGNUP_ADVANCE_RE` to its imports from `../src/content/accountFlow`):

```ts
/**
 * REGRESSION: on Workday the create-account gate shares a scope with the job
 * posting, whose "Apply" button matches TERMINAL_RE. The flow read that as the
 * final submit, finished "done", and the user was left on the account page with
 * no Continue button.
 */
describe("account wall advance", () => {
  function mountWall(): HTMLElement {
    document.body.innerHTML = `
      <div id="scope">
        <button data-automation-id="adventureButton">Apply</button>
        <input type="password" />
        <button data-automation-id="createAccountSubmitButton">Create Account</button>
      </div>`;
    return document.getElementById("scope")!;
  }

  it("prefers the wall's own button over the posting's Apply", () => {
    const found = findAdvanceButton(mountWall(), null, { extraAdvance: SIGNUP_ADVANCE_RE });
    expect(found).not.toBeNull();
    expect(found!.kind).toBe("advance");
    expect(found!.el.textContent).toBe("Create Account");
  });

  it("still reports a terminal submit on an ordinary form page", () => {
    document.body.innerHTML = `
      <div id="scope">
        <button>Back</button>
        <button>Submit Application</button>
      </div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, {});
    expect(found!.kind).toBe("terminal");
  });

  it("does not let a wall regex smuggle past a real submit when no wall is present", () => {
    document.body.innerHTML = `<div id="scope"><button>Submit</button></div>`;
    const found = findAdvanceButton(document.getElementById("scope")!, null, {});
    expect(found!.kind).toBe("terminal");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/advance.test.ts`
Expected: FAIL — the first test gets `kind: "terminal"` with text "Apply".

- [ ] **Step 3: Let the wall's verbs win**

In `src/content/advance.ts`, replace the generic search loop:

```ts
  let advance: HTMLElement | null = null;
  let terminal: HTMLElement | null = null;
  for (const el of deepQueryAll(scope, BUTTON_SELECTOR)) {
    if (!isClickable(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    // A wall's own verb wins outright. `extraAdvance` is set ONLY while an
    // account wall is on the page, and there the posting's "Apply" button —
    // still in the DOM behind the gate — matches TERMINAL_RE and ends the flow
    // on a page the user has not passed yet. A create-account submit is never
    // the application's final submit, so this cannot submit an application.
    if (opts.extraAdvance?.test(text)) return { el, kind: "advance" };
    if (!terminal && TERMINAL_RE.test(text)) terminal = el;
    if (!advance && ADVANCE_RE.test(text)) advance = el;
  }
  if (terminal) return { el: terminal, kind: "terminal" }; // terminal wins over a plain Next
  return advance ? { el: advance, kind: "advance" } : null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/advance.test.ts test/flowController.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/content/advance.ts chrome-extension/test/advance.test.ts
git commit -m "fix(extension): an account wall's own advance beats the posting's Apply"
```

---

## Task 9: A clearable pause still offers the gate

`waitWhileBlocked` runs **before** the gate code, and `showsAdvanceGate` covers only `ready`, `unfilled-required` and `account`. Workday's create-account form renders live `role="alert"` password-rule messages, so `pauseReason` returns `"validation"` and the flow parks with no button and no way forward.

**Files:**
- Modify: `src/content/overlay.ts` (`showsAdvanceGate`)
- Modify: `src/content/flowController.ts` (`waitWhileBlocked`)
- Test: `test/overlayFlow.test.ts` (modify), `test/flowController.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // flowController.ts
  export const USER_CLEARABLE_PAUSES: ReadonlySet<FlowPauseReason>;
  ```

- [ ] **Step 1: Write the failing tests**

In `test/overlayFlow.test.ts`, replace the `"hides the gate on pauses only the page can clear"` test with:

```ts
  /**
   * A validation pause is something the USER fixes on the page — Workday's
   * create-account form shows live password-rule alerts. Parking there with no
   * button stranded the user on the account page with nothing to press.
   */
  it("offers the gate on a validation pause the user can clear", () => {
    expect(showsAdvanceGate(beat({ pauseReason: "validation" }))).toBe(true);
  });

  it("hides the gate on pauses a press could not clear", () => {
    for (const pauseReason of ["captcha", "verification", "resume-upload"]) {
      expect(showsAdvanceGate(beat({ pauseReason })), pauseReason).toBe(false);
    }
  });
```

Append to `test/flowController.test.ts`:

```ts
describe("manual override of a pause", () => {
  /** Deps parked on one pause reason forever, so only a press can move them. */
  function stuckDeps(reason: FlowPauseReason) {
    const { deps, progress } = makeDeps([[field("a", "Name")]], [advanceBtn()]);
    deps.pauseReason = async () => reason;
    return { deps, progress };
  }

  it("lets the user release a validation pause", async () => {
    const { deps, progress } = stuckDeps("validation");
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), tally());
    // Let the controller reach the pause, then press Continue.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    controller.notifyAdvanceRequested();
    controller.stop();
    await run;
    expect(progress.some((p) => p.phase === "paused" && p.pauseReason === "validation")).toBe(true);
  });

  it("ignores a press on a captcha pause — a click cannot solve it", async () => {
    const { deps } = stuckDeps("captcha");
    let polls = 0;
    deps.pauseReason = async () => { polls++; return "captcha"; };
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), tally());
    for (let i = 0; i < 20; i++) await Promise.resolve();
    controller.notifyAdvanceRequested();
    const before = polls;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(polls).toBeGreaterThan(before); // still polling — the press did not release it
    controller.stop();
    await run;
  });
});
```

Add `FlowPauseReason` to the type import at the top of `test/flowController.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/overlayFlow.test.ts test/flowController.test.ts`
Expected: FAIL — `showsAdvanceGate` returns `false` for `validation`; the override test hangs or never releases.

- [ ] **Step 3: Offer the gate on a validation pause**

In `src/content/overlay.ts`, replace `showsAdvanceGate` (keeping the doc comment updated):

```ts
/** Beats where the bottom gate is offered to the user. Pure — unit-tested.
 *  - ready: the page is filled and waiting to be turned.
 *  - unfilled-required: same, with a caveat the panel explains.
 *  - validation: the page is showing its own error text. The user fixes it and
 *    presses Continue; without a button they are stranded — Workday's
 *    create-account gate renders live password-rule alerts on every keystroke.
 *  - account: the flow could not pass a signup/sign-in wall on its own; the
 *    button lets the user hand control back once they have dealt with it,
 *    instead of stranding them on a filled form with no next step.
 *  Captcha / verification / resume-upload are deliberately absent: a press
 *  cannot clear them, and a button that does nothing is worse than none. */
export function showsAdvanceGate(p: FlowProgress): boolean {
  if (p.phase === "ready") return true;
  if (p.phase !== "paused") return false;
  return (
    p.pauseReason === "unfilled-required" ||
    p.pauseReason === "account" ||
    p.pauseReason === "validation"
  );
}
```

- [ ] **Step 4: Honour the press in `waitWhileBlocked`**

In `src/content/flowController.ts`, add near `RESUME_ATTACH_TRIES`:

```ts
/** Pauses a user CAN clear by pressing the panel's advance button — they have
 *  fixed the page (or judged it fine) and want the flow to try again. Captcha,
 *  verification and resume-upload are absent on purpose: the click cannot
 *  clear them, so offering a button that does nothing is worse than none. */
export const USER_CLEARABLE_PAUSES: ReadonlySet<FlowPauseReason> = new Set<FlowPauseReason>([
  "validation",
  "unfilled-required",
  "account",
]);
```

In `waitWhileBlocked`, insert the override check immediately after the `if (!reason) return true;` line:

```ts
      // The user pressed Continue: on a pause they own, that means "I have
      // dealt with this — go". Checked before the emit so a press that lands
      // during the synchronous onProgress is not dropped.
      if (this.advanceRequested && USER_CLEARABLE_PAUSES.has(reason)) {
        this.advanceRequested = false;
        return true;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/overlayFlow.test.ts test/flowController.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add chrome-extension/src/content/overlay.ts chrome-extension/src/content/flowController.ts \
        chrome-extension/test/overlayFlow.test.ts chrome-extension/test/flowController.test.ts
git commit -m "fix(extension): a validation pause offers the gate and a press releases it"
```

---

## Task 10: Prove the gate appears on a Workday account page

Tasks 8 and 9 fix two independent causes. This proves the outcome the user reported — a visible Continue button on the create-account page — in real Chromium with the packaged extension.

**Files:**
- Create: `test/browser/workday-account-gate-probe.mjs`
- Modify: `package.json` (add the script)

**Interfaces:**
- Consumes: Tasks 7, 8 and 9 must be complete — the probe asserts the gate is visible and primary-coloured.
- Produces: nothing.

- [ ] **Step 1: Write the probe**

Create `test/browser/workday-account-gate-probe.mjs`, modelled on `test/browser/workday-account-probe.mjs` (read it first — reuse its server, its Playwright launch flags and its extension-loading setup verbatim):

```js
/**
 * The create-account gate must offer the panel's Continue button.
 *
 * Two independent causes hid it: the posting's "Apply" button (still in the
 * DOM behind the gate) read as the flow's terminal submit, and Workday's live
 * password-rule alerts parked the flow on a `validation` pause that showed no
 * gate. This page reproduces both at once.
 *
 * Usage: npm run test:workday-gate
 */
const ACCOUNT = html(`
  <h1>Create Account</h1>
  <button data-automation-id="adventureButton">Apply</button>
  <div data-automation-id="createAccountPage">
    <label>Email Address <input data-automation-id="email" type="email" name="email"></label>
    <label>Password <input data-automation-id="password" type="password" name="pw"></label>
    <label>Verify New Password <input data-automation-id="verifyPassword" type="password" name="pw2"></label>
    <div role="alert" id="pwrule">Password must contain a special character.</div>
    <button data-automation-id="createAccountSubmitButton" type="button" id="create">Create Account</button>
  </div>`);
```

The assertion, after driving the panel's Autofill click exactly as `workday-account-probe.mjs` does:

```js
  const gate = await panel.waitForSelector(".ap-flow-next-wrap", { state: "visible", timeout: 15000 });
  const label = await panel.$eval("#ap-flow-next", (el) => el.textContent.trim());
  const bg = await panel.$eval("#ap-flow-next", (el) => getComputedStyle(el).backgroundImage);
  if (!gate) throw new Error("FAIL: no advance gate on the create-account page");
  if (!/create account/i.test(label)) throw new Error(`FAIL: gate reads "${label}", expected Create Account`);
  if (!bg.includes("gradient")) throw new Error(`FAIL: gate background is "${bg}", expected the primary gradient`);
  console.log(`PASS: gate visible, label "${label}"`);
```

- [ ] **Step 2: Register the script**

In `chrome-extension/package.json`, add beside `test:workday-account`:

```json
    "test:workday-gate": "node build.mjs && node test/browser/workday-account-gate-probe.mjs",
```

- [ ] **Step 3: Run the probe**

Run: `npm run test:workday-gate`
Expected: `PASS: gate visible, label "Create Account ▶"`.

If it fails, the failure is the diagnosis — read the `[Tailrd flow]` console lines the probe forwards and fix the cause it names before proceeding. Do not weaken the assertion.

- [ ] **Step 4: Re-run the existing Workday probes**

Run: `npm run test:workday-account` then `npm run test:flow`
Expected: both still pass — Tasks 8 and 9 changed advance discovery and pause handling, which both probes exercise.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/test/browser/workday-account-gate-probe.mjs chrome-extension/package.json
git commit -m "test(extension): probe proving the advance gate appears on a Workday account gate"
```

---

## Task 11: Full verification and build

**Files:** none modified — this task only verifies.

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: green apart from the failures recorded in the `pre-existing-test-failures-baseline` memory. Write down the count and compare against that baseline. If a NEW failure appears, fix it before continuing.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/` written with no errors.

- [ ] **Step 4: Browser probes**

Run: `npm run test:flow`, then `npm run test:workday-account`, then `npm run test:workday-gate`
Expected: all pass.

- [ ] **Step 5: Load the built extension and check the panel by hand**

Run: `npm run test:extension`
Confirm visually: the bottom "Continue To The Next Page ▶" bar is violet, not green.

- [ ] **Step 6: Report**

Summarise, for the user: which of Tasks 8 / 9 the probe in Task 10 showed was the real cause on the account page, the unit-test count against the baseline, and anything the plan could not verify without a live Workday tenant (chiefly: the real `education-N--fieldOfStudy` typeahead committing its value, which no fixture can prove).

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| 1a — `value="0"` reads as filled | 1 |
| 1b — split-date fill never fires | 2 |
| 1c — date parts carry no category | 3 |
| 1d — Field of Study fed the degree | 3 |
| 1e — searchBox typeahead / multiselect probes | 3 |
| 2 — modal mirrors the real control | 5 |
| 2 — option harvesting | 6 |
| 3a — gate colour | 7 |
| 3b candidate (b) — terminal false positive | 8 |
| 3b candidate (a) — validation pause hides the gate | 9 |
| 3b — probe that diagnoses and proves | 10 |
| 4 — drop-zone classification + attach selectors | 4 |
| Testing table | 1–10, verified in 11 |

**Deviation from the spec, deliberate:** the spec framed 3b as "probe first, then apply the fix the probe implicates". Both candidates are independently wrong behaviour regardless of which one fires on any given tenant, so both are implemented (Tasks 8 and 9) and the probe (Task 10) becomes the proof of the outcome rather than a branch point. This removes conditional work from the plan and cannot leave one cause unfixed on a tenant the probe does not resemble.

**Extra work found while planning, folded in:** `parseDate` in `workday.ts` rejects `"2025-05"`, which is exactly how the profile stores work-experience dates — so even a repaired container lookup would have filled nothing. Fixed in Task 2, Step 4, and covered by its third test.

**Signatures verified against the real source, not assumed:** `FillContext` is `{ control, value, el }` (`adapters/types.ts:25`) — Task 2's test uses that shape, not a flat `{ el, value, category, … }`. The `.ap-flow-next` rules live in the exported `STYLES` string, not inside `buildHTML()` — Task 7's test reads `STYLES`. `test/advance.test.ts`, `test/crossFrame.test.ts` and `test/helpers/layout.ts` all already exist; `test/fileUpload.test.ts` does not, and nothing references it.

**Type consistency:** `deriveFieldOfStudy` (Task 3) is the same name in the matcher, the resolver case and the test. `dateContainerOf` / `DATE_PART_SELECTOR` (Task 2) are used only in `workday.ts`. `gapInputHTML` / `readGapAnswer` / `harvestGapOptions` (Tasks 5–6) match between overlay, tests and the callback name `onHarvestGapOptions`, which is spelled identically in `OverlayCallbacks`, `FormOpName`, `ALL_OPS` and `contentScript`. `USER_CLEARABLE_PAUSES` (Task 9) is used only inside `flowController.ts`. `GAP_HARVEST_TYPES` is defined in Task 6 and referenced by `renderGaps` in the same task.
