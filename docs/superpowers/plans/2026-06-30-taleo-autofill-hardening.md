# Taleo Autofill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify (fixture-driven) that the engine classifies and fills a Taleo legacy table-layout application form, and check Taleo off the tracker.

**Architecture:** Lean verification cycle (like iCIMS). A probe confirmed `nearbyText` already resolves Taleo's table-cell labels, so **no engine change is expected**; Taleo's iframe coordination is the same pre-built, cross-realm, unit-tested-and-live-spot-checked path as iCIMS. This cycle adds a table-layout fixture + tests and the checkmark.

**Tech Stack:** TypeScript (strict), vitest + jsdom. Extension in `chrome-extension/`.

## Global Constraints

- Already on branch `feat/taleo-autofill-hardening` (off `main`).
- Run tests with `npx vitest run [file]` from `chrome-extension/`. **Not `npm test`** (stdio quirk).
- `npm run typecheck` must pass; no new dependencies.
- **Generic only** — no per-ATS modules / hostname branching. A real gap → minimal generic fix (debug per superpowers:systematic-debugging).
- Preserve hard guarantees: never fill EEO unless toggle on + profile has the answer; never script file inputs; never submit.
- Commit after each task once green. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Taleo table-layout fixture + detection & fill tests

**Files:**
- Create: `chrome-extension/test/fixtures/taleo.ts`
- Create: `chrome-extension/test/taleo.test.ts`

**Interfaces:**
- Consumes: `stubLayout` (`test/helpers/layout.ts`), `runAutofill` (`test/helpers/autofill.ts`), `scanPage`, `MOCK_PROFILE`.
- Produces: `mountTaleoForm(doc: Document): void` — clears `doc.body` and mounts a `<table>`-based Taleo form whose labels are bare text in sibling/preceding cells (no `for=`).

- [ ] **Step 1: Write the fixture builder**

Create `chrome-extension/test/fixtures/taleo.ts`:
```ts
/**
 * Reproduces Taleo's legacy table-layout field markup as the owning-frame
 * content-script instance sees it: labels are bare text in a sibling <td> (no
 * `for=`), so classification rides on domUtils nearbyText. The iframe wrapper is a
 * cross-realm coordination concern verified via crossFrame unit tests + a live
 * spot-check (see docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md
 * §1.1). Reconstructed from known Taleo patterns as of 2026-06-30, not copied markup.
 */

function row(doc: Document, labelText: string, control: HTMLElement): HTMLElement {
  const tr = doc.createElement("tr");
  const tdLabel = doc.createElement("td");
  tdLabel.textContent = labelText;
  const tdControl = doc.createElement("td");
  tdControl.appendChild(control);
  tr.append(tdLabel, tdControl);
  return tr;
}

function textInput(doc: Document, id: string, name: string, type = "text"): HTMLInputElement {
  const input = doc.createElement("input");
  input.type = type;
  input.id = id;
  input.setAttribute("name", name);
  return input;
}

function selectInput(doc: Document, id: string, name: string, options: string[]): HTMLSelectElement {
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

export function mountTaleoForm(doc: Document): void {
  doc.body.innerHTML = "";
  const table = doc.createElement("table");
  const tbody = doc.createElement("tbody");

  tbody.append(row(doc, "First Name", textInput(doc, "taleo-firstname", "p_firstname")));
  tbody.append(row(doc, "Last Name", textInput(doc, "taleo-lastname", "p_lastname")));
  tbody.append(row(doc, "Email", textInput(doc, "taleo-email", "p_email")));
  tbody.append(row(doc, "Phone", textInput(doc, "taleo-phone", "p_phone")));
  tbody.append(row(doc, "City", textInput(doc, "taleo-city", "p_city")));
  tbody.append(row(doc, "Country", selectInput(doc, "taleo-country", "p_country", ["United States", "Canada", "Mexico"])));

  const resume = textInput(doc, "taleo-resume", "p_resume", "file");
  tbody.append(row(doc, "Resume", resume));

  tbody.append(row(doc, "Gender", selectInput(doc, "taleo-gender", "p_gender", ["Male", "Female", "Decline to self-identify"])));
  tbody.append(row(doc, "Race/Ethnicity", selectInput(doc, "taleo-ethnicity", "p_ethnicity", ["Asian", "White", "Decline to self-identify"])));
  tbody.append(row(doc, "Veteran Status", selectInput(doc, "taleo-veteran", "p_veteran", ["I am not a veteran", "I am a veteran"])));

  table.appendChild(tbody);
  doc.body.appendChild(table);
}
```

