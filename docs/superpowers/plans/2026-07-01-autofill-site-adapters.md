# Autofill Per‑Site Adapter Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per‑site ATS adapter framework — a thin override layer over the working generic pipeline — with Greenhouse and Workday reference adapters.

**Architecture:** A matched `SiteAdapter` (resolved from the host via a registry) may override at three seams — `classify` (correct a field's category), `resolveAnswer` (site‑specific value), and `fillOperation` (own a field's fill). Hooks are advisory: declining (returning `undefined`) or no adapter → today's generic behavior, unchanged. Integration is confined to `formScanner` (classify + resolveAnswer) and `contentScript` (fillOperation first‑refusal); adapter logic lives in `src/content/adapters/`.

**Tech Stack:** TypeScript (strict), esbuild (IIFE bundles), MV3, vitest + jsdom (unit).

## Global Constraints

- Hooks are optional + advisory: `classify`/`resolveAnswer` return `undefined` to keep generic; `resolveAnswer` may return `null` (a valid "no data" answer). `fillOperation` returns `undefined` **synchronously** to decline, or a `Promise<AdapterFillResult>` to claim + fill.
- Unrecognized host (`getAdapter` → `null`) and any declined hook → byte‑identical generic behavior (no regression).
- Every hook call is wrapped so a throwing adapter degrades to generic and never breaks scan/fill or hangs.
- `match(host, url)` is pure and DOM‑free.
- Adapter‑operated fields are filled exactly once (not also by reconciler/combobox/driver).
- No changes to Phase‑1 drivers, `writeEngine`, or `comboboxEngine` internals.
- Field locator/attrs unchanged; `FIELD_ID_ATTR = "data-ap-field"`.
- Branch `feature/autofill-site-adapters`. Run `npx tsc --noEmit` and `npx vitest run` before each commit (NOT `npm test`/`npm run typecheck` — they exit 1 with no output in this shell; run `npx vitest run <path>`, `npx tsc --noEmit`, `node build.mjs` directly). Commit after each task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. TDD throughout.

---

### Task 1: Adapter contract types

**Files:**
- Create: `chrome-extension/src/content/adapters/types.ts`

**Interfaces:**
- Produces: `SiteAdapter`, `FieldContext`, `AnswerContext`, `FillContext`, `AdapterFillResult`.

- [ ] **Step 1: Create the types module**

