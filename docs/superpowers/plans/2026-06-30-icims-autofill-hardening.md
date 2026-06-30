# iCIMS Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify (fixture-driven) that the engine classifies and fills an iCIMS application form as the owning frame instance sees it, extract the shared autofill test helper, and check iCIMS off the tracker.

**Architecture:** Lean verification cycle. Per the design's empirical finding (§1.1), a same-origin iframe is a separate JS realm, so the top frame can't classify in-iframe fields — production handles that via the iframe's own content-script instance + the already-built, unit-tested `crossFrame` coordination. So this cycle verifies iCIMS **field markup** (mounted in-document = owning-frame view) and leaves the iframe coordination to existing `crossFrame` unit tests + a live spot-check. **No engine change is expected.**

**Tech Stack:** TypeScript (strict), vitest + jsdom, esbuild. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/icims-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (exits 1 with no output here — stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only** — no per-ATS modules or hostname branching. If a test exposes a gap, fix it generically (matcher/scanner), debugging with superpowers:systematic-debugging.
- Preserve hard guarantees: never fill EEO unless toggle on + profile has the answer; never script file inputs; never submit.
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Extract the shared `runAutofill` test helper

**Files:**
- Create: `chrome-extension/test/helpers/autofill.ts`
- Modify: `chrome-extension/test/workday.test.ts` (use the helper; drop the inline copy)
- Test: re-run `chrome-extension/test/workday.test.ts` (must stay green)

**Interfaces:**
- Produces: `runAutofill(profile: UserApplicationProfile, fillEEO: boolean): Promise<void>` — scans the global `document` and runs the real two-phase fill (reconciler for text/select/radio; combobox engine for ARIA dropdowns).

- [ ] **Step 1: Create the shared helper**

Create `chrome-extension/test/helpers/autofill.ts`:
```ts
import { scanPage } from "../../src/content/formScanner";
import { AutofillReconciler } from "../../src/content/reconciler";
import { fillAriaCombobox } from "../../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../../src/shared/types";

const fastCombo = { sleep: async () => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

/**
 * Run the real two-phase fill the content script performs in onAutofill: the
 * reconciler drives text/select/radio; the combobox engine drives ARIA dropdowns
 * one-shot. Scans the global document, so it works for any fixture mounted there.
 */
export async function runAutofill(profile: UserApplicationProfile, fillEEO: boolean): Promise<void> {
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
```

- [ ] **Step 2: Refactor the Workday test to use it — replace the import block**

In `chrome-extension/test/workday.test.ts`, replace the top import block + inline helper:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountWorkdayMyInfo } from "./fixtures/workday";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { AutofillReconciler } from "../src/content/reconciler";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../src/shared/types";

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

let restore: () => void;
```
with:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountWorkdayMyInfo } from "./fixtures/workday";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { runAutofill } from "./helpers/autofill";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
```

- [ ] **Step 3: Point the Workday call sites at the helper**

In `chrome-extension/test/workday.test.ts`, replace every occurrence of `await autofill(` with `await runAutofill(` (4 call sites). Exact replacement: find `await autofill(` → `await runAutofill(`.

- [ ] **Step 4: Run the Workday test to verify it still passes**

Run: `npx vitest run test/workday.test.ts`
Expected: PASS (8 tests) — identical fill logic, now imported.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean (no unused-import errors — `AutofillReconciler`/`fillAriaCombobox` removed from the Workday test, `UserApplicationProfile` still used by the EEO test).

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/test/helpers/autofill.ts chrome-extension/test/workday.test.ts
git commit -m "test(extension): extract shared runAutofill helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: iCIMS fixture + detection test

**Files:**
- Create: `chrome-extension/test/fixtures/icims.ts`
- Create: `chrome-extension/test/icims.test.ts`

**Interfaces:**
- Produces: `mountIcimsForm(doc: Document): void` — clears `doc.body` and mounts an iCIMS application form (in-document = owning-frame view).

- [ ] **Step 1: Write the fixture builder**

Create `chrome-extension/test/fixtures/icims.ts`:
```ts
/**
 * Reproduces iCIMS application field markup as the owning-frame content-script
 * instance sees it (mounted in-document; the #icims_content_iframe wrapper is a
 * cross-realm coordination concern verified via crossFrame unit tests + a live
 * spot-check — see docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md
 * §1.1). Reconstructed from known iCIMS patterns as of 2026-06-30, not copied markup.
 */

function labelled(doc: Document, control: HTMLElement, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  control.id = opts.id;
  wrap.append(label, control);
  return wrap;
}

function textInput(doc: Document, opts: { id: string; name: string; label: string; type?: string }): HTMLElement {
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.setAttribute("name", opts.name);
  return labelled(doc, input, opts);
}

function selectInput(doc: Document, opts: { id: string; name: string; label: string; options: string[] }): HTMLElement {
  const sel = doc.createElement("select");
  sel.setAttribute("name", opts.name);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  sel.append(placeholder);
  for (const o of opts.options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  return labelled(doc, sel, opts);
}

export function mountIcimsForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "icims_apply_form";
  form.append(textInput(doc, { id: "icims-firstname", name: "fields[firstname]", label: "First Name" }));
  form.append(textInput(doc, { id: "icims-lastname", name: "fields[lastname]", label: "Last Name" }));
  form.append(textInput(doc, { id: "icims-email", name: "fields[email]", label: "Email", type: "email" }));
  form.append(textInput(doc, { id: "icims-phone", name: "fields[phone]", label: "Phone", type: "tel" }));
  form.append(textInput(doc, { id: "icims-city", name: "fields[city]", label: "City" }));
  form.append(
    selectInput(doc, { id: "icims-country", name: "fields[country]", label: "Country", options: ["United States", "Canada", "Mexico"] })
  );
  const resume = doc.createElement("input");
  resume.type = "file";
  resume.setAttribute("name", "fields[resume]");
  form.append(labelled(doc, resume, { id: "icims-resume", label: "Resume" }));
  form.append(selectInput(doc, { id: "icims-gender", name: "fields[gender]", label: "Gender", options: ["Male", "Female", "Decline to self-identify"] }));
  form.append(selectInput(doc, { id: "icims-ethnicity", name: "fields[ethnicity]", label: "Race/Ethnicity", options: ["Asian", "White", "Decline to self-identify"] }));
  form.append(selectInput(doc, { id: "icims-veteran", name: "fields[veteran]", label: "Veteran Status", options: ["I am not a veteran", "I am a veteran"] }));
  doc.body.appendChild(form);
}
```

