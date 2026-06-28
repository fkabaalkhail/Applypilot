# Feature A — Autofill Bug Fix + AI-Assisted Fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop autofill from scrolling the page, and fill the fields the local profile can't — screening questions inline, long-form essays via a review panel — using the backend `/api/fill` endpoint that already exists.

**Architecture:** Extension-only. The proven local-profile fill is untouched; a second phase runs after it inside the existing `overlayState.busy` guard: collect unfilled non-sensitive fields → classify → batch to `POST /api/fill` → simple answers fill inline through the reconciler, long-form answers become editable review cards in the overlay. The reconciler gains a non-disruptive `addTargets()` so the AI pass doesn't wipe drift-tracking of the local pass.

**Tech Stack:** TypeScript (strict), MV3 Chrome extension, esbuild bundler, Vitest + jsdom for tests. Backend is FastAPI (unchanged).

## Global Constraints

- Extension-only — **no backend changes**. The endpoint is `POST /api/fill` (mounted `prefix="/api"` in `backend/main.py:79`); the extension base URL is `https://www.tailrd.ca`, so the client path is exactly `"/api/fill"`.
- AI must **never** fill `sensitive` (EEO/demographic) fields — exclude them from candidates regardless of the `fillEEO` setting.
- Long-form answers are **drafted for review, never auto-inserted**. Simple screening answers fill inline.
- Reuse existing patterns: `authedRequest` (api/client), `sendToBackground`/`bg` messaging, the `AutofillReconciler`, `writeControl`/`verifyControl`.
- Chrome 110+ (`focus({preventScroll:true})` is supported).
- Verify every task with `npm run typecheck` (`tsc --noEmit`) and `npm test` (`vitest run`). New source files are bundled automatically — esbuild follows imports from `contentScript.ts` / `serviceWorker.ts`, so `build.mjs` needs no change.
- All commands run from `chrome-extension/`.

---

### Task 1: Fix the scroll-jump bug (`preventScroll`)

**Files:**
- Modify: `chrome-extension/src/content/writeEngine.ts:66,77,104`
- Test: `chrome-extension/test/writeEngine.test.ts`

**Interfaces:**
- Consumes: existing `writeControl(control, value)`.
- Produces: no signature change — `writeControl` now calls `el.focus({ preventScroll: true })` at all three call sites.

- [ ] **Step 1: Add the failing tests**

Append to `chrome-extension/test/writeEngine.test.ts`:

```typescript
describe("writeControl — never scrolls the page", () => {
  it("focuses text inputs with preventScroll", () => {
    const el = mount(`<input type="text" />`) as HTMLInputElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    writeControl(textControl(el), "Wissam");
    expect(opts).toEqual({ preventScroll: true });
  });

  it("focuses selects with preventScroll", () => {
    const el = mount(
      `<select><option value="">Pick…</option><option value="ca">Canada</option></select>`
    ) as HTMLSelectElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    writeControl({ id: "s-1", controlType: "select", el }, "Canada");
    expect(opts).toEqual({ preventScroll: true });
  });

  it("focuses contenteditable with preventScroll", () => {
    const el = mount(`<div contenteditable="true"></div>`) as HTMLElement;
    let opts: FocusOptions | undefined = "untouched" as unknown as FocusOptions;
    const orig = el.focus.bind(el);
    el.focus = (o?: FocusOptions) => {
      opts = o;
      orig(o);
    };
    writeControl({ id: "ce-1", controlType: "contenteditable", el }, "hello");
    expect(opts).toEqual({ preventScroll: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/writeEngine.test.ts -t "never scrolls"`
Expected: FAIL — `opts` is `undefined` (focus called with no args), not `{ preventScroll: true }`.

- [ ] **Step 3: Apply the fix**

In `chrome-extension/src/content/writeEngine.ts`, change the three `el.focus();` calls:

`writeTextLike` (line ~66):
```typescript
  if (isStale(el)) return { written: false, reason: STALE };
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
```

`writeSelect` (line ~77):
```typescript
  if (!match) return { written: false, reason: `No option matches "${truncate(value)}"` };
  el.focus({ preventScroll: true });
  setNativeValue(el, match.value);
```

`writeContentEditable` (line ~104):
```typescript
  if (isStale(el)) return { written: false, reason: STALE };
  el.focus({ preventScroll: true });
  const doc = el.ownerDocument;
```

- [ ] **Step 4: Run the full writeEngine suite to verify pass + no regressions**

Run: `npx vitest run test/writeEngine.test.ts`
Expected: PASS (all existing event-order/value tests still pass; the 3 new ones pass).

- [ ] **Step 5: Commit**

```bash
git add src/content/writeEngine.ts test/writeEngine.test.ts
git commit -m "fix(extension): autofill no longer scrolls the page (focus preventScroll)"
```

---

### Task 2: Shared message + data types for AI fill

**Files:**
- Modify: `chrome-extension/src/shared/types.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–8):
  - `AiFillField { id: string; label: string; type: "text"|"textarea"|"select"|"radio"|"checkbox"; options: string[]; required: boolean }`
  - `JobContext { jobDescription: string; jobTitle: string; company: string }`
  - `AiFillAnswer { id: string; label: string; answer: string; confidence: string }`
  - `AiFillResponse { ok: boolean; error?: string; needsLogin?: boolean; answers: AiFillAnswer[]; errors: string[] }`
  - `AiDraft { fieldId: string; label: string; value: string }`
  - `BackgroundRequest` gains `| { type: "AI_FILL"; fields: AiFillField[]; jobContext: JobContext }`

- [ ] **Step 1: Add the new interfaces**

In `chrome-extension/src/shared/types.ts`, after the `DetectedField` interface (ends ~line 202), add:

```typescript
// ---------------------------------------------------------------------------
// AI-assisted fill (backend POST /api/fill)
// ---------------------------------------------------------------------------