```ts
// chrome-extension/src/content/adapters/types.ts
/**
 * Per-site adapter contract. A matched adapter layers optional overrides on the
 * generic pipeline; every hook is advisory (undefined = keep generic behavior).
 */
import type { Classification } from "../fieldMatcher";
import type { FieldSignals } from "../domUtils";
import type { RuntimeControl } from "../formScanner";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../../shared/types";

export interface FieldContext {
  el: HTMLElement;
  signals: FieldSignals;
  controlType: ControlType;
}

export interface AnswerContext {
  category: FieldCategory;
  profile: UserApplicationProfile; // only supplied when a profile is loaded
  control: { controlType: ControlType; options?: string[] };
  fillEEO: boolean;
  el: HTMLElement;
}

export interface FillContext {
  control: RuntimeControl;
  value: string;
  el: HTMLElement;
}

export interface AdapterFillResult {
  filled: boolean;
  reason?: string;
}

export interface SiteAdapter {
  id: string;
  /** Detection — pure, host/url only, no DOM. */
  match(host: string, url: string): boolean;
  /** Correct a field's category; undefined keeps the generic Classification. */
  classify?(ctx: FieldContext, generic: Classification): Classification | undefined;
  /** Site-specific value; undefined = generic, string|null = use verbatim. */
  resolveAnswer?(ctx: AnswerContext): string | null | undefined;
  /** undefined (sync) declines → generic fill; a Promise claims + fills the field. */
  fillOperation?(ctx: FillContext): Promise<AdapterFillResult> | undefined;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0 (`Classification` is exported from `fieldMatcher.ts`; `FieldSignals` from `domUtils.ts`; `RuntimeControl` from `formScanner.ts`; `ControlType`/`FieldCategory`/`UserApplicationProfile` from `shared/types.ts` — all `import type`, no runtime cycle).

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/content/adapters/types.ts
git commit -m "feat(adapters): SiteAdapter contract + context types" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Registry

**Files:**
- Create: `chrome-extension/src/content/adapters/registry.ts`
- Test: `chrome-extension/test/adapterRegistry.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter` (Task 1).
- Produces: `resolveAdapter(adapters: SiteAdapter[], host: string, url: string): SiteAdapter | null`; `getAdapter(host, url): SiteAdapter | null`; mutable `ADAPTERS: SiteAdapter[]` (empty for now; adapters register in Tasks 4/5).

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/adapterRegistry.test.ts
import { describe, it, expect } from "vitest";
import { resolveAdapter } from "../src/content/adapters/registry";
import type { SiteAdapter } from "../src/content/adapters/types";

const stub = (id: string, match: SiteAdapter["match"]): SiteAdapter => ({ id, match });

describe("resolveAdapter", () => {
  it("returns the first adapter whose match() is true (order = precedence)", () => {
    const a = stub("a", (h) => h.endsWith("a.com"));
    const b = stub("b", (h) => h.endsWith("b.com"));
    expect(resolveAdapter([a, b], "x.b.com", "https://x.b.com/")?.id).toBe("b");
  });

  it("returns null when nothing matches", () => {
    const a = stub("a", (h) => h === "a.com");
    expect(resolveAdapter([a], "other.com", "https://other.com/")).toBeNull();
  });

  it("skips an adapter whose match() throws (one bad adapter can't break resolution)", () => {
    const bad = stub("bad", () => { throw new Error("boom"); });
    const good = stub("good", (h) => h === "ok.com");
    expect(resolveAdapter([bad, good], "ok.com", "https://ok.com/")?.id).toBe("good");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/adapterRegistry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// chrome-extension/src/content/adapters/registry.ts
import type { SiteAdapter } from "./types";

/** Registered adapters, ordered — first match wins. Populated in the adapter
 *  modules (greenhouse.ts, workday.ts) via `ADAPTERS.push(...)` at import time. */
export const ADAPTERS: SiteAdapter[] = [];

/** Pure resolution against an explicit list — a throwing match() is skipped. */
export function resolveAdapter(adapters: SiteAdapter[], host: string, url: string): SiteAdapter | null {
  for (const a of adapters) {
    try {
      if (a.match(host, url)) return a;
    } catch {
      /* a broken adapter must never break resolution */
    }
  }
  return null;
}

/** Resolve the adapter for a page against the live registry. */
export function getAdapter(host: string, url: string): SiteAdapter | null {
  return resolveAdapter(ADAPTERS, host, url);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/adapterRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/adapters/registry.ts chrome-extension/test/adapterRegistry.test.ts
git commit -m "feat(adapters): registry with pure resolveAdapter + getAdapter" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Hook application helpers

**Files:**
- Create: `chrome-extension/src/content/adapters/apply.ts`
- Test: `chrome-extension/test/adapterApply.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter`, contexts (Task 1); `classifyField`, `resolveProfileValue`, `Classification` from `../fieldMatcher`; `RuntimeControl` from `../formScanner`.
- Produces:
  - `classifyWithAdapter(adapter, ctx: FieldContext): Classification`
  - `resolveAnswerWithAdapter(adapter, category, profile, control, fillEEO, el): string | null`
  - `tryAdapterOperation(adapter, ctx: FillContext): Promise<AdapterFillResult> | undefined`
  - `runAdapterOperations(adapter, items, getControl): Promise<{ opOutcomes: {fieldId:string;ok:boolean}[]; remaining: {fieldId:string;value:string}[] }>`

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/adapterApply.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyWithAdapter,
  resolveAnswerWithAdapter,
  runAdapterOperations,
} from "../src/content/adapters/apply";
import type { SiteAdapter, FieldContext } from "../src/content/adapters/types";
import type { RuntimeControl } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });

function fieldCtx(): FieldContext {
  const el = document.createElement("input");
  document.body.append(el);
  return { el, signals: { label: "", ariaLabel: "", placeholder: "", nameAttr: "", idAttr: "", testId: "", nearby: "", typeHint: "", autocomplete: "" } as FieldContext["signals"], controlType: "text" };
}

const profile = { firstName: "Ada", location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;

describe("classifyWithAdapter", () => {
  it("uses the adapter override when provided", () => {
    const adapter = { id: "x", match: () => true, classify: () => ({ category: "github", confidence: 0.9, sensitive: false }) } as SiteAdapter;
    expect(classifyWithAdapter(adapter, fieldCtx()).category).toBe("github");
  });
  it("falls back to generic when the adapter declines (undefined)", () => {
    const adapter = { id: "x", match: () => true, classify: () => undefined } as SiteAdapter;
    // generic classify of an empty input → "unknown"
    expect(classifyWithAdapter(adapter, fieldCtx()).category).toBe("unknown");
  });
  it("falls back to generic when the adapter hook throws", () => {
    const adapter = { id: "x", match: () => true, classify: () => { throw new Error("boom"); } } as SiteAdapter;
    expect(classifyWithAdapter(adapter, fieldCtx()).category).toBe("unknown");
  });
  it("uses generic when there is no adapter", () => {
    expect(classifyWithAdapter(null, fieldCtx()).category).toBe("unknown");
  });
});

describe("resolveAnswerWithAdapter", () => {
  const control = { controlType: "text" as const };
  it("returns null when no profile is loaded", () => {
    expect(resolveAnswerWithAdapter(null, "firstName", null, control, false, document.body)).toBeNull();
  });
  it("uses the adapter override (including a null override) over generic", () => {
    const adapter = { id: "x", match: () => true, resolveAnswer: () => "OVERRIDE" } as SiteAdapter;
    expect(resolveAnswerWithAdapter(adapter, "firstName", profile, control, false, document.body)).toBe("OVERRIDE");
  });
  it("falls back to generic resolveProfileValue when the adapter declines", () => {
    const adapter = { id: "x", match: () => true, resolveAnswer: () => undefined } as SiteAdapter;
    expect(resolveAnswerWithAdapter(adapter, "firstName", profile, control, false, document.body)).toBe("Ada");
  });
});

describe("runAdapterOperations", () => {
  const ctrl = (id: string): RuntimeControl => ({ id, controlType: "text", el: document.createElement("input") });
  it("routes claimed fields to the adapter and leaves the rest as remaining", async () => {
    const adapter = {
      id: "x", match: () => true,
      fillOperation: (c) => (c.value === "op" ? Promise.resolve({ filled: true }) : undefined),
    } as SiteAdapter;
    const items = [{ fieldId: "a", value: "op" }, { fieldId: "b", value: "generic" }];
    const reg = new Map([["a", ctrl("a")], ["b", ctrl("b")]]);
    const { opOutcomes, remaining } = await runAdapterOperations(adapter, items, (id) => reg.get(id));
    expect(opOutcomes).toEqual([{ fieldId: "a", ok: true }]);
    expect(remaining).toEqual([{ fieldId: "b", value: "generic" }]);
  });
  it("treats a null adapter as all-remaining", async () => {
    const items = [{ fieldId: "a", value: "x" }];
    const reg = new Map([["a", ctrl("a")]]);
    const { opOutcomes, remaining } = await runAdapterOperations(null, items, (id) => reg.get(id));
    expect(opOutcomes).toEqual([]);
    expect(remaining).toEqual(items);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/adapterApply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```ts
