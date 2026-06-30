# Workday Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (with a faithful fixture + tests) that the generic autofill engine reliably fills a Workday "My Information" step, and add the one generic signal (`data-automation-id`) it needs, then check Workday off in the coverage tracker.

**Architecture:** Generic-signal hardening (Approach A) — no per-ATS handlers. Extend the shared matcher to read developer test-ids; add an interactive Workday fixture builder + a layout-stub helper; drive the real `scanPage → AutofillReconciler → fillAriaCombobox` pipeline against it in vitest.

**Tech Stack:** TypeScript (strict), vitest + jsdom, esbuild. Extension lives in `chrome-extension/`.

## Global Constraints

- Work inside `chrome-extension/` on a feature branch off `main`: `feat/workday-autofill-hardening`.
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Do not use `npm test`** — it exits 1 with no output in this environment (a known stdio quirk, not a failure).
- `npm run typecheck` (strict `tsc --noEmit`) must pass; no new dependencies.
- **Generic only** — no hostname branching and no per-ATS modules. The matcher/scanner/combobox engine stay platform-agnostic.
- Preserve hard guarantees: never fill EEO unless the toggle is on **and** the profile has the answer; never script `<input type=file>`; never submit.
- Commit after each task once its tests are green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Developer test-id matcher signal (`data-automation-id`, `data-testid`, …)

**Files:**
- Modify: `chrome-extension/src/content/domUtils.ts` (add `testId` to `FieldSignals`; populate it in `collectSignals`)
- Modify: `chrome-extension/src/content/fieldMatcher.ts` (add `testId` to `SOURCE_WEIGHTS`)
- Test: `chrome-extension/test/fieldMatcher.test.ts` (new)

**Interfaces:**
- Consumes: existing `collectSignals(el)` and `classifyField(signals)`.
- Produces: `FieldSignals.testId: string`; classification now considers developer test-ids at weight `0.7`.

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd chrome-extension
git checkout -b feat/workday-autofill-hardening
```

- [ ] **Step 2: Write the failing test**

Create `chrome-extension/test/fieldMatcher.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectSignals } from "../src/content/domUtils";
import { classifyField } from "../src/content/fieldMatcher";

/** An <input> carrying only a developer test-id (no label/name/placeholder). */
function elWithTestId(attr: string, value: string): HTMLElement {
  const el = document.createElement("input");
  el.setAttribute(attr, value);
  return el;
}

describe("collectSignals — developer test-ids", () => {
  it("captures data-automation-id as testId", () => {
    expect(collectSignals(elWithTestId("data-automation-id", "legalNameSection_firstName")).testId).toBe(
      "legalNameSection_firstName"
    );
  });

  it("falls back through data-testid / data-test / data-qa", () => {
    expect(collectSignals(elWithTestId("data-qa", "candidate-email")).testId).toBe("candidate-email");
  });

  it("is empty when no test-id attribute is present", () => {
    expect(collectSignals(document.createElement("input")).testId).toBe("");
  });
});