/** A field handed to the backend AI fill endpoint (mirrors backend FormField). */
export interface AiFillField {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "radio" | "checkbox";
  options: string[];
  required: boolean;
}

/** Scraped page context that improves AI answers. Empty strings are fine. */
export interface JobContext {
  jobDescription: string;
  jobTitle: string;
  company: string;
}

/** One AI answer from the backend (mirrors backend FieldAnswer). */
export interface AiFillAnswer {
  id: string;
  label: string;
  answer: string;
  confidence: string;
}

/** Background-worker reply for an AI_FILL request. */
export interface AiFillResponse {
  ok: boolean;
  error?: string;
  needsLogin?: boolean;
  answers: AiFillAnswer[];
  errors: string[];
}

/** A long-form AI answer awaiting user review before insertion. */
export interface AiDraft {
  fieldId: string;
  label: string;
  value: string;
}
```

- [ ] **Step 2: Extend `BackgroundRequest`**

In the `BackgroundRequest` union (~line 259), add the `AI_FILL` variant:

```typescript
export type BackgroundRequest =
  | { type: "GET_STATUS" }
  | { type: "CONNECT" }
  | { type: "LOGOUT" }
  | { type: "GET_PROFILE"; forceRefresh?: boolean }
  | { type: "GET_RESUMES" }
  | { type: "GET_SYNC"; forceRefresh?: boolean }
  | { type: "DOWNLOAD_RESUME"; resumeId: number }
  | { type: "OPEN_DASHBOARD" }
  | { type: "AI_FILL"; fields: AiFillField[]; jobContext: JobContext };
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no errors; the new `AI_FILL` variant is not yet handled — that is Task 6, which is fine because `handle()`'s switch is not exhaustively checked against the union return until then).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(extension): add AI-fill message + data types"
```

---

### Task 3: Job context scraper (`content/jobContext.ts`)

**Files:**
- Create: `chrome-extension/src/content/jobContext.ts`
- Test: `chrome-extension/test/jobContext.test.ts`

**Interfaces:**
- Consumes: `JobContext` (Task 2).
- Produces: `extractJobContext(doc?: Document): JobContext`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/jobContext.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { extractJobContext } from "../src/content/jobContext";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
});

describe("extractJobContext", () => {
  it("reads description, title, and company from common containers", () => {
    document.title = "Careers";
    document.head.innerHTML = `<meta property="og:site_name" content="Acme Corp" />`;
    document.body.innerHTML = `
      <h1>Senior Engineer</h1>
      <div class="job-description">${"We are hiring a senior engineer to build great things. ".repeat(10)}</div>
    `;
    const ctx = extractJobContext(document);
    expect(ctx.jobTitle).toBe("Senior Engineer");
    expect(ctx.company).toBe("Acme Corp");
    expect(ctx.jobDescription).toContain("senior engineer");
  });

  it("falls back to the largest text block when no description container exists", () => {
    document.body.innerHTML = `
      <nav>Home About</nav>
      <section>${"This role owns the billing platform end to end. ".repeat(12)}</section>
      <footer>© 2026</footer>
    `;
    const ctx = extractJobContext(document);
    expect(ctx.jobDescription).toContain("billing platform");
    expect(ctx.jobDescription).not.toContain("© 2026");
  });

  it("never throws and returns empty strings on a bare document", () => {
    const ctx = extractJobContext(document);
    expect(ctx).toEqual({ jobDescription: "", jobTitle: "", company: "" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/jobContext.test.ts`
Expected: FAIL — `Cannot find module '../src/content/jobContext'`.

- [ ] **Step 3: Implement `jobContext.ts`**

Create `chrome-extension/src/content/jobContext.ts`:

```typescript
/**
 * Scrapes a job posting's description, title and company from the page so AI
 * answers (POST /api/fill) and the cover-letter generator (Feature B) have
 * context. Best-effort and failure-tolerant: returns empty strings rather than
 * throwing, because AI fill still works (lower quality) without context.
 */
import type { JobContext } from "../shared/types";

const MAX_DESC = 6000;
const MIN_DESC = 200;

const DESC_SELECTORS = [
  '[class*="job-description" i]',
  '[class*="jobdescription" i]',
  '[data-testid*="description" i]',
  '[id*="job-description" i]',
  '[class*="description" i]',
  "article",
  '[role="main"]',
  "main",
];

const SKIP_BLOCK = new Set(["NAV", "FOOTER", "HEADER", "SCRIPT", "STYLE", "NOSCRIPT"]);

function visibleText(el: Element | null): string {
  if (!el) return "";
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function extractDescription(doc: Document): string {
  for (const sel of DESC_SELECTORS) {
    const el = doc.querySelector(sel);
    const text = visibleText(el);
    if (text.length >= MIN_DESC) return text.slice(0, MAX_DESC);
  }
  // Fallback: the largest text block, ignoring chrome/navigation containers.
  let best = "";
  for (const el of Array.from(doc.querySelectorAll("section, article, div, p"))) {
    if (el.closest("nav, footer, header")) continue;
    if (SKIP_BLOCK.has(el.tagName)) continue;
    const text = visibleText(el);
    if (text.length > best.length) best = text;
  }
  return best.length >= MIN_DESC ? best.slice(0, MAX_DESC) : "";
}

function extractTitle(doc: Document): string {
  const h1 = visibleText(doc.querySelector("h1"));
  if (h1) return h1.slice(0, 200);
  const titled = visibleText(doc.querySelector('[class*="title" i]'));
  if (titled) return titled.slice(0, 200);
  return (doc.title || "").trim().slice(0, 200);
}

function extractCompany(doc: Document): string {
  const og = doc
    .querySelector('meta[property="og:site_name"]')
    ?.getAttribute("content");
  if (og && og.trim()) return og.trim().slice(0, 120);
  const named = visibleText(doc.querySelector('[class*="company" i]'));
  if (named) return named.slice(0, 120);
  return "";
}

export function extractJobContext(doc: Document = document): JobContext {
  try {
    return {
      jobDescription: extractDescription(doc),
      jobTitle: extractTitle(doc),
      company: extractCompany(doc),
    };
  } catch {
    return { jobDescription: "", jobTitle: "", company: "" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/jobContext.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/jobContext.ts test/jobContext.test.ts
git commit -m "feat(extension): add job-context scraper for AI fill"
```