// chrome-extension/src/content/adapters/apply.ts
/**
 * Applies adapter hooks over the generic pipeline. Each helper falls back to
 * generic behavior when the adapter is null, the hook is absent, the hook
 * declines (undefined), or the hook throws — so an adapter can only ever refine,
 * never break, the pipeline.
 */
import { classifyField, resolveProfileValue, type Classification } from "../fieldMatcher";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../../shared/types";
import type { RuntimeControl } from "../formScanner";
import type { AdapterFillResult, FieldContext, FillContext, SiteAdapter } from "./types";

function safe<T>(fn: () => T, label: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.warn(`[adapter ${label}]`, e);
    return undefined;
  }
}

export function classifyWithAdapter(adapter: SiteAdapter | null, ctx: FieldContext): Classification {
  const generic = classifyField(ctx.signals);
  if (!adapter?.classify) return generic;
  const override = safe(() => adapter.classify!(ctx, generic), "classify");
  return override ?? generic;
}

export function resolveAnswerWithAdapter(
  adapter: SiteAdapter | null,
  category: FieldCategory,
  profile: UserApplicationProfile | null,
  control: { controlType: ControlType; options?: string[] },
  fillEEO: boolean,
  el: HTMLElement
): string | null {
  if (!profile) return null;
  if (adapter?.resolveAnswer) {
    const override = safe(() => adapter.resolveAnswer!({ category, profile, control, fillEEO, el }), "resolveAnswer");
    if (override !== undefined) return override;
  }
  return resolveProfileValue(category, profile, control, fillEEO);
}

/** undefined = adapter declines this field (generic fill); Promise = adapter owns it. */
export function tryAdapterOperation(
  adapter: SiteAdapter | null,
  ctx: FillContext
): Promise<AdapterFillResult> | undefined {
  if (!adapter?.fillOperation) return undefined;
  return safe(() => adapter.fillOperation!(ctx), "fillOperation");
}

/** Give the adapter first refusal on each item; run claimed ops, return the rest. */
export async function runAdapterOperations(
  adapter: SiteAdapter | null,
  items: { fieldId: string; value: string }[],
  getControl: (id: string) => RuntimeControl | undefined
): Promise<{ opOutcomes: { fieldId: string; ok: boolean }[]; remaining: { fieldId: string; value: string }[] }> {
  const opOutcomes: { fieldId: string; ok: boolean }[] = [];
  const remaining: { fieldId: string; value: string }[] = [];
  for (const it of items) {
    const control = getControl(it.fieldId);
    const op = control?.el ? tryAdapterOperation(adapter, { control, value: it.value, el: control.el }) : undefined;
    if (op) {
      const r = await op.catch(() => ({ filled: false as const }));
      opOutcomes.push({ fieldId: it.fieldId, ok: r.filled });
    } else {
      remaining.push(it);
    }
  }
  return { opOutcomes, remaining };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/adapterApply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/adapters/apply.ts chrome-extension/test/adapterApply.test.ts
git commit -m "feat(adapters): hook application helpers (classify/resolveAnswer/operation, error-isolated)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Greenhouse adapter

**Files:**
- Create: `chrome-extension/src/content/adapters/greenhouse.ts`
- Test: `chrome-extension/test/greenhouseAdapter.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter`, contexts (Task 1); `ADAPTERS` (Task 2).
- Produces: `greenhouseAdapter: SiteAdapter`; self-registers via `ADAPTERS.push(greenhouseAdapter)`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/greenhouseAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { greenhouseAdapter } from "../src/content/adapters/greenhouse";
import type { FieldContext } from "../src/content/adapters/types";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });

function inputCtx(attrs: Record<string, string>): FieldContext {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}
const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