describe("classifyField — test-id drives classification when labels are absent", () => {
  const classifyId = (id: string) => classifyField(collectSignals(elWithTestId("data-automation-id", id)));

  it("classifies a Workday first-name field from data-automation-id alone", () => {
    expect(classifyId("legalNameSection_firstName").category).toBe("firstName");
  });

  it("classifies a Workday country dropdown id as location", () => {
    expect(classifyId("countryDropdown").category).toBe("location");
  });

  it("does not invent a category from a meaningless id", () => {
    expect(classifyId("input-15").category).toBe("unknown");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/fieldMatcher.test.ts`
Expected: FAIL — `collectSignals(...).testId` is `undefined` (property does not exist yet), and the data-automation-id classifications return `unknown`.

- [ ] **Step 4: Add `testId` to `FieldSignals` and populate it**

In `chrome-extension/src/content/domUtils.ts`, extend the `FieldSignals` interface (add the `testId` field after `typeHint`):
```ts
  /** Native input type ("email", "tel", "url"…) — a strong category hint. */
  typeHint: string;
  /** Developer-assigned test ids (Workday's data-automation-id, data-testid…) —
   *  stable semantic anchors when labels are generic or missing. */
  testId: string;
```

Add this helper immediately above `collectSignals`:
```ts
/**
 * First present developer-assigned test id. Workday's `data-automation-id` is the
 * most valuable; the `data-testid` / `data-test` / `data-qa` family covers most
 * React/Vue/Angular apps. These are author-declared semantics, so they make a
 * strong matching signal where visible labels are generic or missing.
 */
function testIdOf(el: HTMLElement): string {
  for (const attr of ["data-automation-id", "data-testid", "data-test", "data-qa"]) {
    const v = el.getAttribute(attr);
    if (v) return v;
  }
  return "";
}
```

In the `collectSignals` return object, add the `testId` line (alongside the existing fields):
```ts
    autocomplete: (el.getAttribute("autocomplete") ?? "").trim().toLowerCase(),
    typeHint: el instanceof HTMLInputElement ? el.type : "",
    testId: testIdOf(el),
  };
```

- [ ] **Step 5: Add `testId` to the matcher's source weights**

In `chrome-extension/src/content/fieldMatcher.ts`, add the `testId` entry to `SOURCE_WEIGHTS` between `nameAttr` and `idAttr`:
```ts
const SOURCE_WEIGHTS: Array<{ key: keyof FieldSignals; weight: number }> = [
  { key: "label", weight: 0.95 },
  { key: "ariaLabel", weight: 0.92 },
  { key: "placeholder", weight: 0.82 },
  { key: "nameAttr", weight: 0.72 },
  { key: "testId", weight: 0.7 },
  { key: "idAttr", weight: 0.66 },
  { key: "nearby", weight: 0.6 },
];
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/fieldMatcher.test.ts`
Expected: PASS (all 6 assertions). `legalNameSection_firstName` → `firstName` (0.7), `countryDropdown` → `location` (0.7 × 0.75 = 0.525 ≥ 0.35), `input-15` → `unknown`.

- [ ] **Step 7: Verify no regressions + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: entire suite PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/content/domUtils.ts src/content/fieldMatcher.ts test/fieldMatcher.test.ts
git commit -m "feat(extension): use developer test-ids (data-automation-id) as a matching signal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Workday fixture builder + layout stub + detection test

**Files:**
- Create: `chrome-extension/test/helpers/layout.ts`
- Create: `chrome-extension/test/fixtures/workday.ts`
- Test: `chrome-extension/test/workday.test.ts` (new — detection block only)

**Interfaces:**
- Produces:
  - `stubLayout(): () => void` — patches `HTMLElement.prototype.getClientRects` so jsdom controls count as visible; returns a restore function.
  - `mountWorkdayMyInfo(doc: Document): { root: HTMLElement }` — clears `doc.body` and mounts a faithful Workday "My Information" step.

- [ ] **Step 1: Write the layout-stub helper**

Create `chrome-extension/test/helpers/layout.ts`:
```ts
/**
 * jsdom has no layout engine, so getClientRects() returns an empty list and the
 * scanner's isVisible() rejects every control. Pretend each element occupies a
 * box so visibility-gated discovery runs the way it does in a real browser. Call
 * the returned function in afterAll to restore the original behavior.
 */
export function stubLayout(): () => void {
  const proto = window.HTMLElement.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function (): DOMRectList {
    return [{ width: 100, height: 20 }] as unknown as DOMRectList;
  };
  return () => {
    proto.getClientRects = original;
  };
}
```

- [ ] **Step 2: Write the Workday fixture builder**

Create `chrome-extension/test/fixtures/workday.ts`:
```ts
/**
 * Faithful reproduction of a Workday "My Information" application step, built as
 * INTERACTIVE DOM (dropdowns mount their listbox on click and commit on option
 * click) so the real combobox engine can drive it under jsdom.
 *
 * Structure mirrors the Workday candidate experience as of 2026-06-30 —
 * reconstructed from known Workday DOM patterns (data-automation-id anchors,
 * label/aria-labelledby associations, button[aria-haspopup=listbox] dropdowns with
 * a portaled role=listbox of role=option items). NOT copied markup.
 */

export interface WorkdayFixture {
  root: HTMLElement;
}

/** A labelled text input wrapped the way Workday wraps fields. */
function textField(
  doc: Document,
  opts: { automationId: string; label: string; id: string; type?: string }
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-automation-id", `formField-${opts.automationId}`);
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.id = opts.id;
  input.setAttribute("data-automation-id", opts.automationId);
  input.setAttribute("aria-labelledby", `${opts.id}-label`);
  wrap.append(label, input);
  return wrap;
}

/** A Workday button[aria-haspopup=listbox] dropdown: mounts a portaled listbox on
 *  click and writes the chosen label back into the button (Workday's pattern). */
function buttonListbox(
  doc: Document,
  opts: { automationId: string; label: string; id: string; options: string[] }
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-automation-id", `formField-${opts.automationId}`);
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.textContent = opts.label;
  const btn = doc.createElement("button");
  btn.id = opts.id;
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-labelledby", `${opts.id}-label`);
  btn.setAttribute("data-automation-id", opts.automationId);
  btn.textContent = "Select One";
  const lbId = `${opts.id}-listbox`;
  btn.setAttribute("aria-controls", lbId);
  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") return;
    btn.setAttribute("aria-expanded", "true");
    const lb = doc.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const optLabel of opts.options) {
      const o = doc.createElement("div");
      o.setAttribute("role", "option");
      o.setAttribute("data-automation-id", "promptOption");
      o.textContent = optLabel;
      o.addEventListener("click", () => {
        btn.textContent = optLabel;
        btn.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(o);
    }
    doc.body.append(lb); // Workday portals the menu to the body
  });
  wrap.append(label, btn);
  return wrap;
}

/** A Yes/No radio group (fieldset + legend), as Workday renders screening Qs. */
function radioGroup(
  doc: Document,
  opts: { name: string; legend: string; options: string[]; automationId: string }
): HTMLElement {
  const fs = doc.createElement("fieldset");
  fs.setAttribute("data-automation-id", opts.automationId);
  const legend = doc.createElement("legend");
  legend.textContent = opts.legend;
  fs.append(legend);
  for (const opt of opts.options) {
    const id = `${opts.name}-${opt}`.toLowerCase().replace(/\s+/g, "-");
    const label = doc.createElement("label");
    label.setAttribute("for", id);
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.id = id;
    radio.name = opts.name;
    radio.value = opt;
    label.append(radio, doc.createTextNode(opt));
    fs.append(label);
  }
  return fs;
}

/** A native <select> with a placeholder, as Workday uses for voluntary disclosures. */
function selectField(
  doc: Document,
  opts: { id: string; label: string; options: string[]; automationId: string }
): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const sel = doc.createElement("select");
  sel.id = opts.id;
  sel.setAttribute("data-automation-id", opts.automationId);
  sel.setAttribute("aria-labelledby", `${opts.id}-label`);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select One";
  sel.append(placeholder);
  for (const opt of opts.options) {
    const o = doc.createElement("option");
    o.value = opt;
    o.textContent = opt;
    sel.append(o);
  }
  wrap.append(label, sel);
  return wrap;
}

export function mountWorkdayMyInfo(doc: Document): WorkdayFixture {
  doc.body.innerHTML = "";
  const form = doc.createElement("div");
  form.setAttribute("data-automation-id", "applyFlowPage");

  // Legal name
  form.append(textField(doc, { automationId: "legalNameSection_firstName", label: "First Name", id: "wd-first" }));
  form.append(textField(doc, { automationId: "legalNameSection_lastName", label: "Last Name", id: "wd-last" }));
  // Contact
  form.append(textField(doc, { automationId: "email", label: "Email", id: "wd-email", type: "email" }));
  form.append(textField(doc, { automationId: "phoneNumber", label: "Phone Number", id: "wd-phone", type: "tel" }));
  // Address (Country dropdown + City text — structured address is out of scope)
  form.append(
    buttonListbox(doc, {
      automationId: "countryDropdown",
      label: "Country",
      id: "wd-country",
      options: ["United States", "Canada", "Mexico", "United Kingdom"],
    })
  );
  form.append(textField(doc, { automationId: "addressSection_city", label: "City", id: "wd-city" }));
  // Source (no profile mapping — should stay `unknown`)
  form.append(
    buttonListbox(doc, {
      automationId: "source",
      label: "How Did You Hear About Us?",
      id: "wd-source",
      options: ["LinkedIn", "Referral", "Company Website"],
    })
  );
  // Links
  form.append(textField(doc, { automationId: "linkedinQuestion", label: "LinkedIn Profile", id: "wd-linkedin", type: "url" }));
  // Screening
  form.append(
    buttonListbox(doc, {
      automationId: "workAuthorization",
      label: "Are you legally authorized to work in this country?",
      id: "wd-workauth",
      options: ["Yes", "No"],
    })
  );
  form.append(
    radioGroup(doc, {
      name: "sponsorship",
      legend: "Will you now or in the future require sponsorship for employment visa status?",
      options: ["Yes", "No"],
      automationId: "sponsorshipQuestion",
    })
  );
  // Resume (labelled file input — detected, never scripted)
  const resumeWrap = doc.createElement("div");
  resumeWrap.setAttribute("data-automation-id", "resumeSection");
  const resumeLabel = doc.createElement("label");
  resumeLabel.id = "wd-resume-label";
  resumeLabel.setAttribute("for", "wd-resume");
  resumeLabel.textContent = "Resume/CV";
  const resume = doc.createElement("input");
  resume.type = "file";
  resume.id = "wd-resume";
  resume.setAttribute("data-automation-id", "file-upload-input-ref");
  resume.setAttribute("aria-labelledby", "wd-resume-label");
  resumeWrap.append(resumeLabel, resume);
  form.append(resumeWrap);
  // Voluntary disclosures (EEO)
  form.append(selectField(doc, { id: "wd-gender", label: "Gender", options: ["Male", "Female", "Decline to self-identify"], automationId: "gender" }));
  form.append(selectField(doc, { id: "wd-ethnicity", label: "Race/Ethnicity", options: ["Asian", "White", "Decline to self-identify"], automationId: "ethnicity" }));
  form.append(selectField(doc, { id: "wd-veteran", label: "Veteran Status", options: ["I am not a veteran", "I am a veteran"], automationId: "veteranStatus" }));

  doc.body.append(form);
  return { root: form };
}
```

- [ ] **Step 3: Write the failing detection test**

Create `chrome-extension/test/workday.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountWorkdayMyInfo } from "./fixtures/workday";
import { stubLayout } from "./helpers/layout";
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