- [ ] **Step 2: Write the failing detection test**

Create `chrome-extension/test/icims.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountIcimsForm } from "./fixtures/icims";
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

describe("iCIMS field markup — detection", () => {
  it("classifies the core fields", () => {
    mountIcimsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountIcimsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});
```

- [ ] **Step 3: Run the detection test**

Run: `npx vitest run test/icims.test.ts`
Expected: PASS. Labels drive classification (`First Name`→firstName, `Email`→email, `Phone`→phone, `City`/`Country`→location); the `fields[firstname]` name attribute corroborates. If a category is missing, that is a real gap — fix generically (matcher), not with an iCIMS special-case.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/icims.ts chrome-extension/test/icims.test.ts
git commit -m "test(extension): iCIMS field-markup fixture + detection coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: iCIMS end-to-end fill test

**Files:**
- Modify: `chrome-extension/test/icims.test.ts` (add the `runAutofill` import + a fill describe block)

**Interfaces:**
- Consumes: `runAutofill` (Task 1), `mountIcimsForm` (Task 2).

- [ ] **Step 1: Add the helper import**

In `chrome-extension/test/icims.test.ts`, add after the `MOCK_PROFILE` import:
```ts
import { runAutofill } from "./helpers/autofill";
```

- [ ] **Step 2: Write the failing fill test**

Append to `chrome-extension/test/icims.test.ts`:
```ts
describe("iCIMS field markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountIcimsForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("icims-firstname")).toBe("John");
    expect(val("icims-lastname")).toBe("Doe");
    expect(val("icims-email")).toBe("john@example.com");
    expect(val("icims-phone")).toBe("+1 555 555 5555");
    expect(val("icims-city")).toBe("Ottawa, ON, Canada");
    expect(val("icims-country")).toBe("Canada");
    expect(val("icims-resume")).toBe("");
    expect(val("icims-gender")).toBe("");
  });
});
```

- [ ] **Step 3: Run the fill test**

Run: `npx vitest run test/icims.test.ts`
Expected: PASS. City keeps the whole `location` string (existing convention); the Country `<select>` resolves "Ottawa, ON, Canada" → option "Canada" via token match; resume + EEO untouched (no value / EEO toggle off).

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/icims.test.ts
git commit -m "test(extension): end-to-end iCIMS autofill (text + country select; resume/EEO skipped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Confirm regression + check iCIMS off

**Files:**
- Modify: `docs/ats-coverage.md` (iCIMS `[ ]` → `[x]`, progress `1 / 15` → `2 / 15`)
- Add: the spec + this plan (planning artifacts for the branch)

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `icims.test.ts` and the refactored `workday.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check iCIMS off in the tracker**

In `docs/ats-coverage.md`:
- Change `- [ ] **iCIMS** *(iCIMS Inc.)*` to `- [x] **iCIMS** *(iCIMS Inc.)*`.
- Change `**Progress:** 1 / 15 covered` to `**Progress:** 2 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-icims-autofill-hardening.md
git commit -m "docs: add iCIMS autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark iCIMS covered in ATS tracker (2/15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §2 DoD (fixture detection+fill green, crossFrame green, suite+smoke green, checkmark) → Tasks 2–4. ✓
- §3 in-scope fixture + tests + shared-helper extraction → Tasks 1–3. "No engine change expected; generic fix if a gap" → noted in Global Constraints + Task 2/3 run steps. ✓
- §3 out-of-scope (observer reach, x-origin end-to-end, shadow-root reach) → not in any task, by design. ✓
- §5 testing (runAutofill helper, detection, fill, regression guard) → Tasks 1–4. ✓
- §7 deliverables → Tasks 1–4. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every run step states the expected result. ✓

**Type/name consistency:** `runAutofill(profile, fillEEO)` defined in Task 1, consumed in Task 3 and the refactored Workday test; `mountIcimsForm(doc)` defined Task 2, used Tasks 2–3; element ids (`icims-firstname`…`icims-veteran`) consistent between fixture and assertions; `stubLayout`, `scanPage`, `MOCK_PROFILE` match existing modules. ✓

**Known empirical basis:** the in-document fixture is the owning-frame view, justified by the probe in spec §1.1; the iframe-coordination path is intentionally verified by existing `crossFrame` unit tests + a live spot-check, not re-proven here.