describe("greenhouseAdapter.match", () => {
  it("matches greenhouse.io hosts", () => {
    expect(greenhouseAdapter.match("boards.greenhouse.io", "https://boards.greenhouse.io/acme")).toBe(true);
    expect(greenhouseAdapter.match("job-boards.greenhouse.io", "")).toBe(true);
  });
  it("does not match other hosts", () => {
    expect(greenhouseAdapter.match("notgreenhouse.io.evil.com", "")).toBe(false);
    expect(greenhouseAdapter.match("example.com", "")).toBe(false);
  });
});

describe("greenhouseAdapter.classify", () => {
  it("classifies a LinkedIn custom-URL question by its name attribute", () => {
    const ctx = inputCtx({ name: "urls[LinkedIn]" });
    expect(greenhouseAdapter.classify!(ctx, generic)?.category).toBe("linkedin");
  });
  it("classifies GitHub and portfolio URL questions", () => {
    expect(greenhouseAdapter.classify!(inputCtx({ name: "urls[GitHub]" }), generic)?.category).toBe("github");
    expect(greenhouseAdapter.classify!(inputCtx({ name: "urls[Website]" }), generic)?.category).toBe("portfolio");
  });
  it("declines (undefined) for an unrelated field", () => {
    expect(greenhouseAdapter.classify!(inputCtx({ name: "first_name" }), generic)).toBeUndefined();
  });
});

