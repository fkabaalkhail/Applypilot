# ADP Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify (fixture-driven) that the engine classifies and fills an ADP-style application form with inconsistent naming + mixed label sources, and check ADP off the tracker.

**Architecture:** Lean verification cycle (like iCIMS/Taleo). A probe confirmed the matcher's existing signal set absorbs ADP's non-semantic names + mixed label sources (sibling `<label>`/`<span>`, `placeholder`, `aria-label`), so **no engine change is expected**; ADP's iframe coordination is the same pre-built, cross-realm, unit-tested-and-live-spot-checked path as iCIMS. This cycle adds a `<div>`-layout fixture + tests and the checkmark.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/adp-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only** — no per-ATS modules / hostname branching. A real gap → minimal generic fix (debug per superpowers:systematic-debugging).
- Preserve hard guarantees: never fill EEO unless toggle on + profile has the answer; never script file inputs; never submit.
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: ADP fixture + detection & fill tests

**Files:**
- Create: `chrome-extension/test/fixtures/adp.ts`
- Create: `chrome-extension/test/adp.test.ts`

**Interfaces:**
- Consumes: `stubLayout`, `runAutofill`, `scanPage`, `MOCK_PROFILE`.
- Produces: `mountAdpForm(doc: Document): void` — clears `doc.body` and mounts a `<div>`-layout ADP form with non-semantic `name`s and mixed label sources.

- [ ] **Step 1: Write the fixture builder**

Create `chrome-extension/test/fixtures/adp.ts`:
```ts
/**
 * Reproduces ADP's inconsistent-naming, div-layout field markup as the
 * owning-frame content-script instance sees it: non-semantic `name`s, labels drawn
 * from a mix of sibling <label>, <span> caption, placeholder, and aria-label. The
 * iframe wrapper is a cross-realm coordination concern verified via crossFrame unit
 * tests + a live spot-check (see
 * docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md §1.1).
 * Reconstructed from known ADP patterns as of 2026-06-30, not copied markup.
 */

function div(doc: Document, ...children: Node[]): HTMLElement {
  const d = doc.createElement("div");
  d.append(...children);
  return d;
}

function capDiv(doc: Document, text: string): HTMLElement {
  const d = doc.createElement("div");
  d.textContent = text;
  return d;
}

function labelEl(doc: Document, text: string): HTMLElement {
  const l = doc.createElement("label");
  l.textContent = text;
  return l;
}

function spanEl(doc: Document, text: string): HTMLElement {
  const s = doc.createElement("span");
  s.textContent = text;
  return s;
}

function input(
  doc: Document,
  id: string,
  name: string,
  attrs: { type?: string; placeholder?: string; ariaLabel?: string } = {}
): HTMLInputElement {
  const el = doc.createElement("input");
  el.type = attrs.type ?? "text";
  el.id = id;
  el.setAttribute("name", name);
  if (attrs.placeholder) el.setAttribute("placeholder", attrs.placeholder);
  if (attrs.ariaLabel) el.setAttribute("aria-label", attrs.ariaLabel);
  return el;
}

function select(doc: Document, id: string, name: string, options: string[]): HTMLSelectElement {
  const sel = doc.createElement("select");
  sel.id = id;
  sel.setAttribute("name", name);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  sel.append(placeholder);
  for (const o of options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  return sel;
}

export function mountAdpForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "adp-apply";

  // sibling <label> (no for=) → nearbyText
  form.append(div(doc, labelEl(doc, "First Name"), input(doc, "adp-firstname", "DFEAAB01")));
  // <span> caption → nearbyText
  form.append(div(doc, spanEl(doc, "Last Name"), input(doc, "adp-lastname", "DFEAAB02")));
  // placeholder only
  form.append(div(doc, input(doc, "adp-email", "DFEAAB03", { placeholder: "Email Address" })));
  // aria-label only
  form.append(div(doc, input(doc, "adp-phone", "DFEAAB04", { ariaLabel: "Phone Number" })));
  // caption div above a nested input → nearbyText climbs
  form.append(div(doc, capDiv(doc, "Home City"), div(doc, input(doc, "adp-city", "DFEAAB05"))));
  // Country select with sibling label
  form.append(div(doc, labelEl(doc, "Country"), select(doc, "adp-country", "DFEAAB06", ["United States", "Canada", "Mexico"])));
  // Resume file with sibling label
  form.append(div(doc, labelEl(doc, "Resume"), input(doc, "adp-resume", "DFEAAB07", { type: "file" })));
  // EEO selects with sibling labels
  form.append(div(doc, labelEl(doc, "Gender"), select(doc, "adp-gender", "DFEAAB08", ["Male", "Female", "Decline to self-identify"])));
  form.append(div(doc, labelEl(doc, "Race/Ethnicity"), select(doc, "adp-ethnicity", "DFEAAB09", ["Asian", "White", "Decline to self-identify"])));
  form.append(div(doc, labelEl(doc, "Veteran Status"), select(doc, "adp-veteran", "DFEAAB10", ["I am not a veteran", "I am a veteran"])));

  doc.body.appendChild(form);
}
```

