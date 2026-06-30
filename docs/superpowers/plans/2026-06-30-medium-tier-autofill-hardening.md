# Medium Tier Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover all six Medium ATS platforms (Ashby, Workable, SmartRecruiters, Jobvite, Rippling, Bullhorn) via fixtures + tests, adding generic ARIA radiogroup support for Jobvite's custom radios.

**Architecture:** Batch cycle. Probe found 5 platforms lean (react-select + standard fields already handled) and 1 real gap: ARIA `role="radiogroup"` not detected. Add generic ARIA radiogroup support (types + scanner + write engine, TDD'd), then faithful fixtures + tests for all six.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/medium-tier-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only** — the ARIA radiogroup support is platform-agnostic; no hostname branching.
- Preserve hard guarantees: never fill EEO unless toggle on + profile has the answer; never script file inputs; never submit.
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Generic ARIA radiogroup support

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (ControlType union)
- Modify: `chrome-extension/src/content/formScanner.ts` (selector, controlTypeOf, options, currentValue)
- Modify: `chrome-extension/src/content/writeEngine.ts` (write + verify)
- Test: `chrome-extension/test/ariaRadioGroup.test.ts` (new)

**Interfaces:**
- Produces: `ControlType` gains `"ariaRadioGroup"`; `scanPage` detects `role="radiogroup"` controls (options from `role="radio"` text, currentValue from the `aria-checked="true"` option); `writeControl`/`verifyControl` fill them by clicking the matching `role="radio"` and checking `aria-checked`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/ariaRadioGroup.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";

beforeEach(() => {
  document.body.innerHTML = "";
  (window.HTMLElement.prototype as unknown as { getClientRects: () => unknown }).getClientRects =
    () => [{ width: 10, height: 10 }];
});

/** An interactive ARIA radio group (react-aria / Radix style): role=radio divs
 *  that set aria-checked on themselves (and clear siblings) when clicked. */
function radioGroup(label: string, options: string[]): HTMLElement {
  const group = document.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const opt of options) {
    const radio = document.createElement("div");
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", "false");
    radio.setAttribute("data-value", opt);
    radio.textContent = opt;
    radio.addEventListener("click", () => {
      group.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute("aria-checked", "false"));
      radio.setAttribute("aria-checked", "true");
    });
    group.append(radio);
  }
  document.body.append(group);
  return group;
}