describe("Workday My Information — detection", () => {
  it("classifies the core profile fields", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location", "linkedin", "workAuthorization", "sponsorship", "resumeUpload"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file as non-fillable", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });

  it("leaves the unmapped Source dropdown classified unknown", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const source = fields.find((f) => f.label.toLowerCase().includes("hear about"));
    expect(source).toBeDefined();
    expect(source!.category).toBe("unknown");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `npx vitest run test/workday.test.ts`
Expected: it FAILS first only if a file is missing/mis-imported; once Steps 1–2 are in place it PASSES (the scanner already classifies labelled controls). If any `expect(...).toBe(true)` fails, that is a real discovery gap — debug it generically (matcher/scanner), never with a Workday special-case.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/layout.ts test/fixtures/workday.ts test/workday.test.ts
git commit -m "test(extension): faithful Workday My Information fixture + detection coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end fill + verify against the Workday fixture

**Files:**
- Modify: `chrome-extension/test/workday.test.ts` (add an `autofill` helper + a fill describe block)

**Interfaces:**
- Consumes: `mountWorkdayMyInfo`, `stubLayout`, `scanPage`, `AutofillReconciler`, `fillAriaCombobox`, `MOCK_PROFILE`.

- [ ] **Step 1: Write the failing fill test**

In `chrome-extension/test/workday.test.ts`, add these imports at the top (next to the existing ones):
```ts
import { AutofillReconciler } from "../src/content/reconciler";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../src/shared/types";
```

Then add this helper (below the imports, above the `describe` blocks) and a new describe block at the end of the file:
```ts
const fastCombo = { sleep: async () => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

/**
 * Run the real two-phase fill the content script performs in onAutofill:
 * the reconciler drives text/select/radio; the combobox engine drives ARIA
 * dropdowns one-shot. Mirrors src/content/contentScript.ts.
 */
async function autofill(profile: UserApplicationProfile, fillEEO: boolean): Promise<void> {
  const { fields, registry } = scanPage(profile, fillEEO);
  const targets = fields.filter((f) => f.fillable && f.proposedValue !== null);

  const engine = new AutofillReconciler({ sleep: async () => {}, observe: false });
  await engine.run(
    targets
      .filter((f) => f.controlType !== "combobox")
      .map((f) => ({ fieldId: f.id, value: f.proposedValue as string })),
    registry
  );
  engine.dispose();

  for (const f of targets.filter((f) => f.controlType === "combobox")) {
    await fillAriaCombobox(registry.get(f.id)!.el!, f.proposedValue as string, fastCombo);
  }
}

describe("Workday My Information — autofill", () => {
  it("fills text fields, the country & work-auth dropdowns, and the sponsorship radio", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(val("wd-first")).toBe("John");
    expect(val("wd-last")).toBe("Doe");
    expect(val("wd-email")).toBe("john@example.com");
    expect(val("wd-phone")).toBe("+1 555 555 5555");
    expect(val("wd-city")).toBe("Ottawa, ON, Canada");
    expect(val("wd-linkedin")).toBe("https://linkedin.com/in/johndoe");
    expect(document.getElementById("wd-country")!.textContent).toBe("Canada");
    expect(document.getElementById("wd-workauth")!.textContent).toBe("Yes");
    expect((document.querySelector('input[name="sponsorship"]:checked') as HTMLInputElement | null)?.value).toBe("No");
  });

  it("never writes into the resume file input", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    expect((document.getElementById("wd-resume") as HTMLInputElement).value).toBe("");
  });

  it("leaves EEO selects untouched when the toggle is off", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    expect((document.getElementById("wd-gender") as HTMLSelectElement).value).toBe("");
    expect((document.getElementById("wd-ethnicity") as HTMLSelectElement).value).toBe("");
    expect((document.getElementById("wd-veteran") as HTMLSelectElement).value).toBe("");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/workday.test.ts`
Expected: PASS. Notes on the mechanics, so a failure can be diagnosed:
- `wd-city` keeps the whole `location` string by the project's existing convention (see `scan-smoke.mjs`).
- Country: `matchOption` token logic matches "Ottawa, ON, Canada" → option "Canada".
- Work-auth combobox: `toYesNo("Authorized to work in Canada")` → "Yes".
- Sponsorship radio: `toYesNo("No")` → "No".
If a value assertion fails, treat the test as the spec and apply the **minimal generic fix** (likely in `comboboxEngine.ts` or `fieldMatcher.ts`) — debug with superpowers:systematic-debugging; do not special-case Workday.

- [ ] **Step 3: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/workday.test.ts
git commit -m "test(extension): end-to-end Workday autofill (text, dropdowns, radio, EEO/resume skipped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: EEO-enabled fill + multi-step rescan

**Files:**
- Modify: `chrome-extension/test/workday.test.ts` (two more describe blocks)

**Interfaces:**
- Consumes: everything from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `chrome-extension/test/workday.test.ts`:
```ts
describe("Workday — EEO only when explicitly enabled", () => {
  it("fills an EEO select when the toggle is on AND the profile has the answer", async () => {
    mountWorkdayMyInfo(document);
    const withEeo: UserApplicationProfile = {
      ...MOCK_PROFILE,
      eeo: {
        gender: "Female",
        race: "Asian",
        hispanicLatino: "No",
        veteranStatus: "I am not a veteran",
        disabilityStatus: "No",
      },
    };
    await autofill(withEeo, true);
    expect((document.getElementById("wd-gender") as HTMLSelectElement).value).toBe("Female");
    expect((document.getElementById("wd-veteran") as HTMLSelectElement).value).toBe("I am not a veteran");
  });
});

describe("Workday — multi-step rescan", () => {
  it("re-detects fields after a step transition replaces the form", () => {
    mountWorkdayMyInfo(document);
    const first = scanPage(MOCK_PROFILE, false);
    expect(first.fields.some((f) => f.category === "firstName")).toBe(true);

    // Workday SPA navigation: the next step replaces the form subtree.
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.id = "cl-label";
    label.setAttribute("for", "cl");
    label.textContent = "Cover Letter";
    const ta = document.createElement("textarea");
    ta.id = "cl";
    ta.setAttribute("aria-labelledby", "cl-label");
    wrap.append(label, ta);
    document.body.append(wrap);

    const second = scanPage(MOCK_PROFILE, false);
    expect(second.fields.some((f) => f.category === "coverLetter")).toBe(true);
    expect(second.fields.some((f) => f.category === "firstName")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/workday.test.ts`
Expected: PASS. `eeo.gender="Female"` matches the `Female` option exactly; with `fillEEO=true` the resolver returns it. The rescan re-runs `scanPage` over the replaced DOM and finds the cover-letter textarea while the old fields are gone.

Note: if `UserApplicationProfile.eeo` is typed as optional with a narrower shape, match the existing keys in `src/shared/types.ts` exactly — the resolver reads `eeo.gender`, `eeo.race`, `eeo.hispanicLatino`, `eeo.veteranStatus`, `eeo.disabilityStatus`.

- [ ] **Step 3: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/workday.test.ts
git commit -m "test(extension): Workday EEO-toggle gating and multi-step rescan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Confirm full regression + check Workday off

**Files:**
- Modify: `docs/ats-coverage.md` (Workday `[ ]` → `[x]`, progress `0 / 15` → `1 / 15`)

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: all test files pass, including the new `fieldMatcher.test.ts` and `workday.test.ts`.

- [ ] **Step 2: Run the headless smoke test (sample-form regression)**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED` — proves the `testId` signal did not regress the existing sample-form classifications/fills.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check Workday off in the tracker**

In `docs/ats-coverage.md`:
- Change the Workday line from `- [ ] **Workday** *(Workday Inc.)*` to `- [x] **Workday** *(Workday Inc.)*`.
- Change `**Progress:** 0 / 15 covered` to `**Progress:** 1 / 15 covered`.

- [ ] **Step 5: Commit**

```bash
git add docs/ats-coverage.md
git commit -m "docs: mark Workday covered in ATS tracker (1/15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §2 definition of done → Tasks 3–5 (fill green, suite green, checkmark). ✓
- §3 in-scope fields (name/email/phone/city/country/source/work-auth/sponsorship/LinkedIn/resume/EEO/multi-step) → fixture (Task 2) + tests (Tasks 2–4). ✓
- §4.1 `testId` signal → Task 1. §4.2 combobox (verify-only) → exercised by Task 3, with a debug note if a gap appears. §4.3 observer reach → deferred (per spec). ✓
- §5 TS fixture builder → Task 2. §6 testing strategy → Tasks 2–5. §7 risks (regression guard) → full-suite + smoke runs in Tasks 1/3/4/5. §8 deliverables → all tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code; every run step states the expected result. ✓

**Type/name consistency:** `stubLayout`/`mountWorkdayMyInfo`/`autofill`/`fastCombo` are defined once and reused; `MOCK_PROFILE`, `scanPage`, `AutofillReconciler`, `fillAriaCombobox`, `collectSignals`, `classifyField`, `FieldSignals.testId`, `SOURCE_WEIGHTS` match the source exactly; element ids (`wd-first`, `wd-country`, …) are consistent between the builder and the assertions. ✓

**Known empirical risk:** Tasks 2–4 assume the engine already handles the labelled Workday markup (only Task 1 is a guaranteed code change). If an integration assertion fails, that is the fixture doing its job — apply a minimal generic fix and keep the suite green.