---

### Task 4: AI-fill planner (`content/aiFillPlanner.ts`)

**Files:**
- Create: `chrome-extension/src/content/aiFillPlanner.ts`
- Test: `chrome-extension/test/aiFillPlanner.test.ts`

**Interfaces:**
- Consumes: `DetectedField`, `AiFillField`, `AiDraft` (Tasks 2 / existing).
- Produces:
  - `isLongform(field: DetectedField): boolean`
  - `isAiCandidate(field: DetectedField): boolean`
  - `aiFillCandidates(fields: DetectedField[]): DetectedField[]`
  - `toAiFillField(field: DetectedField): AiFillField`
  - `planAiFill(candidates: DetectedField[], answers: { id: string; answer: string }[]): { simpleTargets: { fieldId: string; value: string }[]; drafts: AiDraft[] }`
  - `tallyOutcomes(...groups: { fieldId: string; ok: boolean }[][]): { ok: number; fail: number; total: number }`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/aiFillPlanner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isLongform,
  isAiCandidate,
  aiFillCandidates,
  toAiFillField,
  planAiFill,
  tallyOutcomes,
} from "../src/content/aiFillPlanner";
import type { DetectedField } from "../src/shared/types";

function field(over: Partial<DetectedField>): DetectedField {
  return {
    id: "f1",
    category: "unknown",
    confidence: 0.2,
    label: "Question",
    controlType: "text",
    required: false,
    proposedValue: null,
    fillable: true,
    sensitive: false,
    ...over,
  };
}

describe("isLongform", () => {
  it("is true for textareas and contenteditable", () => {
    expect(isLongform(field({ controlType: "textarea" }))).toBe(true);
    expect(isLongform(field({ controlType: "contenteditable" }))).toBe(true);
  });
  it("is true for question-like labels on text inputs", () => {
    expect(isLongform(field({ label: "Why do you want to work here?" }))).toBe(true);
  });
  it("is false for a short plain text field", () => {
    expect(isLongform(field({ label: "Middle name" }))).toBe(false);
  });
});

describe("isAiCandidate", () => {
  it("excludes sensitive (EEO) fields", () => {
    expect(isAiCandidate(field({ controlType: "select", sensitive: true, options: ["Male", "Female"] }))).toBe(false);
  });
  it("excludes file and custom dropdowns", () => {
    expect(isAiCandidate(field({ controlType: "file", fillable: false }))).toBe(false);
    expect(isAiCandidate(field({ controlType: "customDropdown", fillable: false }))).toBe(false);
  });
  it("includes option-based screening fields", () => {
    expect(isAiCandidate(field({ controlType: "radioGroup", options: ["Yes", "No"] }))).toBe(true);
    expect(isAiCandidate(field({ controlType: "select", options: ["A", "B"] }))).toBe(true);
  });
  it("includes long-form free text", () => {
    expect(isAiCandidate(field({ controlType: "textarea" }))).toBe(true);
  });
  it("includes question-like text but excludes plain text", () => {
    expect(isAiCandidate(field({ controlType: "text", label: "Years of experience with React?" }))).toBe(true);
    expect(isAiCandidate(field({ controlType: "text", label: "Address line 2" }))).toBe(false);
  });
});

describe("aiFillCandidates", () => {
  it("keeps only empty, unanswered, AI-eligible fields", () => {
    const fields = [
      field({ id: "a", controlType: "textarea" }), // candidate
      field({ id: "b", controlType: "textarea", proposedValue: "x" }), // profile answered → skip
      field({ id: "c", controlType: "textarea", currentValue: "typed" }), // user typed → skip
      field({ id: "d", controlType: "select", sensitive: true, options: ["M", "F"] }), // EEO → skip
    ];
    expect(aiFillCandidates(fields).map((f) => f.id)).toEqual(["a"]);
  });
});

describe("toAiFillField", () => {
  it("maps control types to the backend field types", () => {
    expect(toAiFillField(field({ controlType: "radioGroup", options: ["Yes", "No"] })).type).toBe("radio");
    expect(toAiFillField(field({ controlType: "contenteditable" })).type).toBe("textarea");
    expect(toAiFillField(field({ controlType: "select", options: ["A"] })).type).toBe("select");
    expect(toAiFillField(field({ controlType: "checkbox" })).type).toBe("checkbox");
    expect(toAiFillField(field({ controlType: "text" })).type).toBe("text");
    expect(toAiFillField(field({ id: "z", options: undefined })).options).toEqual([]);
  });
});

describe("planAiFill", () => {
  it("routes long-form to drafts and simple to inline targets", () => {
    const candidates = [
      field({ id: "essay", controlType: "textarea", label: "Why us?" }),
      field({ id: "auth", controlType: "radioGroup", label: "Authorized to work?", options: ["Yes", "No"] }),
      field({ id: "blank", controlType: "text", label: "Years?" }),
    ];
    const answers = [
      { id: "essay", answer: "Because I love it." },
      { id: "auth", answer: "Yes" },
      { id: "blank", answer: "" }, // empty → ignored
    ];
    const plan = planAiFill(candidates, answers);
    expect(plan.drafts).toEqual([{ fieldId: "essay", label: "Why us?", value: "Because I love it." }]);
    expect(plan.simpleTargets).toEqual([{ fieldId: "auth", value: "Yes" }]);
  });
});

