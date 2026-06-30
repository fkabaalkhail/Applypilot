# Easy Tier Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover the 4 Easy ATS platforms (Greenhouse, Lever, BambooHR, Breezy HR) via fixtures + tests, finishing the tracker at 15/15.

**Architecture:** Pure lean verification batch — standard HTML forms the engine already handles (probe-confirmed; `scan-smoke` covers the shape). No engine change.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/easy-tier-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only**; preserve hard guarantees (never fill EEO unless toggle on + profile has it; never script file inputs; never submit).
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Easy-tier fixtures + per-platform tests

**Files:**
- Create: `chrome-extension/test/fixtures/easy.ts`
- Create: `chrome-extension/test/easy.test.ts`

**Interfaces:**
- Consumes: `stubLayout`, `runAutofill`, `scanPage`, `MOCK_PROFILE`.
- Produces: `mountGreenhouseForm`, `mountLeverForm`, `mountBambooHrForm`, `mountBreezyForm` — each `(doc: Document) => void`.

- [ ] **Step 1: Write the fixtures**

Create `chrome-extension/test/fixtures/easy.ts`:
```ts
/**
 * Faithful Easy-tier ATS field markup (Greenhouse, Lever, BambooHR, Breezy HR):
 * standard, well-labelled HTML — label/for inputs, native selects, plain
 * textareas, native radio groups. Mounted in-document. Reconstructed from known
 * patterns as of 2026-06-30, not copied markup.
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

function nativeRadioGroup(doc: Document, opts: { name: string; legend: string; options: string[] }): HTMLElement {
  const fs = doc.createElement("fieldset");
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

const COUNTRIES = ["United States", "Canada", "Mexico"];
const GENDERS = ["Male", "Female", "Decline to self-identify"];

export function mountGreenhouseForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "gh-firstname", label: "First Name" }),
    labeledInput(doc, { id: "gh-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "gh-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "gh-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "gh-country", label: "Country", options: COUNTRIES }),
    labeledInput(doc, { id: "gh-linkedin", label: "LinkedIn Profile", type: "url" }),
    fileField(doc, { id: "gh-resume", label: "Resume/CV" }),
    labeledTextarea(doc, { id: "gh-cover", label: "Cover Letter" }),
    nativeRadioGroup(doc, { name: "gh-sponsor", legend: "Will you now or in the future require sponsorship?", options: ["Yes", "No"] }),
    nativeSelect(doc, { id: "gh-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountLeverForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "lever-firstname", label: "First Name" }),
    labeledInput(doc, { id: "lever-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "lever-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "lever-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "lever-country", label: "Country", options: COUNTRIES }),
    labeledTextarea(doc, { id: "lever-cover", label: "Cover Letter" }),
  ]);
}

export function mountBambooHrForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "bamboo-firstname", label: "First Name" }),
    labeledInput(doc, { id: "bamboo-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "bamboo-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "bamboo-phone", label: "Phone", type: "tel" }),
  ]);
}

export function mountBreezyForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "breezy-firstname", label: "First Name" }),
    labeledInput(doc, { id: "breezy-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "breezy-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "breezy-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "breezy-country", label: "Country", options: COUNTRIES }),
  ]);
}
```

- [ ] **Step 2: Write the per-platform tests**

Create `chrome-extension/test/easy.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mountGreenhouseForm,
  mountLeverForm,
  mountBambooHrForm,
  mountBreezyForm,
} from "./fixtures/easy";
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

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

describe("Greenhouse", () => {
  it("detects + fills the full form; skips resume + EEO", async () => {
    mountGreenhouseForm(document);
    const fields = scanPage(MOCK_PROFILE, false).fields;
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);

    await runAutofill(MOCK_PROFILE, false);
    expect(val("gh-firstname")).toBe("John");
    expect(val("gh-lastname")).toBe("Doe");
    expect(val("gh-email")).toBe("john@example.com");
    expect(val("gh-phone")).toBe("+1 555 555 5555");
    expect(val("gh-country")).toBe("Canada");
    expect(val("gh-linkedin")).toBe("https://linkedin.com/in/johndoe");
    expect(val("gh-cover")).toBe("Please generate or insert the saved cover letter here.");
    expect((document.querySelector('input[name="gh-sponsor"]:checked') as HTMLInputElement | null)?.value).toBe("No");
    expect(val("gh-resume")).toBe("");
    expect(val("gh-gender")).toBe("");
  });
});

describe("Lever", () => {
  it("fills standard fields, country select, and the cover-letter textarea", async () => {
    mountLeverForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("lever-firstname")).toBe("John");
    expect(val("lever-email")).toBe("john@example.com");
    expect(val("lever-phone")).toBe("+1 555 555 5555");
    expect(val("lever-country")).toBe("Canada");
    expect(val("lever-cover")).toBe("Please generate or insert the saved cover letter here.");
  });
});

describe("BambooHR", () => {
  it("fills the short standard form", async () => {
    mountBambooHrForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("bamboo-firstname")).toBe("John");
    expect(val("bamboo-lastname")).toBe("Doe");
    expect(val("bamboo-email")).toBe("john@example.com");
    expect(val("bamboo-phone")).toBe("+1 555 555 5555");
  });
});

describe("Breezy HR", () => {
  it("fills the short standard form + country select", async () => {
    mountBreezyForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("breezy-firstname")).toBe("John");
    expect(val("breezy-email")).toBe("john@example.com");
    expect(val("breezy-country")).toBe("Canada");
  });
});
```

- [ ] **Step 3: Run the easy tests**

Run: `npx vitest run test/easy.test.ts`
Expected: PASS (4 tests). Standard label/for + native controls all classify + fill; country selects resolve "Ottawa, ON, Canada" → "Canada"; cover-letter textareas get the profile cover letter; Greenhouse sponsorship radio = "No"; resume + EEO untouched.

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/easy.ts chrome-extension/test/easy.test.ts
git commit -m "test(extension): Easy-tier fixtures + detection/fill coverage (4 platforms)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Confirm regression + check off the Easy tier (tracker complete)

**Files:**
- Modify: `docs/ats-coverage.md` (four Easy `[ ]` → `[x]`, progress `11 / 15` → `15 / 15`)
- Add: the spec + this plan.

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `easy.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check the Easy tier off in the tracker**

In `docs/ats-coverage.md`:
- Change each of these from `[ ]` to `[x]`: `**Greenhouse**`, `**Lever**`, `**BambooHR**`, `**Breezy HR**`.
- Change `**Progress:** 11 / 15 covered` to `**Progress:** 15 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-easy-tier-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-easy-tier-autofill-hardening.md
git commit -m "docs: add Easy-tier autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark Easy tier covered in ATS tracker (15/15, all tiers complete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD → Tasks 1–2; §3 in-scope fixtures (4 builders) + tests → Task 1; "no engine change" → Global Constraints; §4 testing → Tasks 1–2; §6 deliverables → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** the four `mount*Form` names match between `easy.ts` and `easy.test.ts`; element ids (`gh-*`, `lever-*`, `bamboo-*`, `breezy-*`) consistent between fixtures and assertions; helper names used consistently; `runAutofill`/`stubLayout`/`scanPage`/`MOCK_PROFILE` match existing modules. ✓

**Empirical basis:** standard-HTML classification + fill is probe-confirmed and already exercised end-to-end by `scan-smoke`; `val()` covers input/select/textarea; the Greenhouse sponsorship assertion reads the checked native radio.