describe("ARIA radiogroup support", () => {
  it("detects a role=radiogroup as ariaRadioGroup with its options", () => {
    radioGroup("Will you require sponsorship?", ["Yes", "No"]);
    const { fields } = scanPage(null, false);
    const f = fields.find((x) => x.controlType === "ariaRadioGroup");
    expect(f).toBeDefined();
    expect(f!.options).toEqual(["Yes", "No"]);
  });

  it("fills the matching radio and verifies via aria-checked", () => {
    const group = radioGroup("Will you require sponsorship?", ["Yes", "No"]);
    const { registry } = scanPage(null, false);
    const id = group.getAttribute("data-ap-field")!;
    const control = registry.get(id)!;

    const res = writeControl(control, "No");
    expect(res.written).toBe(true);
    expect(verifyControl(control, "No")).toBe(true);
    expect(group.querySelector('[role="radio"][data-value="No"]')!.getAttribute("aria-checked")).toBe("true");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ariaRadioGroup.test.ts`
Expected: FAIL — the group is not detected (no `ariaRadioGroup` field), so both tests fail.

- [ ] **Step 3: Add the control type**

In `chrome-extension/src/shared/types.ts`, add to the `ControlType` union (after `"combobox"`):
```ts
  | "combobox"
  | "ariaRadioGroup"
  | "customDropdown";
```

- [ ] **Step 4: Detect + describe ARIA radiogroups in the scanner**

In `chrome-extension/src/content/formScanner.ts`:

Add `'[role="radiogroup"]'` to `CANDIDATE_SELECTOR` (after the `[aria-haspopup="listbox"]` entry):
```ts
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  '[role="radiogroup"]',
].join(", ");
```

In `controlTypeOf`, add the check right after the combobox check:
```ts
  if (isAriaCombobox(el)) return "combobox";
  if (el.getAttribute("role") === "radiogroup") return "ariaRadioGroup";
```

Add a helper next to `selectOptions`:
```ts
/** Option labels of an ARIA radio group (its role=radio children). */
function ariaRadioOptions(group: HTMLElement): string[] {
  return Array.from(group.querySelectorAll('[role="radio"]'))
    .map((r) => cleanText(r.getAttribute("aria-label")) || cleanText(r.textContent))
    .filter((t) => t.length > 0)
    .slice(0, 30);
}
```

In `scanPage`, extend the `options` computation:
```ts
    const options =
      el instanceof HTMLSelectElement
        ? selectOptions(el)
        : controlType === "combobox"
          ? readComboboxOptions(el)
          : controlType === "ariaRadioGroup"
            ? ariaRadioOptions(el)
            : undefined;
```

In `currentValueOf`, add before the final `return undefined;`:
```ts
  if (controlType === "ariaRadioGroup") {
    const checked = el.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;
    if (!checked) return undefined;
    return (cleanText(checked.getAttribute("aria-label")) || cleanText(checked.textContent)) || undefined;
  }
```

- [ ] **Step 5: Fill + verify ARIA radiogroups in the write engine**

In `chrome-extension/src/content/writeEngine.ts`, add the `writeControl` case (alongside the other cases, before the `file`/`customDropdown`/`combobox` group):
```ts
    case "ariaRadioGroup":
      return writeAriaRadioGroup(control.el as HTMLElement, value);
```

Add the `verifyControl` case (before the `file`/`customDropdown`/`combobox` group):
```ts
    case "ariaRadioGroup": {
      const group = control.el;
      if (isStale(group)) return false;
      const match = findAriaRadio(group!, value);
      return Boolean(match) && match!.getAttribute("aria-checked") === "true";
    }
```

Add these helpers (near `matchRadio`):
```ts
function ariaRadiosOf(group: HTMLElement): HTMLElement[] {
  return Array.from(group.querySelectorAll('[role="radio"]')).filter(
    (r) => r.getAttribute("aria-disabled") !== "true"
  ) as HTMLElement[];
}

function findAriaRadio(group: HTMLElement, value: string): HTMLElement | null {
  return matchOption(
    ariaRadiosOf(group),
    (r) => cleanText(r.getAttribute("aria-label")) || cleanText(r.textContent),
    (r) => r.getAttribute("data-value") ?? r.getAttribute("value") ?? "",
    value
  );
}

function writeAriaRadioGroup(group: HTMLElement, value: string): WriteResult {
  if (isStale(group)) return { written: false, reason: STALE };
  const match = findAriaRadio(group, value);
  if (!match) return { written: false, reason: `No option matches "${truncate(value)}"` };
  if (match.getAttribute("aria-checked") !== "true") match.click();
  return { written: true };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/ariaRadioGroup.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green; typecheck clean (the new `switch` cases satisfy exhaustiveness).

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/formScanner.ts chrome-extension/src/content/writeEngine.ts chrome-extension/test/ariaRadioGroup.test.ts
git commit -m "feat(extension): support ARIA radio groups (role=radiogroup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Medium-tier fixtures + per-platform tests

**Files:**
- Create: `chrome-extension/test/fixtures/medium.ts`
- Create: `chrome-extension/test/medium.test.ts`

**Interfaces:**
- Consumes: `stubLayout`, `runAutofill`, `scanPage`, `MOCK_PROFILE`, and (indirectly) the ARIA radiogroup support from Task 1.
- Produces: `mountAshbyForm`, `mountWorkableForm`, `mountSmartRecruitersForm`, `mountJobviteForm`, `mountRipplingForm`, `mountBullhornForm` — each `(doc: Document) => void`.

- [ ] **Step 1: Write the fixtures**

Create `chrome-extension/test/fixtures/medium.ts`:
```ts
/**
 * Faithful Medium-tier ATS field markup, mounted in-document (owning-frame view).
 * Shared builders cover the common Medium patterns: standard labelled inputs,
 * native selects, interactive react-select dropdowns, and interactive ARIA radio
 * groups. Reconstructed from known patterns as of 2026-06-30, not copied markup.
 */

function mount(doc: Document, nodes: HTMLElement[]): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.append(...nodes);
  doc.body.appendChild(form);
}

function labeledInput(doc: Document, opts: { id: string; label: string; type?: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.id = opts.id;
  wrap.append(label, input);
  return wrap;
}

function labeledTextarea(doc: Document, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const ta = doc.createElement("textarea");
  ta.id = opts.id;
  wrap.append(label, ta);
  return wrap;
}

function nativeSelect(doc: Document, opts: { id: string; label: string; options: string[] }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const sel = doc.createElement("select");
  sel.id = opts.id;
  const ph = doc.createElement("option");
  ph.value = "";
  ph.textContent = "Select…";
  sel.append(ph);
  for (const o of opts.options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  wrap.append(label, sel);
  return wrap;
}

function fileField(doc: Document, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = "file";
  input.id = opts.id;
  wrap.append(label, input);
  return wrap;
}

/** Interactive react-select: input[role=combobox] whose menu mounts on mousedown
 *  and commits the choice into .select__single-value on option mousedown. */
function reactSelect(doc: Document, opts: { id: string; label: string; options: string[] }): HTMLElement {
  const control = doc.createElement("div");
  control.id = opts.id;
  control.className = "select";
  const single = doc.createElement("div");
  single.className = "select__single-value";
  const input = doc.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-label", opts.label);
  const lbId = `${opts.id}-lb`;
  input.setAttribute("aria-controls", lbId);
  control.append(single, input);
  const render = (): void => {
    if (input.getAttribute("aria-expanded") !== "true") return;
    if (doc.getElementById(lbId)) return;
    const lb = doc.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const label of opts.options) {
      const o = doc.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = label;
      o.addEventListener("mousedown", () => {
        single.textContent = label;
        input.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(o);
    }
    control.append(lb);
  };
  input.addEventListener("mousedown", () => {
    input.setAttribute("aria-expanded", "true");
    render();
  });
  return control;
}

/** Interactive ARIA radio group: role=radio divs that set aria-checked on click. */
function ariaRadioGroup(doc: Document, opts: { label: string; options: string[] }): HTMLElement {
  const group = doc.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", opts.label);
  for (const opt of opts.options) {
    const radio = doc.createElement("div");
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", "false");
    radio.setAttribute("data-value", opt);
    radio.textContent = opt;
    radio.addEventListener("click", () => {
      group.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute("aria-checked", "false"));
      radio.setAttribute("aria-checked", "true");
    });
    group.append(radio);
  }
  return group;
}

const COUNTRIES = ["United States", "Canada", "Mexico"];
const GENDERS = ["Male", "Female", "Decline to self-identify"];

export function mountAshbyForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "ashby-firstname", label: "First Name" }),
    labeledInput(doc, { id: "ashby-email", label: "Email", type: "email" }),
    reactSelect(doc, { id: "ashby-country", label: "Country", options: COUNTRIES }),
    fileField(doc, { id: "ashby-resume", label: "Resume" }),
    nativeSelect(doc, { id: "ashby-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountWorkableForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "workable-firstname", label: "First Name" }),
    labeledInput(doc, { id: "workable-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "workable-phone", label: "Phone", type: "tel" }),
    reactSelect(doc, { id: "workable-country", label: "Country", options: COUNTRIES }),
  ]);
}

export function mountSmartRecruitersForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "sr-firstname", label: "First Name" }),
    labeledInput(doc, { id: "sr-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "sr-email", label: "Email", type: "email" }),
    labeledTextarea(doc, { id: "sr-custom", label: "What excites you about this opportunity?" }),
  ]);
}

export function mountJobviteForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "jobvite-firstname", label: "First Name" }),
    labeledInput(doc, { id: "jobvite-email", label: "Email", type: "email" }),
    ariaRadioGroup(doc, { label: "Will you now or in the future require sponsorship for employment visa status?", options: ["Yes", "No"] }),
    nativeSelect(doc, { id: "jobvite-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountRipplingForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "rippling-firstname", label: "First Name" }),
    labeledInput(doc, { id: "rippling-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "rippling-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "rippling-phone", label: "Phone", type: "tel" }),
  ]);
}

export function mountBullhornForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "bullhorn-firstname", label: "First Name" }),
    labeledInput(doc, { id: "bullhorn-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "bullhorn-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "bullhorn-phone", label: "Phone", type: "tel" }),
  ]);
}
```

- [ ] **Step 2: Write the per-platform tests**

Create `chrome-extension/test/medium.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mountAshbyForm,
  mountWorkableForm,
  mountSmartRecruitersForm,
  mountJobviteForm,
  mountRipplingForm,
  mountBullhornForm,
} from "./fixtures/medium";
import { stubLayout } from "./helpers/layout";
import { runAutofill } from "./helpers/autofill";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
const singleValue = (wrapId: string) =>
  document.getElementById(wrapId)!.querySelector(".select__single-value")!.textContent;
const cats = () => new Set(scanPage(MOCK_PROFILE, false).fields.map((f) => f.category));

describe("Ashby", () => {
  it("detects + fills text, react-select country; skips resume + EEO", async () => {
    mountAshbyForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("email") && c.has("location") && c.has("resumeUpload")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("ashby-firstname")).toBe("John");
    expect(val("ashby-email")).toBe("john@example.com");
    expect(singleValue("ashby-country")).toBe("Canada");
    expect(val("ashby-resume")).toBe("");
    expect(val("ashby-gender")).toBe("");
  });
});

describe("Workable", () => {
  it("detects + fills text and react-select country", async () => {
    mountWorkableForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("email") && c.has("phone")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("workable-firstname")).toBe("John");
    expect(val("workable-phone")).toBe("+1 555 555 5555");
    expect(singleValue("workable-country")).toBe("Canada");
  });
});

describe("SmartRecruiters", () => {
  it("fills standard fields and leaves a custom question unknown/unfilled", async () => {
    mountSmartRecruitersForm(document);
    const fields = scanPage(MOCK_PROFILE, false).fields;
    const custom = fields.find((f) => f.label.toLowerCase().includes("excites you"));
    expect(custom?.category).toBe("unknown");
    await runAutofill(MOCK_PROFILE, false);
    expect(val("sr-firstname")).toBe("John");
    expect(val("sr-lastname")).toBe("Doe");
    expect(val("sr-email")).toBe("john@example.com");
    expect(val("sr-custom")).toBe(""); // unknown → never auto-filled
  });
});

describe("Jobvite", () => {
  it("fills text and the ARIA radiogroup (sponsorship = No); skips EEO", async () => {
    mountJobviteForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("sponsorship")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("jobvite-firstname")).toBe("John");
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-value")).toBe("No");
    expect(val("jobvite-gender")).toBe("");
  });
});

describe("Rippling", () => {
  it("fills clean React text fields", async () => {
    mountRipplingForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("rippling-firstname")).toBe("John");
    expect(val("rippling-lastname")).toBe("Doe");
    expect(val("rippling-email")).toBe("john@example.com");
    expect(val("rippling-phone")).toBe("+1 555 555 5555");
  });
});

describe("Bullhorn", () => {
  it("fills simple standard fields", async () => {
    mountBullhornForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("bullhorn-firstname")).toBe("John");
    expect(val("bullhorn-lastname")).toBe("Doe");
    expect(val("bullhorn-email")).toBe("john@example.com");
    expect(val("bullhorn-phone")).toBe("+1 555 555 5555");
  });
});
```

- [ ] **Step 3: Run the medium tests**

Run: `npx vitest run test/medium.test.ts`
Expected: PASS (6 tests). react-select country commits "Canada"; Jobvite's ARIA radiogroup commits "No" (via Task 1); the SmartRecruiters custom question stays `unknown`/unfilled. A failure is a real gap — fix generically.

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/medium.ts chrome-extension/test/medium.test.ts
git commit -m "test(extension): Medium-tier fixtures + detection/fill coverage (6 platforms)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Confirm regression + check off the Medium tier

**Files:**
- Modify: `docs/ats-coverage.md` (six Medium `[ ]` → `[x]`, progress `5 / 15` → `11 / 15`)
- Add: the spec + this plan.

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `ariaRadioGroup.test.ts` and `medium.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check the Medium tier off in the tracker**

In `docs/ats-coverage.md`:
- Change each of these from `[ ]` to `[x]`: `**Ashby**`, `**Workable**`, `**SmartRecruiters**`, `**Jobvite**`, `**Rippling**`, `**Bullhorn**`.
- Change `**Progress:** 5 / 15 covered` to `**Progress:** 11 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-medium-tier-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-medium-tier-autofill-hardening.md
git commit -m "docs: add Medium-tier autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark Medium tier covered in ATS tracker (11/15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD → Tasks 1–3; §3 ARIA radiogroup engine change (types + scanner + write engine) → Task 1; §4 fixtures (6 builders incl. react-select + ARIA radiogroup) → Task 2; §5 testing (engine unit test + per-platform) → Tasks 1–2; §7 deliverables → Tasks 1–3. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** `"ariaRadioGroup"` added to `ControlType` (Task 1) and handled in `controlTypeOf`/`writeControl`/`verifyControl`/`currentValueOf`; `ariaRadioOptions` (scanner) vs `ariaRadiosOf`/`findAriaRadio`/`writeAriaRadioGroup` (write engine) are distinct, consistently used; the six `mount*Form` names match between `medium.ts` and `medium.test.ts`; element ids consistent between fixtures and assertions; `runAutofill`/`stubLayout`/`scanPage`/`MOCK_PROFILE` match existing modules. ✓

**Empirical basis:** lean platforms (react-select + standard fields) probe-confirmed; the ARIA radiogroup gap probe-confirmed (not detected today → Task 1 is a genuine red→green); `runAutofill` already routes `ariaRadioGroup` through the reconciler (non-combobox path).