describe("tallyOutcomes", () => {
  it("dedupes by fieldId with later groups winning", () => {
    const local = [{ fieldId: "a", ok: true }, { fieldId: "b", ok: false }];
    const ai = [{ fieldId: "b", ok: true }, { fieldId: "c", ok: true }];
    expect(tallyOutcomes(local, ai)).toEqual({ ok: 3, fail: 0, total: 3 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/aiFillPlanner.test.ts`
Expected: FAIL — `Cannot find module '../src/content/aiFillPlanner'`.

- [ ] **Step 3: Implement `aiFillPlanner.ts`**

Create `chrome-extension/src/content/aiFillPlanner.ts`:

```typescript
/**
 * Decides what the AI fill pass does with each field: which fields are eligible,
 * which are long-form (drafted for review) vs simple (filled inline), how to map
 * them to the backend's field shape, and how to tally outcomes across passes.
 *
 * Pure functions only — no DOM, no network — so the orchestration in
 * contentScript stays thin and this logic is fully unit-tested.
 */
import type { AiDraft, AiFillField, DetectedField } from "../shared/types";

/** Labels that signal a free-text answer we should draft rather than guess inline. */
const LONGFORM_LABEL =
  /\b(why|describe|tell us|tell me|explain|cover letter|in your own words|what makes you|motivat)\b/i;

/** Labels that read like a question worth answering even on a plain text input. */
const QUESTION_LABEL =
  /\?|\b(why|describe|tell us|explain|how many|years of|experience with|are you|do you|have you|salary|expected|notice period|available|authorized|sponsor|willing)\b/i;

export function isLongform(field: DetectedField): boolean {
  if (field.controlType === "textarea" || field.controlType === "contenteditable") return true;
  return LONGFORM_LABEL.test(field.label);
}

/** Whether a field is eligible for AI fill at all (independent of its current value). */
export function isAiCandidate(field: DetectedField): boolean {
  if (!field.fillable || field.sensitive) return false;
  if (field.controlType === "file" || field.controlType === "customDropdown") return false;
  if (field.controlType === "textarea" || field.controlType === "contenteditable") return true;
  if (
    field.controlType === "select" ||
    field.controlType === "radioGroup" ||
    field.controlType === "checkbox"
  ) {
    return true;
  }
  // Plain text: only answer when the label reads like a question.
  return QUESTION_LABEL.test(field.label);
}

/** Eligible fields that are still empty (no profile value, nothing the user typed). */
export function aiFillCandidates(fields: DetectedField[]): DetectedField[] {
  return fields.filter(
    (f) => isAiCandidate(f) && f.proposedValue === null && !f.currentValue
  );
}

function mapType(controlType: DetectedField["controlType"]): AiFillField["type"] {
  switch (controlType) {
    case "textarea":
    case "contenteditable":
      return "textarea";
    case "select":
      return "select";
    case "radioGroup":
      return "radio";
    case "checkbox":
      return "checkbox";
    default:
      return "text";
  }
}

export function toAiFillField(field: DetectedField): AiFillField {
  return {
    id: field.id,
    label: field.label,
    type: mapType(field.controlType),
    options: field.options ?? [],
    required: field.required,
  };
}

export interface AiFillPlan {
  simpleTargets: { fieldId: string; value: string }[];
  drafts: AiDraft[];
}

/** Split backend answers into inline (simple) fills and long-form review drafts. */
export function planAiFill(
  candidates: DetectedField[],
  answers: { id: string; answer: string }[]
): AiFillPlan {
  const byId = new Map(answers.map((a) => [a.id, a.answer]));
  const simpleTargets: { fieldId: string; value: string }[] = [];
  const drafts: AiDraft[] = [];
  for (const f of candidates) {
    const answer = byId.get(f.id);
    if (!answer || !answer.trim()) continue;
    if (isLongform(f)) drafts.push({ fieldId: f.id, label: f.label, value: answer });
    else simpleTargets.push({ fieldId: f.id, value: answer });
  }
  return { simpleTargets, drafts };
}

/** Count distinct filled fields across passes; later groups win for the same id. */
export function tallyOutcomes(
  ...groups: { fieldId: string; ok: boolean }[][]
): { ok: number; fail: number; total: number } {
  const status = new Map<string, boolean>();
  for (const group of groups) for (const o of group) status.set(o.fieldId, o.ok);
  const ok = [...status.values()].filter(Boolean).length;
  return { ok, fail: status.size - ok, total: status.size };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/aiFillPlanner.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/content/aiFillPlanner.ts test/aiFillPlanner.test.ts
git commit -m "feat(extension): add AI-fill planner (classification + routing + tally)"
```

---

### Task 5: Non-disruptive `addTargets()` on the reconciler

**Files:**
- Modify: `chrome-extension/src/content/reconciler.ts`
- Test: `chrome-extension/test/reconciler.test.ts`

**Interfaces:**
- Consumes: existing `ReconcileTarget`, `FieldReport`, `RuntimeControl`, private `active()/fillOnce()/confirmStability()/allSettled()/window()/reports()/startObserver()`.
- Produces: `addTargets(targets: ReconcileTarget[], registry: Map<string, RuntimeControl>): Promise<FieldReport[]>` — merges new targets into existing `states` (preserving already-tracked fields) and returns reports for the new targets only.

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/reconciler.test.ts`:

```typescript
describe("addTargets — merges without resetting existing tracking", () => {
  it("fills new targets and keeps prior fields in the engine state", async () => {
    document.body.innerHTML = `<input id="a" /><input id="b" />`;
    const a = document.getElementById("a") as HTMLInputElement;
    const b = document.getElementById("b") as HTMLInputElement;
    const registry = new Map<string, RuntimeControl>([
      ["a", { id: "a", controlType: "text", el: a }],
      ["b", { id: "b", controlType: "text", el: b }],
    ]);
    const engine = new AutofillReconciler({ sleep: async () => {}, settleWindowMs: 0, observe: false });

    const first = await engine.run([{ fieldId: "a", value: "alpha" }], registry);
    expect(first.find((r) => r.fieldId === "a")?.ok).toBe(true);

    const second = await engine.addTargets([{ fieldId: "b", value: "beta" }], registry);

    // Only the new target is reported back…
    expect(second.map((r) => r.fieldId)).toEqual(["b"]);
    expect(second[0].ok).toBe(true);
    expect(b.value).toBe("beta");
    // …and the original field is still filled (not wiped).
    expect(a.value).toBe("alpha");
  });
});
```

Confirm the file's imports include `AutofillReconciler` and `RuntimeControl`. If `reconciler.test.ts` does not exist, create it with this header before the `describe`:

```typescript
import { describe, it, expect } from "vitest";
import { AutofillReconciler } from "../src/content/reconciler";
import type { RuntimeControl } from "../src/content/formScanner";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/reconciler.test.ts -t "addTargets"`
Expected: FAIL — `engine.addTargets is not a function`.

- [ ] **Step 3: Implement `addTargets`**

In `chrome-extension/src/content/reconciler.ts`, add this method right after `run()` (before `updateRegistry`):

```typescript
  /**
   * Add more targets and reconcile them WITHOUT discarding fields already being
   * tracked. Unlike run(), this merges into the existing `states` map, so a
   * second fill pass (e.g. AI answers after the local profile pass) does not
   * wipe drift-tracking of the first pass. Returns reports for the new targets.
   */
  async addTargets(
    targets: ReconcileTarget[],
    registry: Map<string, RuntimeControl>
  ): Promise<FieldReport[]> {
    this.registry = registry;
    const newIds = new Set(targets.map((t) => t.fieldId));
    for (const t of targets) {
      this.states.set(t.fieldId, {
        fieldId: t.fieldId,
        value: t.value,
        status: "mapped",
        attempts: 0,
        terminal: false,
      });
    }
    try {
      for (let cycle = 0; cycle < this.maxCycles; cycle++) {
        for (const s of this.active()) this.fillOnce(s);
        await this.sleep(this.window());
        this.confirmStability();
        if (this.allSettled()) break;
      }
      return this.reports().filter((r) => newIds.has(r.fieldId));
    } finally {
      if (this.observe) this.startObserver();
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/reconciler.test.ts`
Expected: PASS (the new addTargets test plus any existing reconciler tests).

- [ ] **Step 5: Commit**

```bash
git add src/content/reconciler.ts test/reconciler.test.ts
git commit -m "feat(extension): add reconciler.addTargets for non-disruptive second-pass fills"
```

---

### Task 6: API client (`api/aiFill.ts`) + service-worker `AI_FILL` case

**Files:**
- Create: `chrome-extension/src/api/aiFill.ts`
- Test: `chrome-extension/test/aiFill.test.ts`
- Modify: `chrome-extension/src/background/serviceWorker.ts`

**Interfaces:**
- Consumes: `AiFillField`, `JobContext`, `AiFillAnswer` (Task 2); `authedRequest` (api/client); `AuthRequiredError` (api/client).
- Produces:
  - `buildFillRequestBody(fields: AiFillField[], jobContext: JobContext): { fields: AiFillField[]; resumeText: string; jobDescription: string; jobTitle: string; company: string }`
  - `aiFillFields(fields: AiFillField[], jobContext: JobContext): Promise<{ answers: AiFillAnswer[]; errors: string[] }>`
  - `serviceWorker.handle()` now resolves `AI_FILL` → `AiFillResponse`.

- [ ] **Step 1: Write the failing test for the request builder**

Create `chrome-extension/test/aiFill.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildFillRequestBody } from "../src/api/aiFill";
import type { AiFillField, JobContext } from "../src/shared/types";

const fields: AiFillField[] = [
  { id: "q1", label: "Why us?", type: "textarea", options: [], required: true },
];
const ctx: JobContext = {
  jobDescription: "Build things",
  jobTitle: "Engineer",
  company: "Acme",
};

describe("buildFillRequestBody", () => {
  it("maps fields + context to the backend payload with empty resumeText", () => {
    expect(buildFillRequestBody(fields, ctx)).toEqual({
      fields,
      resumeText: "",
      jobDescription: "Build things",
      jobTitle: "Engineer",
      company: "Acme",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/aiFill.test.ts`
Expected: FAIL — `Cannot find module '../src/api/aiFill'`.

- [ ] **Step 3: Implement `api/aiFill.ts`**

Create `chrome-extension/src/api/aiFill.ts`:

```typescript
/**
 * Calls the backend AI form-fill endpoint (POST /api/fill). The endpoint does
 * rule-based answers first, then Claude for the rest, and pulls the user's
 * resume from the DB — so we send an empty resumeText. Runs in the service
 * worker, where authedRequest handles auth + silent token refresh.
 */
import type { AiFillAnswer, AiFillField, JobContext } from "../shared/types";
import { authedRequest } from "./client";

interface FillApiResponse {
  answers: AiFillAnswer[];
  errors: string[];
}

export function buildFillRequestBody(
  fields: AiFillField[],
  jobContext: JobContext
): {
  fields: AiFillField[];
  resumeText: string;
  jobDescription: string;
  jobTitle: string;
  company: string;
} {
  return {
    fields,
    resumeText: "",
    jobDescription: jobContext.jobDescription,
    jobTitle: jobContext.jobTitle,
    company: jobContext.company,
  };
}

export async function aiFillFields(
  fields: AiFillField[],
  jobContext: JobContext
): Promise<FillApiResponse> {
  return authedRequest<FillApiResponse>("/api/fill", {
    method: "POST",
    body: JSON.stringify(buildFillRequestBody(fields, jobContext)),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/aiFill.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the `AI_FILL` case into the service worker**

In `chrome-extension/src/background/serviceWorker.ts`:

(a) Add the import alongside the other api imports (~line 14):

```typescript
import { downloadResumeFile, getSnapshotForUi, syncIfStale } from "../api/sync";
import { aiFillFields } from "../api/aiFill";
```

(b) Add `AiFillResponse` to the type imports (~line 16-26):

```typescript
import type {
  AiFillResponse,
  BackgroundRequest,
  FieldsUpdatedEvent,
  LoginResponse,
  ProfileResponse,
  ResumeFileResponse,
  ResumesResponse,
  SimpleResponse,
  StatusResponse,
  SyncResponse,
} from "../shared/types";
```

(c) Add `AiFillResponse` to the `handle()` return union (~line 133-143):

```typescript
export async function handle(
  message: BackgroundRequest
): Promise<
  | StatusResponse
  | ProfileResponse
  | LoginResponse
  | SimpleResponse
  | ResumesResponse
  | ResumeFileResponse
  | SyncResponse
  | AiFillResponse
> {
```

(d) Add the case inside the `switch` (e.g. after `DOWNLOAD_RESUME`, before `OPEN_DASHBOARD`):

```typescript
    case "AI_FILL": {
      try {
        const { answers, errors } = await aiFillFields(message.fields, message.jobContext);
        return { ok: true, answers, errors };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, answers: [], errors: [err.message] };
        }
        return {
          ok: false,
          answers: [],
          errors: [err instanceof Error ? err.message : "AI fill failed"],
        };
      }
    }
```

`AuthRequiredError` is already imported at the top of the file.

- [ ] **Step 6: Verify types compile and tests still pass**

Run: `npm run typecheck && npm test`
Expected: PASS — `handle()` now covers `AI_FILL`, and all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/aiFill.ts test/aiFill.test.ts src/background/serviceWorker.ts
git commit -m "feat(extension): AI_FILL service-worker route to POST /api/fill"
```

---

### Task 7: Two-phase orchestration in the content script

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts`

**Interfaces:**
- Consumes: `aiFillCandidates`, `toAiFillField`, `planAiFill`, `tallyOutcomes` (Task 4); `extractJobContext` (Task 3); `writeControl`, `verifyControl` (writeEngine); `AutofillReconciler.addTargets` (Task 5); `AiDraft`, `AiFillResponse` (Task 2); `OverlayCallbacks` (Task 8 extends it — this task provides the new `onInsertAnswer` member and the extended `onAutofill` return).
- Produces: `overlayCallbacks.onAutofill` now returns `{ ok, fail, total, drafts }`; new `overlayCallbacks.onInsertAnswer(fieldId, value)`.

- [ ] **Step 1: Add imports**

In `chrome-extension/src/content/contentScript.ts`, extend the imports:

```typescript
import { deepQueryAll } from "./domUtils";
import { base64ToFile, injectResumeFile } from "./fileUpload";
import { FRAME_TOKEN, observePage, scanPage, type RuntimeControl } from "./formScanner";
import { AutofillReconciler, type FieldReport } from "./reconciler";
import { defaultSelectedIds } from "../shared/selection";
import { extractJobContext } from "./jobContext";
import { aiFillCandidates, planAiFill, tallyOutcomes, toAiFillField } from "./aiFillPlanner";
import { verifyControl, writeControl } from "./writeEngine";
```

Add `AiDraft` and `AiFillResponse` to the existing `import type { … } from "../shared/types";` block.

- [ ] **Step 2: Replace `onAutofill` with the two-phase version and add `onInsertAnswer`**

Replace the current `onAutofill` member of `overlayCallbacks` (lines ~157-165) with:

```typescript
    onAutofill: async (ids: string[]) => {
      // Phase 1 — local profile fill (unchanged behavior).
      const wanted = new Set(ids);
      const targets = lastFields
        .filter((f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null)
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const localReports = await getEngine().run(targets, registry);

      // Phase 2 — AI fill for fields the profile couldn't answer (best-effort).
      const candidates = aiFillCandidates(lastFields);
      const drafts: AiDraft[] = [];
      let aiReports: FieldReport[] = [];
      if (candidates.length > 0) {
        try {
          const resp = await sendToBackground<AiFillResponse>({
            type: "AI_FILL",
            fields: candidates.map(toAiFillField),
            jobContext: extractJobContext(),
          });
          if (resp?.ok) {
            const plan = planAiFill(candidates, resp.answers);
            drafts.push(...plan.drafts);
            if (plan.simpleTargets.length > 0) {
              aiReports = await getEngine().addTargets(plan.simpleTargets, registry);
            }
          }
        } catch {
          // AI fill is additive — the local pass already happened. Swallow.
        }
      }

      const { ok, fail, total } = tallyOutcomes(localReports, aiReports);
      return { ok, fail, total, drafts };
    },
    onInsertAnswer: async (fieldId: string, value: string) => {
      const control = registry.get(fieldId);
      if (!control) return { ok: false, reason: "Field is no longer on the page — rescan." };
      const res = writeControl(control, value);
      if (!res.written) return { ok: false, reason: res.reason };
      return verifyControl(control, value)
        ? { ok: true }
        : { ok: false, reason: "Value did not stick — please check the field." };
    },
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: FAIL — `onInsertAnswer` is not yet on `OverlayCallbacks` and `onAutofill`'s return type no longer matches. This is expected; Task 8 updates `OverlayCallbacks`. (If you are doing Tasks 7 and 8 as one reviewable unit, run typecheck after Task 8 instead.)

- [ ] **Step 4: Commit**

```bash
git add src/content/contentScript.ts
git commit -m "feat(extension): two-phase autofill (local + AI) and onInsertAnswer"
```

---

### Task 8: Overlay long-form review UX

**Files:**
- Modify: `chrome-extension/src/content/overlay.ts`

**Interfaces:**
- Consumes: `AiDraft` (Task 2); `onAutofill` extended return + `onInsertAnswer` (Task 7); existing `esc`, `showBanner`, `refs`, `overlayState`.
- Produces: `OverlayCallbacks.onAutofill` returns `{ ok; fail; total; drafts: AiDraft[] }`; `OverlayCallbacks.onInsertAnswer(fieldId, value): Promise<{ ok: boolean; reason?: string }>`; a rendered review section.

- [ ] **Step 1: Extend the `OverlayCallbacks` interface**

In `chrome-extension/src/content/overlay.ts` (~lines 34-49), update the two members:

```typescript
export interface OverlayCallbacks {
  onAutofill: (
    fieldIds: string[]
  ) => Promise<{ ok: number; fail: number; total: number; drafts: AiDraft[] }>;
  onInsertAnswer: (fieldId: string, value: string) => Promise<{ ok: boolean; reason?: string }>;
  onRescan: () => void;
  onListResumes: () => Promise<ResumeSummary[]>;
  onUploadResume: (resumeId: number) => Promise<{ ok: boolean; reason?: string }>;
  onProfileResolved: (profile: UserApplicationProfile | null) => void;
}
```

Add `AiDraft` to the `import type { … } from "../shared/types";` block at the top of the file.

- [ ] **Step 2: Add the review container to `buildHTML`**

In `buildHTML()`, immediately after the banner div (line ~636: `<div class="ap-banner" id="ap-banner" style="display:none"></div>`), add:

```html
        <!-- AI long-form answers to review -->
        <div class="ap-review" id="ap-review" style="display:none"></div>
```

- [ ] **Step 3: Add the `review` ref**

In the `Refs` interface (~line 543, near `banner`), add:

```typescript
  banner: HTMLDivElement;
  review: HTMLDivElement;
```

In `collectRefs` (~line 749, near `banner: q("#ap-banner"),`), add:

```typescript
    banner: q("#ap-banner"),
    review: q("#ap-review"),
```

- [ ] **Step 4: Add the CSS**

Append to the `STYLES` template literal (the backtick string starting at line ~124, before its closing backtick):

```css
.ap-review { margin: 0 16px 12px; }
.ap-review-head { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; font-weight: 600; color: #444; margin-bottom: 8px; }
.ap-review-all { font-size: 12px; color: #7c6cff; background: none; border: none; cursor: pointer; padding: 2px 4px; }
.ap-review-card { border: 1px solid #eee; border-radius: 10px; padding: 10px; margin-bottom: 8px; background: #fafafa; }
.ap-review-label { font-size: 12.5px; color: #333; margin-bottom: 6px; font-weight: 500; }
.ap-review-text { width: 100%; box-sizing: border-box; font-size: 12.5px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; resize: vertical; font-family: inherit; }
.ap-review-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.ap-review-insert, .ap-review-skip { font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; border: 1px solid #ddd; background: #fff; }
.ap-review-insert { background: #7c6cff; color: #fff; border-color: #7c6cff; }
.ap-review-status { font-size: 12px; color: #888; }
.ap-review-status.ok { color: #1a7f37; }
.ap-review-status.error { color: #c0392b; }
```

- [ ] **Step 5: Render the review section after a fill**

In `doAutofill()` (~lines 1112-1118), replace the result handling so it reads `drafts` and renders them:

```typescript
  try {
    const { ok, fail, total, drafts } = await callbacks.onAutofill(ids);
    const txt =
      `Filled ${ok} of ${total} field${total === 1 ? "" : "s"}` +
      (fail > 0 ? ` (${fail} need attention)` : "") +
      (drafts.length > 0 ? ` · ${drafts.length} to review below` : "") +
      ". Review before submitting.";
    showBanner(txt, fail > 0 ? "warn" : "ok");
    renderReviewSection(drafts);
  } catch (err) {
```

- [ ] **Step 6: Add the render + insert helpers**

Add these functions just after `doAutofill()` / before `showBanner` (~line 1126):

```typescript
function renderReviewSection(drafts: AiDraft[]): void {
  if (!refs) return;
  const host = refs.review;
  if (drafts.length === 0) {
    host.style.display = "none";
    host.innerHTML = "";
    return;
  }
  host.style.display = "block";
  host.innerHTML =
    `<div class="ap-review-head"><span>AI answers to review</span>` +
    `<button class="ap-review-all" id="ap-review-all" type="button">Insert all</button></div>` +
    drafts
      .map(
        (d, i) => `
      <div class="ap-review-card" data-field="${esc(d.fieldId)}">
        <div class="ap-review-label">${esc(d.label)}</div>
        <textarea class="ap-review-text" id="ap-review-text-${i}" rows="4">${esc(d.value)}</textarea>
        <div class="ap-review-actions">
          <button class="ap-review-insert" data-i="${i}" type="button">Insert</button>
          <button class="ap-review-skip" data-i="${i}" type="button">Skip</button>
          <span class="ap-review-status" id="ap-review-status-${i}"></span>
        </div>
      </div>`
      )
      .join("");

  host.querySelectorAll<HTMLButtonElement>(".ap-review-insert").forEach((btn) => {
    btn.addEventListener("click", () => void insertDraft(Number(btn.dataset.i), drafts));
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-review-skip").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest(".ap-review-card")?.remove());
  });
  host.querySelector("#ap-review-all")?.addEventListener("click", () => void insertAllDrafts(drafts));
}

async function insertDraft(i: number, drafts: AiDraft[]): Promise<void> {
  if (!refs || !callbacks) return;
  const ta = refs.review.querySelector<HTMLTextAreaElement>(`#ap-review-text-${i}`);
  const statusEl = refs.review.querySelector<HTMLSpanElement>(`#ap-review-status-${i}`);
  const insertBtn = refs.review.querySelector<HTMLButtonElement>(`.ap-review-insert[data-i="${i}"]`);
  if (!ta) return;
  const res = await callbacks.onInsertAnswer(drafts[i].fieldId, ta.value);
  if (statusEl) {
    statusEl.textContent = res.ok ? "Inserted ✓" : res.reason ?? "Could not insert";
    statusEl.className = "ap-review-status" + (res.ok ? " ok" : " error");
  }
  if (res.ok && insertBtn) insertBtn.textContent = "Re-insert";
}

async function insertAllDrafts(drafts: AiDraft[]): Promise<void> {
  for (let i = 0; i < drafts.length; i++) {
    if (refs?.review.querySelector(`#ap-review-text-${i}`)) {
      await insertDraft(i, drafts);
    }
  }
}
```

- [ ] **Step 7: Verify the whole extension compiles and all tests pass**

Run: `npm run typecheck && npm test`
Expected: PASS — `OverlayCallbacks` now matches the contentScript implementation from Task 7; all unit tests green.

- [ ] **Step 8: Build to confirm esbuild bundles the new modules**

Run: `npm run build`
Expected: build succeeds with no missing-import errors (jobContext, aiFillPlanner, api/aiFill are pulled in via imports).

- [ ] **Step 9: Commit**

```bash
git add src/content/overlay.ts
git commit -m "feat(extension): long-form AI answer review panel in the overlay"
```

---

### Task 9: Manual end-to-end verification

**Files:** none (verification only).

This confirms the integration the unit tests can't (real DOM, real backend, real scroll behavior). Use a signed-in extension build.

- [ ] **Step 1: Load the unpacked build**

Run: `npm run build`, then in Chrome → Extensions → Developer mode → Load unpacked → select `chrome-extension/dist` (or the configured output dir). Confirm you are connected to a Tailrd account (not sample data).

- [ ] **Step 2: Scroll-jump fix**

Open a long Greenhouse or Workday application form, scroll to the middle, click **Autofill**. Expected: fields fill **without the viewport jumping/scrolling** to each field.

- [ ] **Step 3: Inline AI screening answers**

On a form with screening questions the profile can't answer (e.g. "Are you authorized to work?", a yes/no the profile lacks), click Autofill. Expected: those simple fields get filled inline; banner shows the filled count.

- [ ] **Step 4: Long-form review**

On a form with a "Why do you want to work here?" textarea, click Autofill. Expected: the banner notes "N to review below"; a review card appears with an editable draft; **Insert** writes it into the textarea (no scroll), the status shows "Inserted ✓" and the button becomes "Re-insert"; **Skip** removes the card; **Insert all** inserts every remaining card.

- [ ] **Step 5: EEO safety**

On a form with EEO/demographic questions (gender, race, veteran, disability), with the EEO opt-in **off**, click Autofill. Expected: those fields are **left untouched** and never appear as AI drafts.

- [ ] **Step 6: Offline / disconnected**

Disconnect the account (or go offline) and click Autofill. Expected: local fill still works from cache; no uncaught errors; AI phase is skipped gracefully (banner may note AI was unavailable).

- [ ] **Step 7: Commit any doc/notes updates (if needed)**

```bash
git add -A
git commit -m "docs: Feature A manual verification notes" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage** (against `2026-06-28-extension-ai-features-design.md` §2):
- 2.4 bug fix → Task 1. ✓
- 2.5 two-phase architecture → Tasks 6 (AI_FILL route), 7 (orchestration), 5 (addTargets). ✓
- 2.6 classification (+ EEO exclusion via `sensitive`) → Task 4. ✓
- 2.7 jobContext scraper → Task 3. ✓
- 2.8 overlay review UX (`onInsertAnswer` non-disruptive, review cards) → Tasks 7 (onInsertAnswer one-shot write) + 8. ✓
- 2.10 error/edge handling → Task 7 (try/catch swallow; candidates empty → no call), Task 6 (auth/needsLogin), Task 7 onInsertAnswer (missing field). ✓
- 2.11 testing → Tasks 1,3,4,5,6 unit tests; Task 9 manual E2E. ✓
- "no backend change" → confirmed; no backend task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "similar to Task N". ✓

**Type consistency:** `AiFillField`/`JobContext`/`AiFillAnswer`/`AiFillResponse`/`AiDraft` defined in Task 2 and used identically in Tasks 3,4,6,7,8. `onAutofill` return `{ ok; fail; total; drafts }` is produced in Task 7 and matched in Task 8's `OverlayCallbacks`. `addTargets` signature defined in Task 5 and called in Task 7. `aiFillFields`/`buildFillRequestBody` defined in Task 6 and called in serviceWorker. ✓

**Note on Task 7/8 ordering:** Task 7 intentionally leaves the tree non-compiling until Task 8 updates `OverlayCallbacks`. Review Tasks 7 and 8 together (or run `npm run typecheck` only after Task 8). This is called out in Task 7 Step 3.