describe("greenhouseAdapter.resolveAnswer", () => {
  const el = document.createElement("input");
  const control = { controlType: "select" as const };
  it("maps profile gender to Greenhouse's exact EEO option when EEO is on", () => {
    const profile = { eeo: { gender: "female" } } as unknown as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "eeoGender", profile, control, fillEEO: true, el })).toBe("Female");
  });
  it("declines when EEO is off", () => {
    const profile = { eeo: { gender: "male" } } as unknown as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "eeoGender", profile, control, fillEEO: false, el })).toBeUndefined();
  });
  it("declines for non-EEO categories", () => {
    const profile = {} as UserApplicationProfile;
    expect(greenhouseAdapter.resolveAnswer!({ category: "firstName", profile, control, fillEEO: true, el })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/greenhouseAdapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// chrome-extension/src/content/adapters/greenhouse.ts
/**
 * Greenhouse (`*.greenhouse.io`). Greenhouse forms are well-labeled, so the
 * generic pipeline handles most fields; this adapter reinforces the few quirks:
 * custom social-URL questions (name="...urls[LinkedIn]...") whose visible label
 * is often just the network name, and exact EEO option casing.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import type { SiteAdapter } from "./types";

const NAME_RULES: Array<[RegExp, FieldCategory]> = [
  [/urls\[linked ?in\]|linked ?in_url/i, "linkedin"],
  [/urls\[git ?hub\]|git ?hub_url/i, "github"],
  [/urls\[(website|portfolio|other)\]/i, "portfolio"],
];

export const greenhouseAdapter: SiteAdapter = {
  id: "greenhouse",
  match: (host) => /(^|\.)greenhouse\.io$/i.test(host),

  classify(ctx) {
    const name = ctx.el.getAttribute("name") || ctx.el.id || "";
    for (const [re, category] of NAME_RULES) {
      if (re.test(name)) return { category, confidence: 0.95, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Greenhouse EEO gender options are exact-cased ("Male"/"Female"/"Decline To
    // Self Identify"); map common profile values to a real option.
    if (ctx.category === "eeoGender") {
      if (!ctx.fillEEO) return undefined;
      const g = (ctx.profile.eeo?.gender || "").toLowerCase();
      if (!g) return undefined;
      if (g.startsWith("m")) return "Male";
      if (g.startsWith("f") || g.startsWith("w")) return "Female";
      return "Decline To Self Identify";
    }
    return undefined;
  },
};

ADAPTERS.push(greenhouseAdapter);
```

(Note: the first LinkedIn test case builds a `data-field` attr that isn't read; the effective assertion is `ctx2` with `name="urls[LinkedIn]"`. Keep both — the second is the real check.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/greenhouseAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify registry now resolves Greenhouse**

Run: `cd chrome-extension && npx vitest run test/adapterRegistry.test.ts`
Expected: PASS (unchanged — `resolveAdapter` is list-injected; `getAdapter` picks up the push, but these tests use explicit lists).

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/adapters/greenhouse.ts chrome-extension/test/greenhouseAdapter.test.ts
git commit -m "feat(adapters): Greenhouse reference adapter (URL-question classify + EEO gender answer)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Workday adapter

**Files:**
- Create: `chrome-extension/src/content/adapters/workday.ts`
- Test: `chrome-extension/test/workdayAdapter.test.ts`

**Interfaces:**
- Consumes: `SiteAdapter`, `FillContext`, `AdapterFillResult` (Task 1); `ADAPTERS` (Task 2).
- Produces: `workdayAdapter: SiteAdapter` (match, classify by `data-automation-id`, resolveAnswer country, `fillOperation` split-date); self-registers.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/workdayAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { workdayAdapter } from "../src/content/adapters/workday";
import type { FieldContext, FillContext } from "../src/content/adapters/types";
import type { RuntimeControl } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });
const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

function ctxWithAutomationId(aid: string): FieldContext {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-automation-id", aid);
  const el = document.createElement("input");
  wrap.append(el);
  document.body.append(wrap);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}

describe("workdayAdapter.match", () => {
  it("matches Workday hosts", () => {
    expect(workdayAdapter.match("acme.wd5.myworkdayjobs.com", "")).toBe(true);
    expect(workdayAdapter.match("x.myworkdaysite.com", "")).toBe(true);
  });
  it("does not match other hosts", () => {
    expect(workdayAdapter.match("example.com", "")).toBe(false);
  });
});

describe("workdayAdapter.classify (by data-automation-id)", () => {
  it("maps first/last name, email, phone, and country", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_firstName"), generic)?.category).toBe("firstName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_lastName"), generic)?.category).toBe("lastName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("email"), generic)?.category).toBe("email");
    expect(workdayAdapter.classify!(ctxWithAutomationId("phone-number"), generic)?.category).toBe("phone");
    expect(workdayAdapter.classify!(ctxWithAutomationId("addressSection_countryRegion"), generic)?.category).toBe("location");
  });
  it("declines for an unknown automation id", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("someRandomWidget"), generic)).toBeUndefined();
  });
});

describe("workdayAdapter.resolveAnswer", () => {
  it("extracts the country from a comma location for a Workday country field", () => {
    const ctx = ctxWithAutomationId("addressSection_countryRegion");
    const profile = { location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "location", profile, control: { controlType: "combobox" }, fillEEO: false, el: ctx.el })).toBe("Canada");
  });
  it("declines for a non-country location field", () => {
    const ctx = ctxWithAutomationId("addressSection_city");
    const profile = { location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "location", profile, control: { controlType: "text" }, fillEEO: false, el: ctx.el })).toBeUndefined();
  });
});

describe("workdayAdapter.fillOperation (split date)", () => {
  function dateWidget(): { el: HTMLElement; month: HTMLInputElement; day: HTMLInputElement; year: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "formField-startDate");
    const month = document.createElement("input"); month.setAttribute("data-automation-id", "dateSectionMonth-input");
    const day = document.createElement("input"); day.setAttribute("data-automation-id", "dateSectionDay-input");
    const year = document.createElement("input"); year.setAttribute("data-automation-id", "dateSectionYear-input");
    wrap.append(month, day, year);
    document.body.append(wrap);
    return { el: wrap, month, day, year };
  }
  function fillCtx(el: HTMLElement, value: string): FillContext {
    const control: RuntimeControl = { id: "d", controlType: "text", el };
    return { control, value, el };
  }

  it("fills month/day/year from an ISO date and returns filled:true", async () => {
    const w = dateWidget();
    const op = workdayAdapter.fillOperation!(fillCtx(w.el, "2023-05-15"));
    expect(op).toBeInstanceOf(Promise);
    expect(await op!).toEqual({ filled: true });
    expect(w.month.value).toBe("5");
    expect(w.day.value).toBe("15");
    expect(w.year.value).toBe("2023");
  });

  it("declines (undefined) for a non-date Workday field", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "email");
    const el = document.createElement("input");
    wrap.append(el); document.body.append(wrap);
    expect(workdayAdapter.fillOperation!(fillCtx(el, "someone@example.com"))).toBeUndefined();
  });

  it("declines when the value is not a parseable date", () => {
    const w = dateWidget();
    expect(workdayAdapter.fillOperation!(fillCtx(w.el, "not a date"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/workdayAdapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// chrome-extension/src/content/adapters/workday.ts
/**
 * Workday (`*.myworkdayjobs.com` etc.). Workday's visible labels are generic, but
 * its `data-automation-id`s are reliable — the adapter's main win. Also formats
 * the country prompt and owns the split (month/day/year) date widget the generic
 * writer can't drive as one value.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import type { AdapterFillResult, FillContext, SiteAdapter } from "./types";

const WD_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

const AUTOMATION_RULES: Array<[RegExp, FieldCategory]> = [
  [/firstname|givenname/i, "firstName"],
  [/lastname|familyname/i, "lastName"],
  [/email/i, "email"],
  [/phone.*number|phonenumber|^phone/i, "phone"],
  [/country|region/i, "location"],
  [/(address)?.*city/i, "location"],
];

function automationId(el: HTMLElement): string {
  return (el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "").toLowerCase();
}

function parseDate(v: string): { month: string; day: string; year: string } | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { year: iso[1], month: String(Number(iso[2])), day: String(Number(iso[3])) };
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { month: String(Number(us[1])), day: String(Number(us[2])), year: us[3] };
  return null;
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export const workdayAdapter: SiteAdapter = {
  id: "workday",
  match: (host) => WD_HOST.test(host),

  classify(ctx) {
    const aid = automationId(ctx.el);
    if (!aid) return undefined;
    for (const [re, category] of AUTOMATION_RULES) {
      if (re.test(aid)) return { category, confidence: 0.96, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Workday country/region prompts expect just the country name.
    if (ctx.category === "location" && /country|region/.test(automationId(ctx.el))) {
      const country = (ctx.profile.location || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
      return country || undefined;
    }
    return undefined;
  },

  fillOperation(ctx: FillContext): Promise<AdapterFillResult> | undefined {
    const container = ctx.el.closest("[data-automation-id]");
    if (!container || !/date/i.test(container.getAttribute("data-automation-id") || "")) return undefined;
    const q = (frag: string) =>
      container.querySelector<HTMLInputElement>(`input[data-automation-id*="${frag}" i]`);
    const month = q("month");
    const day = q("day");
    const year = q("year");
    const parts = parseDate(ctx.value);
    if (!parts || (!month && !day && !year)) return undefined;
    return (async () => {
      if (month) setInput(month, parts.month);
      if (day) setInput(day, parts.day);
      if (year) setInput(year, parts.year);
      return { filled: true };
    })();
  },
};

ADAPTERS.push(workdayAdapter);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/workdayAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the barrel + registration order check**

Create `chrome-extension/src/content/adapters/index.ts`:
```ts
// chrome-extension/src/content/adapters/index.ts
// Importing the adapter modules registers them (ADAPTERS.push at import time).
import "./greenhouse";
import "./workday";
export { getAdapter, resolveAdapter, ADAPTERS } from "./registry";
export type { SiteAdapter, FieldContext, AnswerContext, FillContext, AdapterFillResult } from "./types";
export {
  classifyWithAdapter,
  resolveAnswerWithAdapter,
  tryAdapterOperation,
  runAdapterOperations,
} from "./apply";
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: exit 0.
```bash
git add chrome-extension/src/content/adapters/workday.ts chrome-extension/src/content/adapters/index.ts chrome-extension/test/workdayAdapter.test.ts
git commit -m "feat(adapters): Workday reference adapter (automation-id classify, country answer, split-date operation)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Thread adapters into the scanner

**Files:**
- Modify: `chrome-extension/src/content/formScanner.ts`
- Test: `chrome-extension/test/scanPageAdapter.test.ts`

**Interfaces:**
- Consumes: `classifyWithAdapter`, `resolveAnswerWithAdapter` (Task 3); `getAdapter` (Task 2); `SiteAdapter` (Task 1).
- Produces: `scanPage(profile, fillEEO, adapter?)` (3rd param defaults to the resolved adapter, injectable for tests); `ScanResult.adapter: SiteAdapter | null`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/scanPageAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";
import type { SiteAdapter } from "../src/content/adapters/types";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });
const profile = { firstName: "Ada", github: "https://github.com/ada" } as unknown as UserApplicationProfile;

describe("scanPage adapter integration", () => {
  it("uses an adapter classify override to categorize a field the generic path misses", () => {
    document.body.innerHTML = `<input name="mystery" />`; // generic → unknown
    const adapter: SiteAdapter = {
      id: "t", match: () => true,
      classify: () => ({ category: "github", confidence: 0.9, sensitive: false }),
    };
    const { fields } = scanPage(profile, false, adapter);
    const f = fields.find((x) => x.category === "github");
    expect(f).toBeTruthy();
    expect(f!.proposedValue).toBe("https://github.com/ada");
  });

  it("uses an adapter resolveAnswer override for the value", () => {
    document.body.innerHTML = `<label for="a">First name</label><input id="a" />`;
    const adapter: SiteAdapter = {
      id: "t", match: () => true,
      resolveAnswer: () => "OVERRIDDEN",
    };
    const { fields } = scanPage(profile, false, adapter);
    const f = fields.find((x) => x.category === "firstName");
    expect(f!.proposedValue).toBe("OVERRIDDEN");
  });

  it("is unchanged from generic when no adapter matches (null)", () => {
    document.body.innerHTML = `<label for="a">First name</label><input id="a" />`;
    const withNull = scanPage(profile, false, null);
    const f = withNull.fields.find((x) => x.category === "firstName");
    expect(f!.proposedValue).toBe("Ada"); // generic resolveProfileValue
    expect(withNull.adapter).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/scanPageAdapter.test.ts`
Expected: FAIL — `scanPage` doesn't accept a 3rd arg / `ScanResult.adapter` missing / overrides not applied.

- [ ] **Step 3: Update imports in `formScanner.ts`**

Replace the line:
```ts
import { classifyField, resolveProfileValue } from "./fieldMatcher";
```
with:
```ts
import { classifyWithAdapter, resolveAnswerWithAdapter } from "./adapters/apply";
import { getAdapter } from "./adapters/registry";
import type { SiteAdapter } from "./adapters/types";
```

- [ ] **Step 4: Add `adapter` to `ScanResult`**

Change:
```ts
export interface ScanResult {
  fields: DetectedField[];
  registry: Map<string, RuntimeControl>;
}
```
to:
```ts
export interface ScanResult {
  fields: DetectedField[];
  registry: Map<string, RuntimeControl>;
  adapter: SiteAdapter | null;
}
```

- [ ] **Step 5: Add the adapter param + resolve it in `scanPage`**

Change the signature:
```ts
export function scanPage(
  profile: UserApplicationProfile | null,
  fillEEO: boolean
): ScanResult {
```
to:
```ts
export function scanPage(
  profile: UserApplicationProfile | null,
  fillEEO: boolean,
  adapter: SiteAdapter | null = getAdapter(location.hostname, location.href)
): ScanResult {
```
And change the final `return { fields, registry };` to `return { fields, registry, adapter };`.

- [ ] **Step 6: Swap classify + resolve at all three branches**

Single-control branch — replace:
```ts
    const { category, confidence, sensitive } = classifyField(signals);
```
with:
```ts
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el, signals, controlType });
```
and replace:
```ts
    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType, options }, fillEEO)
      : null;
```
with:
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType, options }, fillEEO, el);
```

Radio-group branch — replace:
```ts
    const { category, confidence, sensitive } = classifyField(signals);
```
with:
```ts
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el: first, signals, controlType: "radioGroup" });
```
and replace:
```ts
    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType: "radioGroup", options }, fillEEO)
      : null;
```
with:
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType: "radioGroup", options }, fillEEO, first);
```

Checkbox-group branch — replace:
```ts
    const { category, confidence, sensitive } = classifyField(signals);
```
with:
```ts
    const { category, confidence, sensitive } = classifyWithAdapter(adapter, { el: first, signals, controlType: "checkboxGroup" });
```
and replace:
```ts
    const proposedValue = profile
      ? resolveProfileValue(category, profile, { controlType: "checkboxGroup", options }, fillEEO)
      : null;
```
with:
```ts
    const proposedValue = resolveAnswerWithAdapter(adapter, category, profile, { controlType: "checkboxGroup", options }, fillEEO, first);
```

- [ ] **Step 7: Run the adapter integration test + full scanner suite**

Run: `cd chrome-extension && npx vitest run test/scanPageAdapter.test.ts test/formScanner.test.ts`
Expected: PASS (new integration + existing scanner tests unchanged — generic behavior preserved because `formScanner.test.ts` calls `scanPage(profile, eeo)` with the default adapter, which resolves via `getAdapter(location.hostname…)` = `localhost` → null → generic).

- [ ] **Step 8: Typecheck + full suite**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run`
Expected: exit 0; all green.

- [ ] **Step 9: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/test/scanPageAdapter.test.ts
git commit -m "feat(adapters): thread site adapter into scanPage classify + resolveAnswer" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Adapter fill first‑refusal in the content script

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts`

**Interfaces:**
- Consumes: `runAdapterOperations`, `tryAdapterOperation` (Task 3); `SiteAdapter` (Task 1); `ScanResult.adapter` (Task 6).

- [ ] **Step 1: Add imports (also registers the built-in adapters)**

Add to `contentScript.ts` imports. Import from the `./adapters` **barrel** (not the sub‑modules): the barrel's side‑effect imports (`import "./greenhouse"; import "./workday";`) push the built‑in adapters into `ADAPTERS`, so `getAdapter` (called inside `scanPage`) can resolve them in production. `contentScript` is the content‑script entry, so this import runs before any scan — this is the ONLY place that triggers registration, and without it `getAdapter` would always return `null`.
```ts
import { runAdapterOperations, tryAdapterOperation, type SiteAdapter } from "./adapters";
```

- [ ] **Step 2: Store the resolved adapter per scan**

In `initialize()`, add alongside `let registry…`:
```ts
  let lastAdapter: SiteAdapter | null = null;
```
In `runScan()`, after `registry = result.registry;` add:
```ts
    lastAdapter = result.adapter;
```

- [ ] **Step 3: Give the adapter first refusal in the primary autofill pass**

In `onAutofill`, replace the block from `const driverTargets = selected` through the `const comboOutcomes = [ … ];` assignment with:
```ts
      // Phase 2 — the site adapter gets first refusal on each field's fill.
      const selectedItems = selected.map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const { opOutcomes, remaining } = await runAdapterOperations(lastAdapter, selectedItems, (id) => registry.get(id));

      // Phase 1a — deterministic local fill via the reconciler (text/select/checkbox/radio).
      const driverTargets = remaining.filter((it) => isDriverField(it.fieldId));
      const targets = remaining.filter(
        (it) => !isDriverField(it.fieldId) && registry.get(it.fieldId)?.controlType !== "combobox"
      );
      const localReports = await getEngine().run(targets, registry);

      // Phase 1b — custom ARIA dropdowns + react-select/Workday driver, plus adapter ops.
      const comboOutcomes = [
        ...(await fillComboboxTargets(
          remaining.filter((it) => !isDriverField(it.fieldId) && registry.get(it.fieldId)?.controlType === "combobox")
        )),
        ...(await fillDriverTargets(driverTargets)),
        ...opOutcomes,
      ];
```
(`fillComboboxTargets`/`fillDriverTargets`/`getEngine().run` already accept `{fieldId, value}[]`; `remaining` is that shape, so no further mapping is needed.)

- [ ] **Step 4: Give the adapter first refusal in the AI pass**

In the AI branch, replace the block that computes `aiDriver`/`aiCombo`/`aiSimple` and fills them with:
```ts
            const { opOutcomes: aiOpOutcomes, remaining: aiRemaining } =
              await runAdapterOperations(lastAdapter, plan.simpleTargets, (id) => registry.get(id));
            const aiDriver = aiRemaining.filter((t) => isDriverField(t.fieldId));
            const aiCombo = aiRemaining.filter(
              (t) => !isDriverField(t.fieldId) && isComboboxField(t.fieldId)
            );
            const aiSimple = aiRemaining.filter(
              (t) => !isDriverField(t.fieldId) && !isComboboxField(t.fieldId)
            );
            if (aiSimple.length > 0) {
              aiReports = await getEngine().addTargets(aiSimple, registry);
            }
            aiComboOutcomes = [
              ...aiOpOutcomes,
              ...(aiCombo.length > 0 ? await fillComboboxTargets(aiCombo) : []),
              ...(aiDriver.length > 0 ? await fillDriverTargets(aiDriver) : []),
            ];
```

- [ ] **Step 5: Give the adapter first refusal in `onInsertAnswer`**

In `onInsertAnswer`, immediately after the `if (!control) return {…}` guard and before the `if (control.driver)` / combobox / `writeControl` branches, add:
```ts
      if (control.el) {
        const op = tryAdapterOperation(lastAdapter, { control, value, el: control.el });
        if (op) {
          const r = await op.catch(() => ({ filled: false as const }));
          return r.filled
            ? { ok: true }
            : { ok: false, reason: r.reason ?? "Couldn't fill that field automatically — please do it manually." };
        }
      }
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `cd chrome-extension && npx tsc --noEmit && node build.mjs && npx vitest run`
Expected: exit 0 for tsc; `Build complete → dist/`; all unit tests green (contentScript has no direct unit test — the adapter fill wiring is exercised through `runAdapterOperations`'s own tests from Task 3; here typecheck + build + the unchanged suite confirm no regression).

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts
git commit -m "feat(adapters): adapter fill first-refusal in autofill, AI pass, and insert-answer" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Final verification + docs

**Files:**
- Modify: `docs/autofill-rebuild/jobright-reference-analysis.md`

- [ ] **Step 1: Full verification**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run && node build.mjs`
Expected: tsc exit 0; all unit tests green; build emits `dist/contentScript.js`, `dist/serviceWorker.js`, `dist/mainWorld.js`.

- [ ] **Step 2: Record Phase 2 status**

In `docs/autofill-rebuild/jobright-reference-analysis.md` §15, add after the Phase 2 line:
```markdown
> **Phase 2 status (2026-07-01):** Implemented on branch `feature/autofill-site-adapters` — per-site adapter framework (registry + `SiteAdapter` classify/resolveAnswer/fillOperation override hooks + generic fallback) in `chrome-extension/src/content/adapters/`, with Greenhouse and Workday reference adapters. See the spec and plan dated 2026-07-01.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autofill-rebuild/jobright-reference-analysis.md
git commit -m "docs(autofill): mark Phase 2 per-site adapter framework complete" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** types (Task 1 → §4), registry (Task 2 → §4.1), apply helpers + isolation (Task 3 → §4.2/§7), Greenhouse (Task 4 → §6.1), Workday incl. split-date operation (Task 5 → §6.2), scanner classify+resolveAnswer threading + `ScanResult.adapter` (Task 6 → §5.1), fill first-refusal in autofill/AI/insert (Task 7 → §5.2), generic fallback (Tasks 6/7 via `null` adapter + declines), error isolation (Task 3 `safe`), testing (Tasks 2–6 → §9), acceptance criteria 1–6 (Tasks 5/6/7 + verification gates).
- **Injectable seam:** `scanPage`'s 3rd `adapter` param (default = real resolution) lets tests supply a stub without mutating `window.location` (spec §9), and lets `contentScript` reuse `ScanResult.adapter`.
- **Exactly-once fill:** `runAdapterOperations` removes claimed fields from `remaining` before the driver/combobox/reconciler partition (Task 7), mirroring Phase 1's exclusion pattern.
- **Type consistency:** `SiteAdapter`, `FieldContext`/`AnswerContext`/`FillContext`, `AdapterFillResult`, `classifyWithAdapter`, `resolveAnswerWithAdapter`, `tryAdapterOperation`, `runAdapterOperations(adapter, items, getControl)`, `getAdapter`/`resolveAdapter`, `ScanResult.adapter`, `scanPage(profile, fillEEO, adapter?)` are used consistently across tasks.
- **Adapter registration:** adapters self‑register via `ADAPTERS.push(...)` at module load. `registry.ts` stays dependency‑free (no import of the adapters → no cycle); the built‑ins are pulled in exactly once by `contentScript`'s barrel import `from "./adapters"` (Task 7 Step 1), which runs at content‑script entry before any scan. `formScanner` imports `getAdapter` from `./adapters/registry` granularly and reads the live `ADAPTERS` at scan time. Tests never depend on registration: `scanPageAdapter` passes an explicit adapter, `formScanner.test` resolves `localhost` → `null` → generic, the registry test uses explicit lists, and the adapter‑unit tests import the adapter object directly.