- [ ] **Step 2: Write the failing detection + fill test**

Create `chrome-extension/test/taleo.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountTaleoForm } from "./fixtures/taleo";
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

describe("Taleo table-layout markup — detection", () => {
  it("classifies fields whose labels live in sibling table cells", () => {
    mountTaleoForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountTaleoForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("Taleo table-layout markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountTaleoForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("taleo-firstname")).toBe("John");
    expect(val("taleo-lastname")).toBe("Doe");
    expect(val("taleo-email")).toBe("john@example.com");
    expect(val("taleo-phone")).toBe("+1 555 555 5555");
    expect(val("taleo-city")).toBe("Ottawa, ON, Canada");
    expect(val("taleo-country")).toBe("Canada");
    expect(val("taleo-resume")).toBe("");
    expect(val("taleo-gender")).toBe("");
  });
});
```

- [ ] **Step 3: Run the Taleo test**

Run: `npx vitest run test/taleo.test.ts`
Expected: PASS (3 tests). `nearbyText` resolves the table-cell labels (probe-confirmed); the Country `<select>` resolves "Ottawa, ON, Canada" → "Canada"; resume + EEO untouched. If a category is missing, that is a real gap — fix generically (`nearbyText`/matcher), debugging per systematic-debugging.

- [ ] **Step 4: Full suite + typecheck + commit**

Run: `npx vitest run` (expected all green), `npm run typecheck` (expected clean), then:
```bash
git add chrome-extension/test/fixtures/taleo.ts chrome-extension/test/taleo.test.ts
git commit -m "test(extension): Taleo table-layout fixture + detection & autofill coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Confirm regression + check Taleo off

**Files:**
- Modify: `docs/ats-coverage.md` (Taleo `[ ]` → `[x]`, progress `2 / 15` → `3 / 15`)
- Add: the spec + this plan.

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all files pass, including `taleo.test.ts`.

- [ ] **Step 2: Smoke regression**

Run: `node test/scan-smoke.mjs`
Expected: `SMOKE TEST PASSED`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Check Taleo off in the tracker**

In `docs/ats-coverage.md`:
- Change `- [ ] **Taleo** *(Oracle)*` to `- [x] **Taleo** *(Oracle)*`.
- Change `**Progress:** 2 / 15 covered` to `**Progress:** 3 / 15 covered`.

- [ ] **Step 5: Commit docs + spec + plan**

```bash
git add docs/superpowers/specs/2026-06-30-taleo-autofill-hardening-design.md docs/superpowers/plans/2026-06-30-taleo-autofill-hardening.md
git commit -m "docs: add Taleo autofill hardening spec + plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git add docs/ats-coverage.md
git commit -m "docs: mark Taleo covered in ATS tracker (3/15)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 DoD → Tasks 1–2; §3 in-scope fixture + tests → Task 1; "no engine change, generic fix if gap" → Global Constraints + Task 1 Step 3; §3 out-of-scope (iframe end-to-end, exotic widgets, shadow reach) → not in any task by design; §5 testing → Tasks 1–2; §7 deliverables → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; explicit expected results. ✓

**Type/name consistency:** `mountTaleoForm(doc)` defined Task 1, used in both test describes; element ids (`taleo-firstname`…`taleo-veteran`) consistent between fixture and assertions; `runAutofill`/`stubLayout`/`scanPage`/`MOCK_PROFILE` match existing modules. ✓

**Empirical basis:** the in-document table fixture is the owning-frame view; table-cell label association is probe-confirmed; the iframe coordination path is intentionally covered by existing `crossFrame` unit tests + a live spot-check, not re-proven here.