- [ ] **Step 2: Write the failing detection + fill test**

Create `chrome-extension/test/adp.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountAdpForm } from "./fixtures/adp";
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

describe("ADP div-layout markup — detection", () => {
  it("classifies fields across mixed label sources + non-semantic names", () => {
    mountAdpForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountAdpForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("ADP div-layout markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountAdpForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("adp-firstname")).toBe("John");
    expect(val("adp-lastname")).toBe("Doe");
    expect(val("adp-email")).toBe("john@example.com");
    expect(val("adp-phone")).toBe("+1 555 555 5555");
    expect(val("adp-city")).toBe("Ottawa, ON, Canada");
    expect(val("adp-country")).toBe("Canada");
    expect(val("adp-resume")).toBe("");
    expect(val("adp-gender")).toBe("");
  });
});
```

- [ ] **Step 3: Run the ADP test**

Run: `npx vitest run test/adp.test.ts`
Expected: PASS (3 tests). Sibling `<label>`/`<span>` and caption-div labels resolve via `nearbyText`; `placeholder`/`aria-label` via their own signals; the Country `<select>` resolves "Ottawa, ON, Canada" → "Canada"; resume + EEO untouched. A missing category is a real gap — fix generically.

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/adp.ts chrome-extension/test/adp.test.ts
git commit -m "test(extension): ADP div-layout fixture + detection & autofill coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Confirm regression + check ADP off

**Files:**
- Modify: `docs/ats-coverage.md` (ADP `[ ]` → `[x]`, progress `3 / 15` → `4 / 15`)
- Add: the spec + this plan.

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `adp.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check ADP off in the tracker**

In `docs/ats-coverage.md`:
- Change `- [ ] **ADP Recruiting Management** *(ADP Inc.)*` to `- [x] **ADP Recruiting Management** *(ADP Inc.)*`.
- Change `**Progress:** 3 / 15 covered` to `**Progress:** 4 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-adp-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-adp-autofill-hardening.md
git commit -m "docs: add ADP autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark ADP covered in ATS tracker (4/15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD → Tasks 1–2; §3 in-scope fixture (mixed label sources, non-semantic names) + tests → Task 1; "no engine change, generic fix if gap" → Global Constraints + Task 1 Step 3; §3 out-of-scope (iframe end-to-end, shadow reach) → not in any task; §5 testing → Tasks 1–2; §7 deliverables → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** `mountAdpForm(doc)` defined Task 1, used in both describes; element ids (`adp-firstname`…`adp-veteran`) consistent between fixture and assertions; helper names (`div`/`capDiv`/`labelEl`/`spanEl`/`input`/`select`) used consistently within the fixture; `runAutofill`/`stubLayout`/`scanPage`/`MOCK_PROFILE` match existing modules. ✓

**Empirical basis:** the in-document div fixture is the owning-frame view; mixed-label-source classification is probe-confirmed; the iframe coordination path is intentionally covered by existing `crossFrame` unit tests + a live spot-check.
