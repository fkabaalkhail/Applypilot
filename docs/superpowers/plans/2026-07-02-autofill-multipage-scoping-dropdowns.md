# Autofill v2 (Multi-page, Scoping, Option-aware Dropdowns) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Autofill click fills a whole multi-page application (auto-advancing, stopping at Submit, passing signup walls), scans only the real application form, and resolves dropdown answers against the widget's actual options.

**Architecture:** Everything lives in the Chrome extension content script except one matcher tier in the backend. Phase 1 adds page-chrome exclusion + form-container scoping to the scanner. Phase 2 makes dropdown fills harvest real options on a miss and re-ask the backend once per pass. Phase 3 adds a `FlowController` state machine (fill → advance → refill), persisted per-tab in `chrome.storage.session` via the background worker so real navigations resume. Phase 4 adds an account-wall sub-flow with locally generated + stored passwords.

**Tech Stack:** TypeScript (Chrome MV3 extension, esbuild via `build.mjs`), Vitest + jsdom, FastAPI backend (one function change), pytest.

**Spec:** `docs/superpowers/specs/2026-07-02-autofill-multipage-scoping-dropdowns-design.md`

## Global Constraints

- **Run extension tests** from `chrome-extension/`: `node node_modules/vitest/vitest.mjs run test/<file>.test.ts` — do NOT use `npm test` (it exits 1 with no output in this environment).
- **Typecheck** from `chrome-extension/`: `npx tsc -p tsconfig.json --noEmit` (expected: no output). esbuild does not typecheck.
- **Backend test**: `python -m pytest backend/tests/test_match_option.py -v` from the repo root. Do not run the whole backend suite (it migrates the real dev DB).
- **Never click terminal buttons.** Terminal = `submit / send application / apply now / finish / complete application / soumettre / envoyer / postuler / terminer`. Advance = `next / continue / save and continue / save & continue / proceed / review / next step / suivant / continuer / poursuivre / réviser` (+ wall verbs when a wall is detected: `create account / sign up / register / sign in / log in / créer un compte / s'inscrire / se connecter`).
- **Constants, verbatim:** `MAX_STEPS = 12`, `FLOW_TTL_MS = 10 * 60 * 1000`, scope share `0.8`, token shared-prefix `>= 5` chars, password length `20`, storage keys `"apFlowState"` (session) and `"apCredentials"` (local).
- **Passwords never leave the device**: never in `AI_FILL` payloads, never in any backend request, never in `DetectedField.currentValue` (mask as `"filled"`), stored only under `apCredentials` in `chrome.storage.local`.
- **At most ONE dropdown re-ask round per autofill pass** — no retry loops.
- **Scoping fallback invariant:** when no scope container qualifies, the scan result must be byte-identical to today's unscoped behavior.
- **No new manifest permissions.**
- Commit after every task with the message given in its final step.

## File Map

**Create:**
- `chrome-extension/src/content/pageChrome.ts` — composed-tree ancestors + header/nav/footer/aside exclusion
- `chrome-extension/src/content/formScope.ts` — form-container resolution (≥80% rule) + scope filtering
- `chrome-extension/src/content/advance.ts` — advance/terminal button discovery
- `chrome-extension/src/content/flowChecks.ts` — captcha / validation / resume-needed / verification-wall checks
- `chrome-extension/src/content/flowController.ts` — the multi-page state machine
- `chrome-extension/src/content/passwordGen.ts` — crypto-random password generation
- `chrome-extension/src/content/credentialStore.ts` — `chrome.storage.local` credentials CRUD
- `chrome-extension/src/content/accountFlow.ts` — signup/login wall detection + filling
- `chrome-extension/src/background/flowState.ts` — per-tab session flow state
- `backend/tests/test_match_option.py` — prefix-tier tests
- Tests: `chrome-extension/test/pageChrome.test.ts`, `formScope.test.ts`, `scanScope.test.ts`, `advance.test.ts`, `flowChecks.test.ts`, `flowController.test.ts`, `flowState.test.ts`, `passwordGen.test.ts`, `credentialStore.test.ts`, `accountFlow.test.ts`, `overlayFlow.test.ts`, `scanPassword.test.ts`

**Modify:**
- `chrome-extension/src/shared/types.ts` — flow types/messages, `ControlType` `"password"`, `FieldCategory` `"accountPassword"`
- `chrome-extension/src/shared/constants.ts` — `CATEGORY_LABELS.accountPassword`
- `chrome-extension/src/content/formScanner.ts` — chrome exclusion, scoping, `scopeEl`, password branch, export `selectOptions`
- `chrome-extension/src/content/comboboxEngine.ts` — harvest options on miss, export `activateElement`
- `chrome-extension/src/content/writeEngine.ts` — prefix tier in `matchOption`, `password` write/verify cases
- `chrome-extension/src/content/aiFillPlanner.ts` — `planReaskFields`
- `chrome-extension/src/content/contentScript.ts` — `fillOnce` extraction, re-ask round, flow wiring, resume-on-init
- `chrome-extension/src/content/overlay.ts` — `OverlayCallbacks` additions, flow progress UI, drafts-cleared signal, saved sign-ins, `accountPassword` filter
- `chrome-extension/src/content/crossFrame.ts` — `ALL_OPS`/`VOID_OPS` additions
- `chrome-extension/src/content/adapters/types.ts` + `adapters/workday.ts` — `advanceButton` hook
- `chrome-extension/src/background/serviceWorker.ts` — `FLOW_STATE_GET/SET` handlers, tab-removal cleanup
- `backend/routers/fill.py` — `_match_option` prefix tier
- `chrome-extension/test/crossFrame.test.ts` — updated op list expectations (if it asserts op names)

---

# Phase 1 — Form scoping

### Task 1: Page-chrome exclusion (`pageChrome.ts`)

**Files:**
- Create: `chrome-extension/src/content/pageChrome.ts`
- Test: `chrome-extension/test/pageChrome.test.ts`

**Interfaces:**
- Consumes: nothing (pure DOM).
- Produces: `composedAncestors(el: HTMLElement): HTMLElement[]` (nearest-first, crosses open shadow-root boundaries via the host) and `isInPageChrome(el: HTMLElement): boolean`. Task 2 uses `composedAncestors`; Task 3 uses `isInPageChrome`.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/pageChrome.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { composedAncestors, isInPageChrome } from "../src/content/pageChrome";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("composedAncestors", () => {
  it("walks plain ancestors nearest-first up to <html>", () => {
    document.body.innerHTML = `<div id="a"><div id="b"><input id="x" /></div></div>`;
    const chain = composedAncestors(document.getElementById("x")!);
    const ids = chain.map((e) => e.id || e.tagName);
    expect(ids).toEqual(["b", "a", "BODY", "HTML"]);
  });

  it("crosses an open shadow-root boundary via the host", () => {
    document.body.innerHTML = `<header id="hdr"><div id="host"></div></header>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    const inner = document.createElement("input");
    root.appendChild(inner);
    const chain = composedAncestors(inner);
    expect(chain).toContain(host);
    expect(chain).toContain(document.getElementById("hdr"));
  });
});

describe("isInPageChrome", () => {
  it("flags controls inside header / nav / footer / aside", () => {
    document.body.innerHTML = `
      <header><select id="lang"><option>EN</option><option>FR</option></select></header>
      <nav><input id="n" /></nav>
      <footer><input id="f" type="email" /></footer>
      <aside><input id="s" /></aside>`;
    for (const id of ["lang", "n", "f", "s"]) {
      expect(isInPageChrome(document.getElementById(id)!)).toBe(true);
    }
  });

  it("flags landmark roles (navigation, banner, contentinfo, search, complementary)", () => {
    document.body.innerHTML = `
      <div role="navigation"><input id="a" /></div>
      <div role="banner"><input id="b" /></div>
      <div role="contentinfo"><input id="c" /></div>
      <form role="search"><input id="d" /></form>
      <div role="complementary"><input id="e" /></div>`;
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(isInPageChrome(document.getElementById(id)!)).toBe(true);
    }
  });

  it("flags a shadow-hosted control whose host sits inside chrome", () => {
    document.body.innerHTML = `<nav id="nav"><div id="host"></div></nav>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    root.appendChild(input);
    expect(isInPageChrome(input)).toBe(true);
  });

  it("does NOT flag an ordinary application-form field", () => {
    document.body.innerHTML = `<main><form><input id="first" name="first_name" /></form></main>`;
    expect(isInPageChrome(document.getElementById("first")!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `chrome-extension/`): `node node_modules/vitest/vitest.mjs run test/pageChrome.test.ts`
Expected: FAIL — cannot resolve `../src/content/pageChrome`.

- [ ] **Step 3: Write the implementation**

Create `chrome-extension/src/content/pageChrome.ts`:

```ts
/**
 * Page-chrome detection — header/nav/footer/aside landmarks are never part of
 * an application form. Mirrors consent.ts / captcha.ts: the scanner skips these
 * controls entirely, so an EN/FR language switcher in the site header (a real
 * <select>) can never surface as an application field.
 */

const CHROME_TAGS = new Set(["HEADER", "NAV", "FOOTER", "ASIDE"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "complementary"]);

/**
 * Ancestors of `el` in the composed tree, nearest first: the parentElement
 * chain, crossing open shadow-root boundaries via the host. (domUtils walks use
 * plain parentElement and would stop at a shadow root — SuccessFactors-style
 * UI5 widgets live inside them.)
 */
export function composedAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node) {
    let parent: HTMLElement | null = node.parentElement;
    if (!parent) {
      const root = node.getRootNode();
      parent = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
    }
    if (parent) out.push(parent);
    node = parent;
  }
  return out;
}

/** True when a composed ancestor of `el` is a chrome landmark (tag or role). */
export function isInPageChrome(el: HTMLElement): boolean {
  for (const a of composedAncestors(el)) {
    if (CHROME_TAGS.has(a.tagName)) return true;
    const role = (a.getAttribute("role") || "").toLowerCase();
    if (CHROME_ROLES.has(role)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/pageChrome.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/pageChrome.ts chrome-extension/test/pageChrome.test.ts
git commit -m "feat(autofill): page-chrome landmark exclusion helpers"
```

### Task 2: Form-container resolution (`formScope.ts`)

**Files:**
- Create: `chrome-extension/src/content/formScope.ts`
- Test: `chrome-extension/test/formScope.test.ts`

**Interfaces:**
- Consumes: `composedAncestors` from `./pageChrome` (Task 1); `DetectedField` from `../shared/types`.
- Produces (Task 3 depends on these exact signatures):
  - `interface ScopeEntry { field: DetectedField; el: HTMLElement }`
  - `resolveFormScope(entries: ScopeEntry[]): HTMLElement | null`
  - `filterToScope(entries: ScopeEntry[], scope: HTMLElement): ScopeEntry[]`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/formScope.test.ts`. The `field()` helper builds a minimal `DetectedField` — only `id` and `category` matter to scoping.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resolveFormScope, filterToScope, type ScopeEntry } from "../src/content/formScope";
import type { DetectedField, FieldCategory } from "../src/shared/types";

beforeEach(() => {
  document.body.innerHTML = "";
});

function field(id: string, category: FieldCategory): DetectedField {
  return {
    id, category, confidence: 0.9, label: id, controlType: "text",
    required: false, proposedValue: null, fillable: true, sensitive: false,
  };
}

function entry(id: string, category: FieldCategory, el: HTMLElement): ScopeEntry {
  return { field: field(id, category), el };
}

describe("resolveFormScope", () => {
  it("picks the <form> containing all recognized fields", () => {
    document.body.innerHTML = `
      <div id="noise"><select id="switcher"><option>EN</option></select></div>
      <form id="app">
        <input id="fn" /><input id="ln" /><input id="em" />
      </form>`;
    const entries = [
      entry("1", "firstName", document.getElementById("fn")!),
      entry("2", "lastName", document.getElementById("ln")!),
      entry("3", "email", document.getElementById("em")!),
      entry("4", "unknown", document.getElementById("switcher")!),
    ];
    expect(resolveFormScope(entries)?.id).toBe("app");
  });

  it("picks the deepest candidate holding >= 80% of recognized fields", () => {
    // main wraps everything; the inner form holds 4 of 5 recognized (80%).
    document.body.innerHTML = `
      <main id="m">
        <input id="stray" />
        <form id="app"><input id="a"/><input id="b"/><input id="c"/><input id="d"/></form>
      </main>`;
    const entries = [
      entry("1", "firstName", document.getElementById("a")!),
      entry("2", "lastName", document.getElementById("b")!),
      entry("3", "email", document.getElementById("c")!),
      entry("4", "phone", document.getElementById("d")!),
      entry("5", "location", document.getElementById("stray")!),
    ];
    expect(resolveFormScope(entries)?.id).toBe("app");
  });

  it("falls back to the LCA when there is no <form> or main", () => {
    document.body.innerHTML = `
      <div><div id="wrap">
        <div><input id="a" /></div><div><input id="b" /></div>
      </div></div>
      <div id="outside"><input id="x" type="email" /></div>`;
    const entries = [
      entry("1", "firstName", document.getElementById("a")!),
      entry("2", "lastName", document.getElementById("b")!),
      entry("3", "unknown", document.getElementById("x")!),
    ];
    // LCA of the two recognized fields is #wrap (body/html are never candidates).
    expect(resolveFormScope(entries)?.id).toBe("wrap");
  });

  it("returns null when fields scatter with no qualifying container", () => {
    // Two recognized fields whose LCA is <body> (excluded), no form/main.
    document.body.innerHTML = `<div><input id="a" /></div><div><input id="b" /></div>`;
    const entries = [
      entry("1", "firstName", document.getElementById("a")!),
      entry("2", "lastName", document.getElementById("b")!),
    ];
    expect(resolveFormScope(entries)).toBeNull();
  });

  it("returns null with fewer than 2 recognized fields", () => {
    document.body.innerHTML = `<form id="f"><input id="a" /></form>`;
    expect(resolveFormScope([entry("1", "email", document.getElementById("a")!)])).toBeNull();
  });

  it("keeps a shadow-hosted field inside the scope (composed containment)", () => {
    document.body.innerHTML = `<form id="app"><input id="a"/><input id="b"/><div id="host"></div></form>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const shadowInput = document.createElement("input");
    root.appendChild(shadowInput);
    const entries = [
      entry("1", "firstName", document.getElementById("a")!),
      entry("2", "lastName", document.getElementById("b")!),
      entry("3", "phone", shadowInput),
    ];
    const scope = resolveFormScope(entries)!;
    expect(scope.id).toBe("app");
    expect(filterToScope(entries, scope).map((e) => e.field.id)).toEqual(["1", "2", "3"]);
  });

  it("filterToScope drops entries outside the scope regardless of category", () => {
    // 4 of 5 recognized inside the form = exactly 80% — the form qualifies and
    // the recognized-but-outside newsletter email is dropped with it.
    document.body.innerHTML = `
      <form id="app"><input id="a"/><input id="b"/><input id="c"/><input id="d"/></form>
      <div id="newsletter"><input id="nl" type="email" /></div>`;
    const entries = [
      entry("1", "firstName", document.getElementById("a")!),
      entry("2", "lastName", document.getElementById("b")!),
      entry("3", "phone", document.getElementById("c")!),
      entry("4", "location", document.getElementById("d")!),
      entry("5", "email", document.getElementById("nl")!), // recognized but outside
    ];
    const scope = resolveFormScope(entries)!;
    expect(scope.id).toBe("app");
    expect(filterToScope(entries, scope).map((e) => e.field.id)).toEqual(["1", "2", "3", "4"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/formScope.test.ts`
Expected: FAIL — cannot resolve `../src/content/formScope`.

- [ ] **Step 3: Write the implementation**

Create `chrome-extension/src/content/formScope.ts`:

```ts
/**
 * Application-form scoping. scanPage sweeps the whole document, so beyond page
 * chrome (pageChrome.ts) stray controls — footer newsletter signups, sidebar
 * widgets — still surface. This module finds THE application-form container and
 * callers drop fields outside it.
 *
 * Candidates: every <form> holding a recognized field, main/[role=main], and
 * the lowest common ancestor of all recognized fields. Winner: the DEEPEST
 * candidate containing >= 80% of recognized fields. No qualifying candidate →
 * null, and callers keep the unscoped result (scoping only ever narrows).
 */
import type { DetectedField } from "../shared/types";
import { composedAncestors } from "./pageChrome";

export interface ScopeEntry {
  field: DetectedField;
  /** The control's live element (first member for radio/checkbox groups). */
  el: HTMLElement;
}

const SCOPE_SHARE = 0.8;

export function resolveFormScope(entries: ScopeEntry[]): HTMLElement | null {
  const recognized = entries.filter((e) => e.field.category !== "unknown");
  if (recognized.length < 2) return null; // one field can't outline a form

  // Scope within the document owning the most recognized fields (deepQueryAll
  // may pull fields from same-origin iframes; containment never crosses docs).
  const byDoc = new Map<Document, ScopeEntry[]>();
  for (const e of recognized) {
    const doc = e.el.ownerDocument;
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), e]);
  }
  let home: ScopeEntry[] = [];
  for (const list of byDoc.values()) if (list.length > home.length) home = list;
  if (home.length < 2) return null;
  const doc = home[0].el.ownerDocument;

  const candidates = new Set<HTMLElement>();
  for (const e of home) {
    const form = e.el.closest("form");
    if (form) candidates.add(form as HTMLElement);
  }
  doc.querySelectorAll('main, [role="main"]').forEach((m) => candidates.add(m as HTMLElement));
  const lca = lowestCommonAncestor(home.map((e) => e.el));
  if (lca && lca !== doc.documentElement && lca !== doc.body) candidates.add(lca);
  candidates.delete(doc.documentElement);
  if (doc.body) candidates.delete(doc.body);

  const needed = Math.ceil(home.length * SCOPE_SHARE);
  let best: { el: HTMLElement; depth: number } | null = null;
  for (const c of candidates) {
    const inside = home.filter((e) => composedContains(c, e.el)).length;
    if (inside < needed) continue;
    const depth = composedAncestors(c).length;
    if (!best || depth > best.depth) best = { el: c, depth };
  }
  return best?.el ?? null;
}

/** Entries kept under `scope` — outside entries are dropped whatever their
 *  category (a footer newsletter email is noise even though "email" is known). */
export function filterToScope(entries: ScopeEntry[], scope: HTMLElement): ScopeEntry[] {
  return entries.filter((e) => composedContains(scope, e.el));
}

/** contains() that also pierces open shadow roots (Node.contains does not). */
function composedContains(container: HTMLElement, el: HTMLElement): boolean {
  if (container === el || container.contains(el)) return true;
  return composedAncestors(el).includes(container);
}

/** LCA across the composed tree (shadow-piercing), or null. */
function lowestCommonAncestor(els: HTMLElement[]): HTMLElement | null {
  if (els.length === 0) return null;
  const first: HTMLElement[] = [els[0], ...composedAncestors(els[0])];
  const rest = els.slice(1).map((el) => new Set<HTMLElement>([el, ...composedAncestors(el)]));
  for (const node of first) {
    if (rest.every((s) => s.has(node))) return node;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/formScope.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/formScope.ts chrome-extension/test/formScope.test.ts
git commit -m "feat(autofill): form-container scope resolution (80% rule + LCA)"
```

### Task 3: Wire scoping into the scanner

**Files:**
- Modify: `chrome-extension/src/content/formScanner.ts`
- Modify: `chrome-extension/src/content/contentScript.ts` (store `lastScope`)
- Test: `chrome-extension/test/scanScope.test.ts`

**Interfaces:**
- Consumes: `isInPageChrome` (Task 1), `resolveFormScope`/`filterToScope`/`ScopeEntry` (Task 2).
- Produces: `ScanResult` gains `scopeEl: HTMLElement | null`; `contentScript.ts` gains module-level `let lastScope: HTMLElement | null` updated by `runScan()`. Also exports the previously-private `selectOptions(el: HTMLSelectElement): string[]` from formScanner (Phase 2 uses it).

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/scanScope.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("scanPage — chrome exclusion + form scoping", () => {
  it("never surfaces a header language switcher", () => {
    document.body.innerHTML = `
      <header>
        <select id="lang" aria-label="Language"><option>EN</option><option>FR</option></select>
      </header>
      <form>
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
      </form>`;
    const { fields, scopeEl } = scanPage(null, false);
    expect(fields.some((f) => f.label.toLowerCase().includes("language"))).toBe(false);
    expect(fields).toHaveLength(3);
    expect(scopeEl?.tagName).toBe("FORM");
  });

  it("drops an out-of-form newsletter email once a scope is found", () => {
    // 4 recognized fields in the form; the newsletter email is a 5th
    // recognized control outside it — 4/5 = 80%, so the form qualifies as the
    // scope and the newsletter is dropped despite its known category.
    document.body.innerHTML = `
      <form>
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
        <label>Phone <input type="tel" name="phone" /></label>
      </form>
      <div class="newsletter"><input type="email" name="newsletter_email" aria-label="Newsletter email" /></div>`;
    const { fields, registry } = scanPage(null, false);
    expect(fields).toHaveLength(4);
    // Registry is pruned in lockstep with fields.
    expect(registry.size).toBe(4);
  });

  it("keeps today's behavior when no scope container qualifies (fallback)", () => {
    document.body.innerHTML = `
      <div><label>First name <input name="first_name" /></label></div>
      <div><label>Email <input type="email" name="email" /></label></div>`;
    // LCA is <body> (excluded) and there is no form/main → unscoped result.
    const { fields, scopeEl } = scanPage(null, false);
    expect(fields).toHaveLength(2);
    expect(scopeEl).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/scanScope.test.ts`
Expected: FAIL — `scanPage(...)` result has no `scopeEl` property (TS error), and the language switcher currently appears in `fields`.

- [ ] **Step 3: Modify `formScanner.ts`**

3a. Add imports (after the `consent` import at `formScanner.ts:25`):

```ts
import { isInPageChrome } from "./pageChrome";
import { filterToScope, resolveFormScope, type ScopeEntry } from "./formScope";
```

3b. Extend `ScanResult` (currently at `formScanner.ts:48-52`):

```ts
export interface ScanResult {
  fields: DetectedField[];
  registry: Map<string, RuntimeControl>;
  adapter: SiteAdapter | null;
  /** The resolved application-form container, or null when scoping fell back. */
  scopeEl: HTMLElement | null;
}
```

3c. In the candidate loop, directly after `if (isConsentField(el)) continue;` (line ~232), add:

```ts
    // Page chrome (header/nav/footer/aside and landmark roles) is never part
    // of the application form — an EN/FR switcher is a real <select> we skip.
    if (isInPageChrome(el)) continue;
```

3d. Export the select-options helper (change the private function at line ~119):

```ts
/** Options for a <select>, trimmed for transport. Exported for the Phase-2
 *  re-ask pass, which re-reads options after dependent-dropdown repopulation. */
export function selectOptions(el: HTMLSelectElement): string[] {
```

3e. Replace the final `return { fields, registry, adapter };` of `scanPage` (line ~371) with:

```ts
  // Scope to the application-form container; anything outside is noise even
  // when its category is known. No qualifying container → unscoped fallback.
  const entries: ScopeEntry[] = fields.flatMap((f) => {
    const c = registry.get(f.id);
    const el = c?.el ?? c?.radios?.[0] ?? c?.checkboxes?.[0];
    return el ? [{ field: f, el }] : [];
  });
  const scopeEl = resolveFormScope(entries);
  if (!scopeEl) return { fields, registry, adapter, scopeEl: null };
  const keep = new Set(filterToScope(entries, scopeEl).map((e) => e.field.id));
  const scoped = fields.filter((f) => keep.has(f.id));
  for (const f of fields) if (!keep.has(f.id)) registry.delete(f.id);
  return { fields: scoped, registry, adapter, scopeEl };
```

- [ ] **Step 4: Modify `contentScript.ts` to remember the scope**

4a. Next to the existing state declarations (`let lastAdapter: SiteAdapter | null = null;` at `contentScript.ts:136`), add:

```ts
  let lastScope: HTMLElement | null = null;
```

4b. In `runScan()` (line ~182), after `lastFields = result.fields;`, add:

```ts
    lastScope = result.scopeEl;
```

(`lastScope` is consumed by Phase 3; declaring it now keeps this task's diff self-contained. If `tsc` flags it as unused, prefix the declaration with `// eslint-disable-line` is NOT needed — TS doesn't error on unused module-scope lets; leave it.)

- [ ] **Step 5: Run the new test and the existing scanner suites**

Run: `node node_modules/vitest/vitest.mjs run test/scanScope.test.ts test/formScanner.test.ts test/checkboxGroup.test.ts test/scanPageAdapter.test.ts test/ariaRadioGroup.test.ts`
Expected: ALL PASS. If an existing scanner test breaks, it is because its fixture's fields now resolve a scope that excludes some control — fix the FIXTURE by wrapping its controls in one `<form>` (the scanner behavior is correct); do not weaken the scoping rule.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/src/content/contentScript.ts chrome-extension/test/scanScope.test.ts
git commit -m "feat(autofill): scope scanning to the application form container"
```

# Phase 2 — Option-aware dropdowns

### Task 4: Shared-prefix tier in `matchOption`

**Files:**
- Modify: `chrome-extension/src/content/writeEngine.ts` (the token-overlap tier of `matchOption`, lines ~244-255)
- Test: `chrome-extension/test/writeEngine.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `matchOption<T>(items, getText, getValue, target)`.
- Produces: same signature; token overlap now also counts tokens sharing a `>= 5`-char prefix ("canada" ↔ "canadian").

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/writeEngine.test.ts`:

```ts
import { matchOption } from "../src/content/writeEngine";

describe("matchOption — shared-prefix tier", () => {
  const id = (s: string): string => s;

  it('matches "Canada" to "Canadian" (morphological near-miss)', () => {
    expect(matchOption(["American", "Canadian", "Other"], id, id, "Canada")).toBe("Canadian");
  });

  it('matches "Canadien" (FR) to "Canadian"', () => {
    expect(matchOption(["American", "Canadian"], id, id, "Canadien")).toBe("Canadian");
  });

  it("ranks by overlap so United States beats United Kingdom for a US answer", () => {
    expect(
      matchOption(["United Kingdom", "United States"], id, id, "United States of America")
    ).toBe("United States");
  });

  it("does not match on short shared prefixes", () => {
    // "cat" vs "category": shared prefix 3 < 5 — no match.
    expect(matchOption(["category"], id, id, "cat")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/writeEngine.test.ts`
Expected: FAIL — the "Canada"→"Canadian" and "Canadien" cases return `null`.
(Note: the United-States case may already pass via the substring tier — that is fine; it pins ranking behavior.)

- [ ] **Step 3: Implement**

In `writeEngine.ts`, replace the final token-overlap block of `matchOption` (currently lines 244-255):

```ts
  const targetTokens = t.split(" ").filter((w) => w.length > 2);
  const targetSet = new Set(targetTokens);
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const tokens = normalize(getText(item))
      .split(" ")
      .filter((w) => w.length > 2);
    if (tokens.length === 0) continue;
    // A token overlaps on equality OR a >=5-char shared prefix ("canada" ↔
    // "canadian") — AI answers often use a morphological variant of the option.
    const overlap = tokens.filter(
      (w) => targetSet.has(w) || targetTokens.some((tw) => sharedPrefixLen(w, tw) >= 5)
    ).length;
    const score = overlap / tokens.length;
    if (overlap > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best ? best.item : null;
}

/** Length of the common leading substring of two tokens. */
function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
```

(The closing `}` of `matchOption` moves above `sharedPrefixLen` as shown.)

- [ ] **Step 4: Run the full write-engine + combobox suites**

Run: `node node_modules/vitest/vitest.mjs run test/writeEngine.test.ts test/comboboxEngine.test.ts test/reconciler.test.ts`
Expected: ALL PASS (existing option-matching cases must not regress).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/writeEngine.ts chrome-extension/test/writeEngine.test.ts
git commit -m "feat(autofill): shared-prefix token tier in matchOption"
```

### Task 5: Backend `_match_option` parity tier

**Files:**
- Modify: `backend/routers/fill.py` (function `_match_option`, line ~265)
- Test: Create `backend/tests/test_match_option.py`

**Interfaces:**
- Consumes/Produces: `_match_option(answer: str, options: list[str]) -> str | None` — same signature, one added tier before `return None`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_match_option.py`:

```python
"""Pure-function tests for the answer→option snapper (no DB, no client)."""
from backend.routers.fill import _match_option


def test_exact_and_substring_still_win():
    assert _match_option("Canadian", ["American", "Canadian"]) == "Canadian"
    assert _match_option("No", ["Yes", "No, I do not require sponsorship"]).startswith("No")


def test_shared_prefix_tier_matches_morphological_variant():
    assert _match_option("Canada", ["American", "Canadian", "Other"]) == "Canadian"
    assert _match_option("Canadien", ["American", "Canadian"]) == "Canadian"


def test_short_prefixes_do_not_match():
    assert _match_option("cat", ["category"]) is None


def test_no_options_returns_none():
    assert _match_option("anything", []) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run (repo root): `python -m pytest backend/tests/test_match_option.py -v`
Expected: `test_shared_prefix_tier_matches_morphological_variant` FAILS (returns `None`); the others pass.

- [ ] **Step 3: Implement**

In `backend/routers/fill.py`, inside `_match_option`, REPLACE the final `return None` (after the numeric-range block) with this block — note it ends with its own `return None`, and `_shared_prefix_len` is a new module-level function:

```python
    # Morphological near-miss: a >=5-char shared token prefix ("canada" ↔
    # "canadian"). Mirrors the extension's matchOption tier (writeEngine.ts).
    answer_tokens = [w for w in re.split(r"[^a-z0-9]+", a) if len(w) > 2]
    best: tuple[str, float] | None = None
    for opt in options:
        tokens = [w for w in re.split(r"[^a-z0-9]+", opt.lower()) if len(w) > 2]
        if not tokens:
            continue
        overlap = sum(
            1 for w in tokens
            if any(_shared_prefix_len(w, t) >= 5 or w == t for t in answer_tokens)
        )
        if overlap:
            score = overlap / len(tokens)
            if best is None or score > best[1]:
                best = (opt, score)
    if best:
        return best[0]
    return None


def _shared_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i
```

(`re` is already imported in fill.py — it is used by `_parse_range`. Verify with a grep; add `import re` at the top if not.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_match_option.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/fill.py backend/tests/test_match_option.py
git commit -m "feat(fill): shared-prefix tier in backend option snapping"
```

### Task 6: Combobox harvests real options on a miss

**Files:**
- Modify: `chrome-extension/src/content/comboboxEngine.ts`
- Test: `chrome-extension/test/comboboxEngine.test.ts` (append)

**Interfaces:**
- Consumes: existing `fillAriaCombobox(trigger, value, opts)`.
- Produces:
  - `ComboboxResult` gains `options?: string[]` — populated ONLY on the no-match failure, with the open listbox's real option labels (cap 60).
  - New export `activateElement(el: HTMLElement): void` (the existing private `activate`, renamed export) — Phase 3's advance click uses it.

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/comboboxEngine.test.ts` (this file already has fixture helpers for comboboxes with mounted listboxes; reuse its existing pattern of building a trigger+listbox — copy the local helper if one exists, otherwise use this self-contained fixture):

```ts
function citizenshipCombobox(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "lb-cit");
  const lb = document.createElement("div");
  lb.id = "lb-cit";
  lb.setAttribute("role", "listbox");
  for (const label of ["Canadian", "American", "Other"]) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    o.addEventListener("click", () => {
      input.value = label;
      input.setAttribute("aria-expanded", "false");
    });
    lb.append(o);
  }
  input.addEventListener("click", () => input.setAttribute("aria-expanded", "true"));
  wrap.append(input, lb);
  document.body.append(wrap);
  return input;
}

const fast = { sleep: async (): Promise<void> => {}, openWaitMs: 100, commitWaitMs: 100, pollMs: 10 };

describe("fillAriaCombobox — option harvest on miss", () => {
  it("returns the real options when no option matches the value", async () => {
    const trigger = citizenshipCombobox();
    const res = await fillAriaCombobox(trigger, "Netherlands", fast);
    expect(res.filled).toBe(false);
    expect(res.options).toEqual(["Canadian", "American", "Other"]);
  });

  it("still fills when the (snapped) answer matches, and returns no options", async () => {
    const trigger = citizenshipCombobox();
    const res = await fillAriaCombobox(trigger, "Canadian", fast);
    expect(res.filled).toBe(true);
    expect(res.options).toBeUndefined();
  });
});
```

Note: after Task 4, `matchOption` resolves "Canada"→"Canadian" locally, so the miss fixture uses "Netherlands" (shares no ≥5 prefix with any option).

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/comboboxEngine.test.ts`
Expected: FAIL — `res.options` is `undefined` on the miss case.

- [ ] **Step 3: Implement**

3a. In `comboboxEngine.ts`, extend the result interface (lines 18-21):

```ts
export interface ComboboxResult {
  filled: boolean;
  reason?: string;
  /** On a no-match failure: the open listbox's REAL option labels, harvested
   *  for the one-shot AI re-ask pass (contentScript). */
  options?: string[];
}
```

3b. Replace the no-match branch inside `fillAriaCombobox` (lines 87-90):

```ts
  const option = findOption(listbox, value);
  if (!option) {
    const options = optionLabels(listbox);
    close(trigger);
    return {
      filled: false,
      reason: `No option matches "${truncate(value)}" — select it manually`,
      options,
    };
  }
```

3c. Extract the shared label reader and reuse it in `readComboboxOptions` (which currently duplicates the logic, lines 221-230):

```ts
/** Non-disabled option labels of a listbox, trimmed for transport (cap 60). */
function optionLabels(listbox: HTMLElement): string[] | undefined {
  const labels = deepQueryAll(listbox, '[role="option"]')
    .filter((o) => o.getAttribute("aria-disabled") !== "true")
    .map((o) => optionText(o))
    .filter((t) => t.length > 0)
    .slice(0, 60);
  return labels.length > 0 ? labels : undefined;
}

export function readComboboxOptions(trigger: HTMLElement): string[] | undefined {
  const listbox = findMountedListbox(trigger);
  if (!listbox) return undefined;
  return optionLabels(listbox);
}
```

(Keep the existing doc comment above `readComboboxOptions`.)

3d. Export the activation primitive for Phase 3 (rename the private `activate`, lines 115-122, and update its call sites — `activate(trigger)` in `open()` and `activate(option)` in `clickOption()`):

```ts
/** A realistic activation sequence: pointer + mouse + click. Exported for the
 *  flow controller's advance-button click (advance.ts). */
export function activateElement(el: HTMLElement): void {
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node node_modules/vitest/vitest.mjs run test/comboboxEngine.test.ts test/formScanner.test.ts` then `npx tsc -p tsconfig.json --noEmit`
Expected: ALL PASS; no tsc output.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/comboboxEngine.ts chrome-extension/test/comboboxEngine.test.ts
git commit -m "feat(autofill): harvest real dropdown options on fill miss"
```

### Task 7: One batched re-ask round per autofill pass

**Files:**
- Modify: `chrome-extension/src/content/aiFillPlanner.ts` (add `planReaskFields`)
- Modify: `chrome-extension/src/content/contentScript.ts` (collect misses, one `AI_FILL`, merge-fill)
- Test: `chrome-extension/test/aiFillPlanner.test.ts` (append)

**Interfaces:**
- Consumes: `ComboboxResult.options` (Task 6), `selectOptions` export (Task 3), `AiFillField`/`AiFillResponse` from shared types, `cacheAnswers` from `./answerCache`, `planAiFill` from `./aiFillPlanner`.
- Produces:
  - `interface ReaskCandidate { fieldId: string; options: string[] }` and `planReaskFields(fields: DetectedField[], candidates: ReaskCandidate[]): AiFillField[]` in aiFillPlanner.
  - `fillItems(...)` return type becomes `{ reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }` — Phase 3's `fillOnce` relies on this exact shape.

- [ ] **Step 1: Write the failing planner test**

Append to `chrome-extension/test/aiFillPlanner.test.ts`:

```ts
import { planReaskFields, type ReaskCandidate } from "../src/content/aiFillPlanner";

describe("planReaskFields", () => {
  const base = {
    confidence: 0.9, controlType: "combobox" as const, required: true,
    proposedValue: null, fillable: true, sensitive: false,
  };

  it("builds select-typed AI fields carrying the harvested options", () => {
    const fields = [{ ...base, id: "f1", category: "unknown" as const, label: "Citizenship" }];
    const out = planReaskFields(fields, [{ fieldId: "f1", options: ["Canadian", "American"] }]);
    expect(out).toEqual([
      { id: "f1", label: "Citizenship", type: "select", options: ["Canadian", "American"], required: true },
    ]);
  });

  it("skips sensitive fields and empty option lists", () => {
    const fields = [
      { ...base, id: "s1", category: "eeoGender" as const, label: "Gender", sensitive: true },
      { ...base, id: "f2", category: "unknown" as const, label: "State" },
    ];
    const out = planReaskFields(fields, [
      { fieldId: "s1", options: ["Male", "Female"] },
      { fieldId: "f2", options: [] },
      { fieldId: "missing", options: ["X"] },
    ]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/aiFillPlanner.test.ts`
Expected: FAIL — `planReaskFields` is not exported.

- [ ] **Step 3: Implement `planReaskFields`**

Append to `chrome-extension/src/content/aiFillPlanner.ts`:

```ts
/** A choice control whose fill missed, plus the REAL options harvested from
 *  the live widget — input to the one-shot re-ask round. */
export interface ReaskCandidate {
  fieldId: string;
  options: string[];
}

/**
 * Build the backend fields for the re-ask round: same question, but now
 * carrying the widget's actual options so the backend snaps the answer to one
 * of them ("Canada" → "Canadian"). Sensitive fields never reach the backend.
 */
export function planReaskFields(
  fields: DetectedField[],
  candidates: ReaskCandidate[]
): AiFillField[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: AiFillField[] = [];
  for (const c of candidates) {
    const f = byId.get(c.fieldId);
    if (!f || f.sensitive || c.options.length === 0) continue;
    out.push({
      id: c.fieldId,
      label: f.label,
      type: "select",
      options: c.options.slice(0, 60),
      required: f.required,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run planner test**

Run: `node node_modules/vitest/vitest.mjs run test/aiFillPlanner.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire collection + the re-ask round into `contentScript.ts`**

5a. Extend imports: add `planReaskFields, type ReaskCandidate` to the `./aiFillPlanner` import (line ~51); add `selectOptions` to the `./formScanner` import (line ~46).

5b. Replace `fillComboboxTargets` (lines 208-222) so failures carry harvested options:

```ts
  async function fillComboboxTargets(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      const el = registry.get(t.fieldId)?.el;
      if (!el) {
        outcomes.push({ fieldId: t.fieldId, ok: false });
        continue;
      }
      const res = await fillAriaCombobox(el, t.value);
      outcomes.push({ fieldId: t.fieldId, ok: res.filled });
      if (!res.filled && res.options) reask.push({ fieldId: t.fieldId, options: res.options });
    }
    return { outcomes, reask };
  }
```

5c. Replace `fillDriverTargets` (lines 225-236) — on driver failure, fall back to the ARIA path (which may fill outright or harvest options):

```ts
  async function fillDriverTargets(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      const control = registry.get(t.fieldId);
      if (!control?.driver) { outcomes.push({ fieldId: t.fieldId, ok: false }); continue; }
      const res = await driveField(t.fieldId, t.value, control.driver);
      if (res.ok || !control.el) {
        outcomes.push({ fieldId: t.fieldId, ok: res.ok });
        continue;
      }
      // Driver miss — best-effort ARIA fallback: may fill, or harvest options.
      const fb = await fillAriaCombobox(control.el, t.value);
      outcomes.push({ fieldId: t.fieldId, ok: fb.filled });
      if (!fb.filled && fb.options) reask.push({ fieldId: t.fieldId, options: fb.options });
    }
    return { outcomes, reask };
  }
```

5d. Replace `fillItems` (lines 262-285) to aggregate `reask` from combobox/driver paths AND from select-control reconciler misses (fresh re-read covers dependent dropdowns):

```ts
  async function fillItems(
    items: { fieldId: string; value: string }[],
    merge: boolean
  ): Promise<{ reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    if (items.length === 0 && merge) return { reports: [], outcomes: [], reask: [] };
    const { opOutcomes, remaining } = await runAdapterOperations(lastAdapter, items, (id) => registry.get(id));
    const driverTargets = remaining.filter((it) => isDriverField(it.fieldId));
    const comboTargets = remaining.filter((it) => !isDriverField(it.fieldId) && isComboboxField(it.fieldId));
    const reconTargets = remaining.filter((it) => !isDriverField(it.fieldId) && !isComboboxField(it.fieldId));
    const reports = merge
      ? reconTargets.length
        ? await getEngine().addTargets(reconTargets, registry)
        : []
      : await getEngine().run(reconTargets, registry);
    const combo = comboTargets.length
      ? await fillComboboxTargets(comboTargets)
      : { outcomes: [], reask: [] };
    const driver = driverTargets.length
      ? await fillDriverTargets(driverTargets)
      : { outcomes: [], reask: [] };
    // A <select> that failed on "No option matches" re-reads its options fresh
    // (dependent dropdowns — Country → State — repopulate after earlier fills).
    const reask: ReaskCandidate[] = [...combo.reask, ...driver.reask];
    for (const r of reports) {
      if (r.ok || !r.reason?.startsWith("No option matches")) continue;
      const control = registry.get(r.fieldId);
      if (control?.controlType === "select" && control.el?.isConnected) {
        const options = selectOptions(control.el as HTMLSelectElement);
        if (options.length > 0) reask.push({ fieldId: r.fieldId, options });
      }
    }
    return { reports, outcomes: [...combo.outcomes, ...driver.outcomes, ...opOutcomes], reask };
  }
```

5e. In `onAutofill` (lines 288-349), first extend the two local declarations for `aiFill` and `fallbackFill` (lines ~304-305) so their type and initializer include the new member:

```ts
      let aiFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      let fallbackFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
```

Then, after the `fallbackFill` block and before `tallyOutcomes`, add the single re-ask round; extend the tally call:

```ts
      // One re-ask round: choice controls whose fill missed now carry the
      // widget's REAL options — a single batched AI_FILL snaps the answers
      // ("Canada" → "Canadian"), then a merge pass drives them in.
      let reaskFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      const reaskCandidates = [...localFill.reask, ...aiFill.reask, ...fallbackFill.reask];
      if (reaskCandidates.length > 0) {
        for (const c of reaskCandidates) {
          const f = lastFields.find((x) => x.id === c.fieldId);
          if (f) f.options = c.options; // panel now shows the real choices
        }
        const reaskFields = planReaskFields(lastFields, reaskCandidates);
        if (reaskFields.length > 0) {
          try {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: reaskFields,
              jobContext: extractJobContext(),
            });
            if (resp?.ok) {
              const affected = lastFields.filter((f) => reaskFields.some((r) => r.id === f.id));
              cacheAnswers(affected, resp.answers); // overwrite the unconstrained answers
              const plan = planAiFill(affected, resp.answers);
              drafts.push(...plan.drafts);
              reaskFill = await fillItems(plan.simpleTargets, true);
            }
          } catch {
            // Backend unreachable — the manual-select outcomes stand.
          }
        }
      }

      const { ok, fail, total } = tallyOutcomes(
        localFill.reports,
        aiFill.reports,
        fallbackFill.reports,
        reaskFill.reports,
        localFill.outcomes,
        aiFill.outcomes,
        fallbackFill.outcomes,
        reaskFill.outcomes
      );
      return { ok, fail, total, drafts };
```

(Delete the old `tallyOutcomes` call this replaces. `reaskFill.reask` is deliberately ignored — exactly one round.)

- [ ] **Step 6: Run the full extension suite + typecheck**

Run: `node node_modules/vitest/vitest.mjs run` then `npx tsc -p tsconfig.json --noEmit`
Expected: ALL PASS (the `helpers/autofill.ts` runner does not use `fillItems`, so no helper changes); no tsc output.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/aiFillPlanner.ts chrome-extension/src/content/contentScript.ts chrome-extension/test/aiFillPlanner.test.ts
git commit -m "feat(autofill): one batched AI re-ask with harvested dropdown options"
```

# Phase 3 — Multi-page flow controller

### Task 8: Flow types, messages, and per-tab session persistence

**Files:**
- Modify: `chrome-extension/src/shared/types.ts`
- Modify: `chrome-extension/src/content/crossFrame.ts` (ALL_OPS / VOID_OPS)
- Create: `chrome-extension/src/background/flowState.ts`
- Modify: `chrome-extension/src/background/serviceWorker.ts`
- Test: `chrome-extension/test/flowState.test.ts`; check `chrome-extension/test/crossFrame.test.ts` still passes

**Interfaces:**
- Produces (used by Tasks 9-13):
  - `FlowState { active: boolean; step: number; startedAt: number; lastSignature: string }`
  - `FlowPauseReason = "captcha" | "drafts" | "resume-upload" | "validation" | "account" | "verification"`
  - `FlowPhase = "filling" | "advancing" | "paused" | "done" | "stopped"`
  - `FlowProgress { phase: FlowPhase; step: number; filledOk: number; filledFail: number; pauseReason?: FlowPauseReason; detail?: string; drafts?: AiDraft[] }`
  - Background messages `{ type: "FLOW_STATE_GET" }` → `FlowStateResponse { ok: boolean; state?: FlowState | null }` and `{ type: "FLOW_STATE_SET"; state: FlowState | null }` → `SimpleResponse`
  - Relay payload `RemoteFlowProgress { type: "REMOTE_FLOW_PROGRESS"; progress: FlowProgress }`
  - `FormOpName` gains `"onFlowStop"` and `"onFlowResume"` (both void ops)
  - `getFlowState(tabId): Promise<FlowState | null>` / `setFlowState(tabId, state): Promise<void>` / `watchTabRemoval(): void` from `background/flowState.ts`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/flowState.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getFlowState, setFlowState } from "../src/background/flowState";
import type { FlowState } from "../src/shared/types";

/** Minimal chrome.storage.session mock (get(key) → { key: value }). */
function mockSessionStorage(): Record<string, unknown> {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: mem[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(mem, obj);
        },
      },
    },
    tabs: { onRemoved: { addListener: (): void => {} } },
  };
  return mem;
}

const state: FlowState = { active: true, step: 2, startedAt: 123, lastSignature: "3:abc" };

describe("flowState", () => {
  beforeEach(() => {
    mockSessionStorage();
  });

  it("round-trips a per-tab state", async () => {
    await setFlowState(7, state);
    expect(await getFlowState(7)).toEqual(state);
    expect(await getFlowState(8)).toBeNull();
  });

  it("clears a tab's state with null and leaves other tabs alone", async () => {
    await setFlowState(7, state);
    await setFlowState(9, { ...state, step: 0 });
    await setFlowState(7, null);
    expect(await getFlowState(7)).toBeNull();
    expect((await getFlowState(9))?.step).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/flowState.test.ts`
Expected: FAIL — cannot resolve `../src/background/flowState`.

- [ ] **Step 3: Add the shared types**

3a. In `chrome-extension/src/shared/types.ts`, insert a new section after the `AiDraft` interface (line ~265):

```ts
// ---------------------------------------------------------------------------
// Multi-page autofill flow
// ---------------------------------------------------------------------------

/** Why a flow is waiting on the user (all reasons auto-resume when cleared). */
export type FlowPauseReason =
  | "captcha"
  | "drafts"
  | "resume-upload"
  | "validation"
  | "account"
  | "verification";

export type FlowPhase = "filling" | "advancing" | "paused" | "done" | "stopped";

/** Persisted per-tab so a flow survives real navigations (background-owned). */
export interface FlowState {
  active: boolean;
  step: number;
  startedAt: number;
  /** fieldSignature() of the step we just advanced FROM (loop detection). */
  lastSignature: string;
}

/** One progress beat for the panel's flow status line. */
export interface FlowProgress {
  phase: FlowPhase;
  step: number;
  filledOk: number;
  filledFail: number;
  pauseReason?: FlowPauseReason;
  detail?: string;
  /** Later-step AI drafts for the panel's review section. */
  drafts?: AiDraft[];
}

/** Flow-owning frame → top-frame panel (via RELAY_TO_TOP). */
export interface RemoteFlowProgress {
  type: "REMOTE_FLOW_PROGRESS";
  progress: FlowProgress;
}

/** Background reply for FLOW_STATE_GET. */
export interface FlowStateResponse {
  ok: boolean;
  state?: FlowState | null;
}
```

3b. Extend `FormOpName` (line ~401) — add to the union:

```ts
  | "onFlowStop"
  | "onFlowResume";
```

3c. Extend `ContentRequest` (line ~346) — add `| RemoteFlowProgress` to the union.

3d. Extend `RelayToTop.payload` (line ~463):

```ts
  payload: RemoteFormAvailable | RemoteFieldsUpdated | RemoteFlowProgress;
```

3e. Extend `BackgroundRequest` (line ~476) — add before `| FormHostAnnounce`:

```ts
  | { type: "FLOW_STATE_GET" }
  | { type: "FLOW_STATE_SET"; state: FlowState | null }
```

- [ ] **Step 4: Update crossFrame op tables**

In `chrome-extension/src/content/crossFrame.ts`:
- Add `"onFlowStop", "onFlowResume"` to `ALL_OPS` (line ~16, end of the array).
- Change `VOID_OPS` (line ~13) to:

```ts
const VOID_OPS: ReadonlySet<FormOpName> = new Set<FormOpName>([
  "onRescan",
  "onProfileResolved",
  "onFlowStop",
  "onFlowResume",
]);
```

- [ ] **Step 5: Create `background/flowState.ts`**

```ts
/**
 * Per-tab multi-page flow state, session-scoped so it dies with the browser.
 * The background owns it because content scripts learn their tab id only from
 * a message sender — they read/write via FLOW_STATE_GET / FLOW_STATE_SET.
 */
import type { FlowState } from "../shared/types";

const KEY = "apFlowState";

type FlowMap = Record<string, FlowState>;

async function readMap(): Promise<FlowMap> {
  const got = await chrome.storage.session.get(KEY);
  return (got?.[KEY] as FlowMap) ?? {};
}

export async function getFlowState(tabId: number): Promise<FlowState | null> {
  const map = await readMap();
  return map[String(tabId)] ?? null;
}

export async function setFlowState(tabId: number, state: FlowState | null): Promise<void> {
  const map = await readMap();
  if (state) map[String(tabId)] = state;
  else delete map[String(tabId)];
  await chrome.storage.session.set({ [KEY]: map });
}

/** Forget a tab's flow when the tab closes. Call once at background startup. */
export function watchTabRemoval(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void setFlowState(tabId, null);
  });
}
```

- [ ] **Step 6: Handle the messages in `serviceWorker.ts`**

6a. Add the import near the other local imports at the top of the file:

```ts
import { getFlowState, setFlowState, watchTabRemoval } from "./flowState";
```

6b. Immediately after the import block (module scope, near the other `chrome.*.addListener` registrations around line 59), add:

```ts
watchTabRemoval();
```

6c. Inside the `chrome.runtime.onMessage.addListener` handler, after the `RELAY_FORM_OP` block (ends line ~186) and before `INSTALL_MAIN_WORLD_DRIVER`, add:

```ts
    if (message.type === "FLOW_STATE_GET") {
      if (tabId === undefined) {
        sendResponse({ ok: false });
        return false;
      }
      void getFlowState(tabId).then((state) => sendResponse({ ok: true, state }));
      return true; // async response
    }
    if (message.type === "FLOW_STATE_SET") {
      if (tabId === undefined) {
        sendResponse({ ok: false });
        return false;
      }
      void setFlowState(tabId, message.state).then(() => sendResponse({ ok: true }));
      return true; // async response
    }
```

- [ ] **Step 7: Run tests + typecheck**

Run: `node node_modules/vitest/vitest.mjs run test/flowState.test.ts test/crossFrame.test.ts` then `npx tsc -p tsconfig.json --noEmit`
Expected: flowState PASSES. If `crossFrame.test.ts` asserts the op list, update its expected array to include `"onFlowStop", "onFlowResume"` (the proxy must generate both). No tsc output.

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/crossFrame.ts chrome-extension/src/background/flowState.ts chrome-extension/src/background/serviceWorker.ts chrome-extension/test/flowState.test.ts chrome-extension/test/crossFrame.test.ts
git commit -m "feat(autofill): flow types + per-tab session flow state"
```

### Task 9: Advance-button discovery (`advance.ts`) + Workday hook

**Files:**
- Create: `chrome-extension/src/content/advance.ts`
- Modify: `chrome-extension/src/content/adapters/types.ts` (add `advanceButton` hook)
- Modify: `chrome-extension/src/content/adapters/workday.ts` (implement it)
- Test: `chrome-extension/test/advance.test.ts`

**Interfaces:**
- Consumes: `activateElement` (Task 6), `isVisible`/`cleanText`/`deepQueryAll` from domUtils, `SiteAdapter`.
- Produces (Task 11/12 depend on):
  - `type AdvanceKind = "advance" | "terminal"`
  - `interface AdvanceButton { el: HTMLElement; kind: AdvanceKind }`
  - `findAdvanceButton(scope: HTMLElement, adapter: SiteAdapter | null, opts?: { extraAdvance?: RegExp }): AdvanceButton | null`
  - `clickAdvance(el: HTMLElement): void`
  - `SiteAdapter.advanceButton?(scope: HTMLElement): HTMLElement | null`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/advance.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { findAdvanceButton } from "../src/content/advance";
import type { SiteAdapter } from "../src/content/adapters/types";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

function scopeWith(html: string): HTMLElement {
  document.body.innerHTML = `<div id="scope">${html}</div>`;
  return document.getElementById("scope")!;
}

describe("findAdvanceButton", () => {
  it("finds EN advance buttons (Next / Save & Continue)", () => {
    for (const label of ["Next", "Save & Continue", "Save and Continue", "Continue", "Next Step", "Review"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      const hit = findAdvanceButton(scope, null);
      expect(hit?.kind, label).toBe("advance");
    }
  });

  it("finds FR advance buttons (Suivant / Continuer)", () => {
    for (const label of ["Suivant", "Continuer", "Poursuivre"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      expect(findAdvanceButton(scope, null)?.kind, label).toBe("advance");
    }
  });

  it("classifies submit-like buttons as terminal (EN + FR) and never as advance", () => {
    for (const label of ["Submit", "Submit application", "Send application", "Apply now", "Soumettre", "Envoyer", "Postuler", "Terminer"]) {
      const scope = scopeWith(`<button>${label}</button>`);
      expect(findAdvanceButton(scope, null)?.kind, label).toBe("terminal");
    }
  });

  it("terminal wins when both a Next and a Submit are present", () => {
    const scope = scopeWith(`<button>Next</button><button>Submit</button>`);
    expect(findAdvanceButton(scope, null)?.kind).toBe("terminal");
  });

  it("matches wall verbs only via extraAdvance", () => {
    const scope = scopeWith(`<button>Create Account</button>`);
    expect(findAdvanceButton(scope, null)).toBeNull();
    const hit = findAdvanceButton(scope, null, {
      extraAdvance: /\bcreate( an| my)? account\b/i,
    });
    expect(hit?.kind).toBe("advance");
  });

  it("ignores disabled and aria-disabled buttons", () => {
    const scope = scopeWith(`<button disabled>Next</button><button aria-disabled="true">Continue</button>`);
    expect(findAdvanceButton(scope, null)).toBeNull();
  });

  it("reads input[type=submit] values and [role=button] text", () => {
    const a = scopeWith(`<input type="submit" value="Continue" />`);
    expect(findAdvanceButton(a, null)?.kind).toBe("advance");
    const b = scopeWith(`<div role="button">Next</div>`);
    expect(findAdvanceButton(b, null)?.kind).toBe("advance");
  });

  it("adapter override wins, but its button is still terminal-checked", () => {
    const scope = scopeWith(`<button id="wd">Submit</button><button>Next</button>`);
    const adapter = {
      id: "t", match: () => true,
      advanceButton: (s: HTMLElement) => s.querySelector<HTMLElement>("#wd"),
    } as SiteAdapter;
    const hit = findAdvanceButton(scope, adapter);
    expect(hit?.el.id).toBe("wd");
    expect(hit?.kind).toBe("terminal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/advance.test.ts`
Expected: FAIL — cannot resolve `../src/content/advance`.

- [ ] **Step 3: Add the adapter hook**

In `chrome-extension/src/content/adapters/types.ts`, add to `SiteAdapter` (after `fillOperation`, line ~45):

```ts
  /** The step's advance (Next/Continue) button, when the site needs an exact
   *  selector. The generic text-based discovery runs when undefined. The
   *  returned button is still terminal-checked — a Submit is never clicked. */
  advanceButton?(scope: HTMLElement): HTMLElement | null;
```

- [ ] **Step 4: Implement `advance.ts`**

Create `chrome-extension/src/content/advance.ts`:

```ts
/**
 * Advance-button discovery for multi-page flows. The search is confined to the
 * form scope so a nav link can never be clicked. Terminal (submit-like)
 * buttons are detected but NEVER clicked — the flow stops for user review.
 */
import { cleanText, deepQueryAll, isVisible } from "./domUtils";
import { activateElement } from "./comboboxEngine";
import type { SiteAdapter } from "./adapters/types";

export type AdvanceKind = "advance" | "terminal";

export interface AdvanceButton {
  el: HTMLElement;
  kind: AdvanceKind;
}

const ADVANCE_RE =
  /\b(next( step)?|continue|save (and|&) continue|proceed|review|suivant|continuer|poursuivre|réviser)\b/i;
const TERMINAL_RE =
  /\b(submit|send application|apply now|apply|finish|complete application|soumettre|envoyer|postuler|terminer)\b/i;

const BUTTON_SELECTOR = 'button, input[type="submit"], [role="button"]';

export interface FindAdvanceOpts {
  /** Extra advance verbs (account walls: create account / sign in / …). */
  extraAdvance?: RegExp;
}

export function findAdvanceButton(
  scope: HTMLElement,
  adapter: SiteAdapter | null,
  opts: FindAdvanceOpts = {}
): AdvanceButton | null {
  const fromAdapter = adapter?.advanceButton?.(scope);
  if (fromAdapter) {
    // Workday reuses one automation-id for Next AND the final Submit — the
    // terminal check must still gate adapter-supplied buttons.
    return { el: fromAdapter, kind: TERMINAL_RE.test(buttonText(fromAdapter)) ? "terminal" : "advance" };
  }
  let advance: HTMLElement | null = null;
  for (const el of deepQueryAll(scope, BUTTON_SELECTOR)) {
    if (!isClickable(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    if (TERMINAL_RE.test(text)) return { el, kind: "terminal" }; // terminal wins
    if (!advance && (ADVANCE_RE.test(text) || opts.extraAdvance?.test(text))) advance = el;
  }
  return advance ? { el: advance, kind: "advance" } : null;
}

/** Click an advance button the way a user would (pointer + mouse + click). */
export function clickAdvance(el: HTMLElement): void {
  el.scrollIntoView?.({ block: "center" });
  activateElement(el);
}

function buttonText(el: HTMLElement): string {
  return (
    cleanText(el.getAttribute("aria-label")) ||
    cleanText(el.textContent) ||
    cleanText((el as HTMLInputElement).value ?? "")
  );
}

function isClickable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return isVisible(el);
}
```

- [ ] **Step 5: Implement the Workday override**

In `chrome-extension/src/content/adapters/workday.ts`, add to the `workdayAdapter` object (after `fillOperation`, line ~64ff — keep the existing members untouched):

```ts
  advanceButton(scope) {
    // Workday's step footer often sits OUTSIDE the fields' container — fall
    // back to the whole document when the scope doesn't hold it.
    const sel = '[data-automation-id="bottom-navigation-next-button"]';
    return (
      (scope.querySelector(sel) as HTMLElement | null) ??
      (scope.ownerDocument.querySelector(sel) as HTMLElement | null)
    );
  },
```

- [ ] **Step 6: Run tests + typecheck**

Run: `node node_modules/vitest/vitest.mjs run test/advance.test.ts test/workdayAdapter.test.ts` then `npx tsc -p tsconfig.json --noEmit`
Expected: ALL PASS; no tsc output.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/advance.ts chrome-extension/src/content/adapters/types.ts chrome-extension/src/content/adapters/workday.ts chrome-extension/test/advance.test.ts
git commit -m "feat(autofill): advance/terminal button discovery with adapter hook"
```

### Task 10: Pause-condition checks (`flowChecks.ts`)

**Files:**
- Create: `chrome-extension/src/content/flowChecks.ts`
- Test: `chrome-extension/test/flowChecks.test.ts`

**Interfaces:**
- Consumes: domUtils (`cleanText`, `deepQueryAll`, `isVisible`), `DetectedField`, `RuntimeControl`.
- Produces (Task 12's `pauseReason` dep composes these):
  - `hasUnsolvedCaptcha(doc: Document): boolean`
  - `validationMessages(scope: HTMLElement): string[]` (role=alert / aria-live=assertive texts)
  - `invalidFieldCount(scope: HTMLElement): number` (visible `[aria-invalid="true"]` — used only after a rejected advance click)
  - `resumeFieldNeedingFile(fields: DetectedField[], getControl: (id: string) => RuntimeControl | undefined): DetectedField | null`
  - `isVerificationWall(scope: HTMLElement): boolean`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/flowChecks.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  hasUnsolvedCaptcha,
  invalidFieldCount,
  isVerificationWall,
  resumeFieldNeedingFile,
  validationMessages,
} from "../src/content/flowChecks";
import type { DetectedField } from "../src/shared/types";
import type { RuntimeControl } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("hasUnsolvedCaptcha", () => {
  it("is true for a visible reCAPTCHA widget without a token", () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="x"></div>`;
    expect(hasUnsolvedCaptcha(document)).toBe(true);
  });

  it("is false once the response token is populated", () => {
    document.body.innerHTML = `
      <div class="g-recaptcha" data-sitekey="x"></div>
      <textarea name="g-recaptcha-response">tok</textarea>`;
    expect(hasUnsolvedCaptcha(document)).toBe(false);
  });

  it("is false with no captcha at all", () => {
    document.body.innerHTML = `<form><input /></form>`;
    expect(hasUnsolvedCaptcha(document)).toBe(false);
  });
});

describe("validationMessages / invalidFieldCount", () => {
  it("collects populated role=alert texts and counts aria-invalid fields", () => {
    document.body.innerHTML = `
      <div id="scope">
        <div role="alert">Email is required</div>
        <div role="alert"></div>
        <input aria-invalid="true" /><input aria-invalid="true" /><input />
      </div>`;
    const scope = document.getElementById("scope")!;
    expect(validationMessages(scope)).toEqual(["Email is required"]);
    expect(invalidFieldCount(scope)).toBe(2);
  });
});

describe("resumeFieldNeedingFile", () => {
  function fileField(id: string, required: boolean): DetectedField {
    return {
      id, category: "resumeUpload", confidence: 0.9, label: "Resume", controlType: "file",
      required, proposedValue: null, fillable: false, sensitive: false,
    };
  }

  it("returns the required empty resume field", () => {
    document.body.innerHTML = `<input type="file" id="f" />`;
    const el = document.getElementById("f") as HTMLInputElement;
    const control: RuntimeControl = { id: "1", controlType: "file", el };
    expect(resumeFieldNeedingFile([fileField("1", true)], () => control)?.id).toBe("1");
  });

  it("ignores optional resume fields", () => {
    document.body.innerHTML = `<input type="file" id="f" />`;
    const control: RuntimeControl = { id: "1", controlType: "file", el: document.getElementById("f") as HTMLInputElement };
    expect(resumeFieldNeedingFile([fileField("1", false)], () => control)).toBeNull();
  });
});

describe("isVerificationWall", () => {
  it("detects EN and FR verification prompts", () => {
    document.body.innerHTML = `<div id="s">Enter the verification code we emailed you.</div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(true);
    document.body.innerHTML = `<div id="s">Entrez le code de vérification.</div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(true);
  });

  it("is false on an ordinary form", () => {
    document.body.innerHTML = `<div id="s"><label>Email <input /></label></div>`;
    expect(isVerificationWall(document.getElementById("s")!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/flowChecks.test.ts`
Expected: FAIL — cannot resolve `../src/content/flowChecks`.

- [ ] **Step 3: Implement**

Create `chrome-extension/src/content/flowChecks.ts`:

```ts
/**
 * Pause-condition probes for the multi-page flow. Each is a cheap, read-only
 * DOM check the controller polls while paused — every reason auto-resumes the
 * moment its condition clears (the user solved the captcha, fixed the error,
 * attached the file…).
 */
import { cleanText, deepQueryAll, isVisible } from "./domUtils";
import type { DetectedField } from "../shared/types";
import type { RuntimeControl } from "./formScanner";

const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, [data-sitekey]';

/** A visible captcha widget whose response token is still empty. */
export function hasUnsolvedCaptcha(doc: Document): boolean {
  const widgets = deepQueryAll(doc, CAPTCHA_SELECTOR).filter((el) => isVisible(el));
  if (widgets.length === 0) return false;
  const token = doc.querySelector(
    'textarea[name="g-recaptcha-response"], [name="h-captcha-response"]'
  ) as HTMLTextAreaElement | null;
  return !(token && token.value);
}

/** Populated alert texts inside the scope (the page is telling the user off). */
export function validationMessages(scope: HTMLElement): string[] {
  const msgs: string[] = [];
  for (const el of deepQueryAll(scope, '[role="alert"], [aria-live="assertive"]')) {
    const t = cleanText(el.textContent);
    if (t) msgs.push(t);
  }
  return msgs.slice(0, 5);
}

/** Visible aria-invalid fields. Only meaningful AFTER a rejected advance click —
 *  many ATS pre-mark untouched required fields invalid on load. */
export function invalidFieldCount(scope: HTMLElement): number {
  return deepQueryAll(scope, '[aria-invalid="true"]').filter((el) => isVisible(el)).length;
}

/** The required résumé file field that still has no file, if any. */
export function resumeFieldNeedingFile(
  fields: DetectedField[],
  getControl: (id: string) => RuntimeControl | undefined
): DetectedField | null {
  for (const f of fields) {
    if (f.category !== "resumeUpload" || f.controlType !== "file" || !f.required) continue;
    const el = getControl(f.id)?.el as HTMLInputElement | undefined;
    if (el && (el.files?.length ?? 0) === 0) return f;
  }
  return null;
}

const VERIFICATION_RE =
  /verification code|verify your email|enter the code|check your (email|inbox)|code de v[ée]rification|v[ée]rifiez votre (courriel|adresse)/i;

/** An email-verification / OTP wall — always human-only, the flow pauses. */
export function isVerificationWall(scope: HTMLElement): boolean {
  return VERIFICATION_RE.test(cleanText(scope.textContent).slice(0, 4000));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/flowChecks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/flowChecks.ts chrome-extension/test/flowChecks.test.ts
git commit -m "feat(autofill): flow pause-condition probes"
```

### Task 11: The `FlowController` state machine

**Files:**
- Create: `chrome-extension/src/content/flowController.ts`
- Test: `chrome-extension/test/flowController.test.ts`

**Interfaces:**
- Consumes: `FlowState`, `FlowProgress`, `FlowPauseReason`, `AiDraft`, `DetectedField` (Task 8); `AdvanceButton` (Task 9).
- Produces (Task 12 implements `FlowDeps`; Task 13 calls `notifyDraftsCleared` indirectly):
  - `fieldSignature(fields: DetectedField[]): string`
  - `interface StepTally { ok: number; fail: number; total: number; drafts: AiDraft[] }`
  - `interface FlowSnapshot { fields: DetectedField[]; scopeEl: HTMLElement | null }`
  - `interface FlowDeps { fillStep(ids: string[] | null): Promise<StepTally>; snapshot(): FlowSnapshot; rescan(): void; findAdvance(scope: HTMLElement, extraAdvance?: RegExp): AdvanceButton | null; clickAdvance(el: HTMLElement): void; accountStep(snap: FlowSnapshot): Promise<{ extraAdvance?: RegExp }>; pauseReason(snap: FlowSnapshot): Promise<FlowPauseReason | null>; attachResume(): Promise<boolean>; needsResume(snap: FlowSnapshot): boolean; setState(state: FlowState | null): Promise<void>; onProgress(p: FlowProgress): void; sleep(ms: number): Promise<void>; now(): number }`
  - `class FlowController { constructor(deps: FlowDeps); run(initial: FlowState, firstTally: StepTally | null): Promise<void>; stop(): void; notifyDraftsCleared(): void }`
  - Constants `MAX_STEPS = 12`, `FLOW_TTL_MS = 10 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/flowController.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  FlowController,
  fieldSignature,
  MAX_STEPS,
  type FlowDeps,
  type FlowSnapshot,
  type StepTally,
} from "../src/content/flowController";
import type { DetectedField, FlowProgress, FlowState } from "../src/shared/types";
import type { AdvanceButton } from "../src/content/advance";

function field(id: string, label: string): DetectedField {
  return {
    id, category: "unknown", confidence: 0.5, label, controlType: "text",
    required: false, proposedValue: null, fillable: true, sensitive: false,
  };
}

const tally = (ok = 3): StepTally => ({ ok, fail: 0, total: ok, drafts: [] });
const freshState = (): FlowState => ({ active: true, step: 0, startedAt: 0, lastSignature: "" });

/** Scriptable deps: `pages` is a queue of field sets; advancing shifts it. */
function makeDeps(pages: DetectedField[][], advances: (AdvanceButton | null)[]): {
  deps: FlowDeps;
  log: string[];
  progress: FlowProgress[];
} {
  const log: string[] = [];
  const progress: FlowProgress[] = [];
  let clock = 0;
  let pageIx = 0;
  const snapshot = (): FlowSnapshot => ({
    fields: pages[Math.min(pageIx, pages.length - 1)],
    scopeEl: document.body,
  });
  const deps: FlowDeps = {
    fillStep: async (ids) => { log.push(`fill:${pageIx}:${ids ? "sel" : "auto"}`); return tally(); },
    snapshot,
    rescan: () => { log.push("rescan"); },
    findAdvance: () => advances[Math.min(pageIx, advances.length - 1)],
    clickAdvance: () => { log.push(`click:${pageIx}`); pageIx++; },
    accountStep: async () => ({}),
    pauseReason: async () => null,
    attachResume: async () => true,
    needsResume: () => false,
    setState: async (s) => { log.push(`state:${s ? s.step : "null"}`); },
    onProgress: (p) => progress.push(p),
    sleep: async () => { clock += 100; },
    now: () => clock,
  };
  return { deps, log, progress };
}

const advanceBtn = (): AdvanceButton => ({ el: document.createElement("button"), kind: "advance" });
const terminalBtn = (): AdvanceButton => ({ el: document.createElement("button"), kind: "terminal" });

describe("fieldSignature", () => {
  it("is order-independent and changes with content", () => {
    const a = [field("1", "First"), field("2", "Last")];
    const b = [field("2", "Last"), field("1", "First")];
    expect(fieldSignature(a)).toBe(fieldSignature(b));
    expect(fieldSignature(a)).not.toBe(fieldSignature([field("1", "First")]));
  });
});

describe("FlowController", () => {
  it("fills, advances through two pages, and finishes done at the terminal", async () => {
    const pages = [
      [field("1", "First name"), field("2", "Email")],
      [field("3", "Years of experience")],
    ];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    await new FlowController(deps).run(freshState(), null);
    expect(log.filter((l) => l.startsWith("fill:"))).toEqual(["fill:0:auto", "fill:1:auto"]);
    expect(log).toContain("click:0");
    expect(log[log.length - 1]).toBe("state:null"); // state cleared at the end
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("uses the provided first tally instead of re-filling step 0", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log } = makeDeps(pages, [advanceBtn(), null]);
    await new FlowController(deps).run(freshState(), tally(5));
    expect(log.filter((l) => l.startsWith("fill:"))).toEqual(["fill:1:auto"]);
  });

  it("finishes done when no advance button exists (single-page form)", async () => {
    const { deps, progress } = makeDeps([[field("1", "A")]], [null]);
    await new FlowController(deps).run(freshState(), null);
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("stops when the page never changes after an advance click (loop guard)", async () => {
    const samePage = [field("1", "A"), field("2", "B")];
    const pages = [samePage];
    const { deps, progress } = makeDeps(pages, [advanceBtn()]);
    deps.clickAdvance = (): void => {}; // click does nothing — page never changes
    await new FlowController(deps).run(freshState(), null);
    const last = progress[progress.length - 1];
    expect(last.phase).toBe("stopped");
    expect(last.detail).toMatch(/advance/i);
  });

  it("pauses on drafts and resumes via notifyDraftsCleared", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    deps.fillStep = async (): Promise<StepTally> => ({
      ok: 1, fail: 0, total: 1,
      drafts: [{ fieldId: "1", label: "A", value: "draft" }],
    });
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    // Wait until the controller reports the drafts pause.
    while (!progress.some((p) => p.pauseReason === "drafts")) await Promise.resolve();
    controller.notifyDraftsCleared();
    // Second step pauses on drafts again — clear it again to finish.
    while (progress.filter((p) => p.pauseReason === "drafts").length < 2) await Promise.resolve();
    controller.notifyDraftsCleared();
    await run;
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("stop() during a drafts pause ends the flow as stopped", async () => {
    const { deps, progress } = makeDeps([[field("1", "A")]], [advanceBtn()]);
    deps.fillStep = async (): Promise<StepTally> => ({
      ok: 0, fail: 0, total: 0,
      drafts: [{ fieldId: "1", label: "A", value: "draft" }],
    });
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.pauseReason === "drafts")) await Promise.resolve();
    controller.stop();
    await run;
    expect(progress[progress.length - 1].phase).toBe("stopped");
  });

  it("respects MAX_STEPS", async () => {
    // Endless pages: every page advances and yields a fresh field set.
    let n = 0;
    const { deps, progress } = makeDeps([[field("0", "L0")]], [advanceBtn()]);
    deps.snapshot = (): FlowSnapshot => ({ fields: [field(String(n), `L${n}`)], scopeEl: document.body });
    deps.clickAdvance = (): void => { n++; };
    await new FlowController(deps).run(freshState(), null);
    expect(progress[progress.length - 1].phase).toBe("stopped");
    expect(progress[progress.length - 1].detail).toMatch(/step limit/i);
    expect(n).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("pauses on validation after a rejected click, then retries the same step", async () => {
    const samePage = [field("1", "A")];
    const { deps, progress } = makeDeps([samePage, [field("2", "B")]], [advanceBtn(), terminalBtn()]);
    let clicks = 0;
    let errorShown = false;
    const origClick = deps.clickAdvance;
    deps.clickAdvance = (el): void => {
      clicks++;
      if (clicks === 1) { errorShown = true; return; } // first click rejected
      origClick(el);
    };
    deps.pauseReason = async (): Promise<"validation" | null> => {
      if (errorShown) { errorShown = false; return "validation"; } // clears on next poll
      return null;
    };
    await new FlowController(deps).run(freshState(), null);
    expect(clicks).toBe(2);
    expect(progress.some((p) => p.pauseReason === "validation")).toBe(true);
    expect(progress[progress.length - 1].phase).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/flowController.test.ts`
Expected: FAIL — cannot resolve `../src/content/flowController`.

- [ ] **Step 3: Implement**

Create `chrome-extension/src/content/flowController.ts`:

```ts
/**
 * Multi-page autofill flow: fill → advance → fill → … → done/paused/stopped.
 *
 * Pure orchestration over injected deps — no chrome.*, no direct DOM writes —
 * so the whole machine unit-tests with scripted fakes. contentScript provides
 * the real deps (fillOnce, scanner snapshots, advance discovery, background
 * state persistence) and the overlay renders the progress beats.
 *
 * Invariants:
 *  - NEVER clicks a terminal (submit-like) button — finishes "done" instead.
 *  - Persists FlowState BEFORE clicking advance, so a real navigation (content
 *    script death) resumes on the next page via the session flag.
 *  - Every pause auto-resumes when its condition clears (polled), except
 *    drafts, which resume when the overlay reports the review queue empty.
 *  - Runaway guards: MAX_STEPS, FLOW_TTL_MS, and a same-signature loop check.
 */
import type {
  AiDraft,
  DetectedField,
  FlowPauseReason,
  FlowPhase,
  FlowProgress,
  FlowState,
} from "../shared/types";
import type { AdvanceButton } from "./advance";

export const MAX_STEPS = 12;
export const FLOW_TTL_MS = 10 * 60 * 1000;
const PAUSE_POLL_MS = 2000;
const ADVANCE_POLL_MS = 500;
const ADVANCE_WAIT_MS = 8000;

export interface StepTally {
  ok: number;
  fail: number;
  total: number;
  drafts: AiDraft[];
}

export interface FlowSnapshot {
  fields: DetectedField[];
  scopeEl: HTMLElement | null;
}

export interface FlowDeps {
  /** One full fill pass (fillOnce). null ids → default selection this step. */
  fillStep(ids: string[] | null): Promise<StepTally>;
  snapshot(): FlowSnapshot;
  /** Force a fresh scan (updates what snapshot() returns). */
  rescan(): void;
  findAdvance(scope: HTMLElement, extraAdvance?: RegExp): AdvanceButton | null;
  clickAdvance(el: HTMLElement): void;
  /** Account-wall handling (Phase 4); {} when no wall. */
  accountStep(snap: FlowSnapshot): Promise<{ extraAdvance?: RegExp }>;
  /** First blocking condition, or null when clear (captcha/validation/…). */
  pauseReason(snap: FlowSnapshot): Promise<FlowPauseReason | null>;
  /** True when a required résumé field needs a file. */
  needsResume(snap: FlowSnapshot): boolean;
  /** Try to attach the user's résumé; false → pause until the user does. */
  attachResume(): Promise<boolean>;
  setState(state: FlowState | null): Promise<void>;
  onProgress(p: FlowProgress): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Order-independent hash of the scanned field set — step-change detection. */
export function fieldSignature(fields: DetectedField[]): string {
  const s = fields
    .map((f) => `${f.category}|${f.label}|${f.controlType}`)
    .sort()
    .join("\n");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${fields.length}:${(h >>> 0).toString(16)}`;
}

export class FlowController {
  private stopRequested = false;
  private draftsCleared: (() => void) | null = null;
  private step = 0;
  private startedAt = 0;
  private lastTally = { ok: 0, fail: 0 };

  constructor(private deps: FlowDeps) {}

  /** User pressed Stop (or a new flow replaces this one). Idempotent. */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    void this.deps.setState(null);
    this.draftsCleared?.();
  }

  /** The overlay's review queue emptied — a drafts pause may resume. */
  notifyDraftsCleared(): void {
    this.draftsCleared?.();
  }

  /**
   * Run from `initial` (fresh click: step 0; navigation resume: persisted
   * state). `firstTally` carries the fill the panel already awaited, so the
   * first step is not filled twice.
   */
  async run(initial: FlowState, firstTally: StepTally | null): Promise<void> {
    this.step = initial.step;
    this.startedAt = initial.startedAt || this.deps.now();
    let state: FlowState = { ...initial, startedAt: this.startedAt };
    await this.deps.setState(state);
    let pending = firstTally;

    while (!this.stopRequested) {
      if (this.step >= MAX_STEPS) return this.finish("stopped", "Step limit reached — review the page");
      if (this.expired()) return this.finish("stopped", "Flow timed out");

      const account = await this.deps.accountStep(this.deps.snapshot());

      const tally = pending ?? (await this.deps.fillStep(null));
      pending = null;
      // Cumulative across steps — the final "done" beat reports the whole flow.
      this.lastTally = { ok: this.lastTally.ok + tally.ok, fail: this.lastTally.fail + tally.fail };
      this.emit("filling", { drafts: tally.drafts });

      if (tally.drafts.length > 0 && !(await this.waitForDrafts())) {
        return this.finishStopped();
      }

      if (this.deps.needsResume(this.deps.snapshot()) && !(await this.deps.attachResume())) {
        // attachResume failed (no résumé on file) — wait for a manual attach.
      }
      if (!(await this.waitWhileBlocked())) return this.finishStopped();

      const snap = this.deps.snapshot();
      if (!snap.scopeEl) return this.finish("done");
      const adv = this.deps.findAdvance(snap.scopeEl, account.extraAdvance);
      if (!adv) return this.finish("done");
      if (adv.kind === "terminal") return this.finish("done", "Ready to review and submit");

      const before = fieldSignature(snap.fields);
      state = { active: true, step: this.step + 1, startedAt: this.startedAt, lastSignature: before };
      this.step = state.step;
      await this.deps.setState(state); // BEFORE the click — survives navigation
      this.emit("advancing");
      this.deps.clickAdvance(adv.el);

      if (!(await this.waitForChange(before))) {
        // Click rejected (validation) or this page genuinely can't advance.
        // NB: this pre-check consumes one pauseReason() poll, so emit the
        // pause beat here — waitWhileBlocked may find the reason already clear.
        if ((await this.deps.pauseReason(this.deps.snapshot())) === "validation") {
          this.emit("paused", { pauseReason: "validation" });
          if (!(await this.waitWhileBlocked())) return this.finishStopped();
          this.step -= 1; // retry the same page without burning a step
          continue;
        }
        return this.finish("stopped", "Couldn't advance past this page");
      }
    }
    return this.finishStopped();
  }

  // -------------------------------------------------------------------------

  private expired(): boolean {
    return this.deps.now() - this.startedAt > FLOW_TTL_MS;
  }

  private emit(phase: FlowPhase, extra: Partial<FlowProgress> = {}): void {
    this.deps.onProgress({
      phase,
      step: this.step,
      filledOk: this.lastTally.ok,
      filledFail: this.lastTally.fail,
      ...extra,
    });
  }

  private async finish(phase: "done" | "stopped", detail?: string): Promise<void> {
    await this.deps.setState(null);
    this.emit(phase, { detail });
  }

  private finishStopped(): Promise<void> {
    return this.finish("stopped", "Autofill flow stopped");
  }

  /** Resolve when the overlay clears the review queue (or stop()). */
  private waitForDrafts(): Promise<boolean> {
    this.emit("paused", { pauseReason: "drafts" });
    return new Promise((resolve) => {
      this.draftsCleared = (): void => {
        this.draftsCleared = null;
        resolve(!this.stopRequested);
      };
    });
  }

  /** Poll pauseReason until clear. False → stopped/expired. */
  private async waitWhileBlocked(): Promise<boolean> {
    let current: FlowPauseReason | null = null;
    for (;;) {
      if (this.stopRequested) return false;
      if (this.expired()) {
        await this.finish("stopped", "Flow timed out");
        return false;
      }
      const reason = await this.deps.pauseReason(this.deps.snapshot());
      if (!reason) return true;
      if (reason !== current) {
        current = reason;
        this.emit("paused", { pauseReason: reason });
      }
      await this.deps.sleep(PAUSE_POLL_MS);
    }
  }

  /** After an advance click: rescan until the field set changes. */
  private async waitForChange(before: string): Promise<boolean> {
    for (let waited = 0; waited < ADVANCE_WAIT_MS; waited += ADVANCE_POLL_MS) {
      if (this.stopRequested) return false;
      await this.deps.sleep(ADVANCE_POLL_MS);
      this.deps.rescan();
      if (fieldSignature(this.deps.snapshot().fields) !== before) return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/flowController.test.ts`
Expected: PASS (9 tests). The validation-retry test relies on `this.step -= 1` + `continue`; the MAX_STEPS test relies on the guard running before each fill.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -p tsconfig.json --noEmit` (no output), then:

```bash
git add chrome-extension/src/content/flowController.ts chrome-extension/test/flowController.test.ts
git commit -m "feat(autofill): multi-page FlowController state machine"
```

### Task 12: Wire the flow into `contentScript.ts`

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts`
- Modify: `chrome-extension/src/content/overlay.ts` (ONLY the `OverlayCallbacks` interface + `onAutofill` signature — the UI is Task 13)

**Interfaces:**
- Consumes: everything from Tasks 8-11 plus `resumeFieldNeedingFile`/`hasUnsolvedCaptcha`/`validationMessages`/`isVerificationWall` (Task 10), `findAdvanceButton`/`clickAdvance` (Task 9).
- Produces:
  - `OverlayCallbacks.onAutofill(ids: string[], uploadResumeId?: number | null)` — extended signature.
  - `OverlayCallbacks.onFlowStop(): void` and `OverlayCallbacks.onFlowResume(): void`.
  - `fillOnce(ids: string[] | null): Promise<StepTally>` — the extracted single-pass fill (the old `onAutofill` body + the Task 7 re-ask round).
  - Flow resume-on-init via `FLOW_STATE_GET`; progress routed to `updateFlowProgress` (local panel) or `RELAY_TO_TOP`+`REMOTE_FLOW_PROGRESS` (remote host).

- [ ] **Step 1: Extend `OverlayCallbacks` in `overlay.ts`**

Locate `export interface OverlayCallbacks` (`overlay.ts:44` area, member `onAutofill`). Change the `onAutofill` member and add two members:

```ts
  onAutofill: (
    ids: string[],
    uploadResumeId?: number | null
  ) => Promise<{ ok: number; fail: number; total: number; drafts: AiDraft[] }>;
  /** Stop the running multi-page flow (panel Stop button). */
  onFlowStop: () => void;
  /** The review queue emptied — a drafts-paused flow may resume. */
  onFlowResume: () => void;
```

(Compile will fail until Step 2 implements them in contentScript — expected mid-task.)

- [ ] **Step 2: Restructure `contentScript.ts`**

2a. Add imports:

```ts
import { FlowController, FLOW_TTL_MS, type FlowDeps, type FlowSnapshot, type StepTally } from "./flowController";
import { clickAdvance, findAdvanceButton } from "./advance";
import { hasUnsolvedCaptcha, isVerificationWall, resumeFieldNeedingFile, validationMessages } from "./flowChecks";
import { updateFlowProgress } from "./overlay";
```

Also extend the `../shared/types` type-import list with `FlowProgress, FlowState, FlowStateResponse, ResumeSummary`.

2b. Add module state next to `lastScope` (from Task 3):

```ts
  let flowController: FlowController | null = null;
  /** The panel's picked upload résumé for this flow (auto-attach preference). */
  let flowResumeId: number | null = null;
```

2c. Rename the current `onAutofill` callback body into a standalone `async function fillOnce(ids: string[] | null): Promise<StepTally>` placed right before `const overlayCallbacks`. Two edits inside the moved body:
- First line becomes `const wanted = ids ? new Set(ids) : defaultSelectedIds(lastFields);` (`defaultSelectedIds` is already imported).
- It keeps returning `{ ok, fail, total, drafts }` (already the case after Task 7).

2d. Add the flow plumbing right after `fillOnce`:

```ts
  function emitFlowProgress(p: FlowProgress): void {
    if (actingAsRemoteHost) {
      void chrome.runtime
        .sendMessage({ type: "RELAY_TO_TOP", payload: { type: "REMOTE_FLOW_PROGRESS", progress: p } })
        .catch(() => {});
    } else {
      updateFlowProgress(p);
    }
  }

  async function attachPickedResume(): Promise<boolean> {
    const field = resumeFieldNeedingFile(lastFields, (id) => registry.get(id));
    if (!field) return true;
    const control = registry.get(field.id);
    if (!control?.el) return false;
    try {
      let resumeId = flowResumeId;
      if (resumeId == null) {
        // Spec: fall back to the primary résumé, else the most recent with a file.
        const rs = await sendToBackground<ResumesResponse>({ type: "GET_RESUMES" });
        const withFile: ResumeSummary[] = rs?.ok ? rs.resumes.filter((r) => r.hasFile) : [];
        const pick =
          withFile.find((r) => r.isPrimary) ??
          [...withFile].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
        resumeId = pick?.id ?? null;
      }
      if (resumeId == null) return false;
      const file = await sendToBackground<ResumeFileResponse>({ type: "DOWNLOAD_RESUME", resumeId });
      if (!file?.ok || !file.dataBase64) return false;
      const res = await injectResumeFile(control.el, base64ToFile(file.dataBase64, file.name, file.contentType));
      return res.ok;
    } catch {
      return false;
    }
  }

  function makeFlowDeps(): FlowDeps {
    return {
      fillStep: (ids) => fillOnce(ids),
      snapshot: (): FlowSnapshot => ({ fields: lastFields, scopeEl: lastScope }),
      rescan: () => {
        runScan();
        engine?.updateRegistry(registry);
      },
      findAdvance: (scope, extraAdvance) => findAdvanceButton(scope, lastAdapter, { extraAdvance }),
      clickAdvance,
      accountStep: async () => ({}), // Phase 4 replaces this stub
      pauseReason: async (snap) => {
        if (hasUnsolvedCaptcha(document)) return "captcha";
        const scope = snap.scopeEl ?? document.body;
        if (isVerificationWall(scope)) return "verification";
        if (validationMessages(scope).length > 0) return "validation";
        if (resumeFieldNeedingFile(snap.fields, (id) => registry.get(id))) return "resume-upload";
        return null;
      },
      needsResume: (snap) => resumeFieldNeedingFile(snap.fields, (id) => registry.get(id)) !== null,
      attachResume: attachPickedResume,
      setState: async (state) => {
        try {
          await sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state });
        } catch {
          // Background asleep — the flow still runs, it just won't survive navigation.
        }
      },
      onProgress: emitFlowProgress,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
  }

  /** Resume a persisted flow after a real navigation (form-owning frame only). */
  async function maybeResumeFlow(): Promise<void> {
    if (flowController) return;
    if (recognizedCount(lastFields) === 0) return; // not the form-owning frame (yet)
    try {
      const resp = await sendToBackground<FlowStateResponse>({ type: "FLOW_STATE_GET" });
      const st = resp?.state;
      if (!st?.active) return;
      if (Date.now() - st.startedAt > FLOW_TTL_MS) {
        void sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state: null }).catch(() => {});
        return;
      }
      flowController = new FlowController(makeFlowDeps());
      void flowController.run(st, null);
    } catch {
      // Background asleep — the flow simply doesn't resume.
    }
  }
```

2e. Replace the `onAutofill` member of `overlayCallbacks` and add the two new members:

```ts
    onAutofill: async (ids: string[], uploadResumeId?: number | null) => {
      flowResumeId = uploadResumeId ?? null;
      // One click = one flow. Replace any prior flow, fill this step now (the
      // panel awaits this first tally), then let the controller advance.
      flowController?.stop();
      const tally = await fillOnce(ids);
      flowController = new FlowController(makeFlowDeps());
      void flowController.run(
        { active: true, step: 0, startedAt: Date.now(), lastSignature: "" },
        tally
      );
      return tally;
    },
    onFlowStop: () => {
      flowController?.stop();
      flowController = null;
    },
    onFlowResume: () => {
      flowController?.notifyDraftsCleared();
    },
```

2f. In `onProfileResolved` (line ~410), after `reportFields();`, add:

```ts
      void maybeResumeFlow();
```

2g. In the `chrome.runtime.onMessage` switch, add a case after `REMOTE_FIELDS_UPDATED` (line ~770):

```ts
        case "REMOTE_FLOW_PROGRESS": {
          if (isTopFrame && adoptedRemote) updateFlowProgress(message.progress);
          sendResponse({ ok: true });
          return false;
        }
```

- [ ] **Step 3: Stub `updateFlowProgress` in `overlay.ts`**

Task 13 builds the real UI. To keep this task compiling and shippable, add the minimal export near the other exports of `overlay.ts` (e.g. after `updateOverlay`):

```ts
/** Flow progress beats from the controller. Task 13 renders these; until then
 *  the beats only reach the console so wiring is observable. */
export function updateFlowProgress(p: FlowProgress): void {
  console.log(`[Tailrd flow] ${p.phase} step=${p.step}`, p.pauseReason ?? "", p.detail ?? "");
}
```

Add `FlowProgress` to overlay's type imports from `../shared/types`.

- [ ] **Step 4: Verify**

Run: `node node_modules/vitest/vitest.mjs run` then `npx tsc -p tsconfig.json --noEmit`
Expected: full suite PASSES; no tsc output. (No new tests here — the controller and its deps are covered by Tasks 10-11; this task is integration glue verified by compile + suite + Task 13's manual check.)

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts chrome-extension/src/content/overlay.ts
git commit -m "feat(autofill): wire FlowController into content script with resume-on-init"
```

### Task 13: Overlay flow UI (progress line, Stop, drafts-cleared)

**Files:**
- Modify: `chrome-extension/src/content/overlay.ts`
- Test: `chrome-extension/test/overlayFlow.test.ts`

**Interfaces:**
- Consumes: `FlowProgress`, `FlowPauseReason`; `callbacks.onFlowStop/onFlowResume` (Task 12).
- Produces: real `updateFlowProgress(p: FlowProgress): void` (replaces Task 12's stub) and pure `formatFlowProgress(p: FlowProgress): string` (exported for tests).

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/overlayFlow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatFlowProgress } from "../src/content/overlay";

describe("formatFlowProgress", () => {
  it("describes each phase in user language", () => {
    expect(formatFlowProgress({ phase: "filling", step: 0, filledOk: 3, filledFail: 0 })).toBe("Step 1 · filling…");
    expect(formatFlowProgress({ phase: "advancing", step: 1, filledOk: 3, filledFail: 0 })).toBe("Step 2 · next page…");
    expect(
      formatFlowProgress({ phase: "paused", step: 1, filledOk: 3, filledFail: 0, pauseReason: "captcha" })
    ).toBe("Step 2 · paused — solve the captcha to continue");
    expect(
      formatFlowProgress({ phase: "done", step: 3, filledOk: 9, filledFail: 1 })
    ).toBe("Done — 4 steps filled (9 ok, 1 need attention). Review and submit.");
    expect(
      formatFlowProgress({ phase: "stopped", step: 2, filledOk: 0, filledFail: 0, detail: "Flow timed out" })
    ).toBe("Flow timed out");
  });

  it("uses singular step wording", () => {
    expect(formatFlowProgress({ phase: "done", step: 0, filledOk: 5, filledFail: 0 })).toBe(
      "Done — 1 step filled (5 ok). Review and submit."
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/overlayFlow.test.ts`
Expected: FAIL — `formatFlowProgress` is not exported.

- [ ] **Step 3: Implement in `overlay.ts`**

3a. Replace the Task-12 stub with the real implementation plus the formatter:

```ts
const PAUSE_TEXT: Record<FlowPauseReason, string> = {
  captcha: "solve the captcha to continue",
  drafts: "review the answers below to continue",
  "resume-upload": "attach your résumé to continue",
  validation: "fix the highlighted errors to continue",
  account: "sign in to continue",
  verification: "enter the emailed code to continue",
};

/** One-line, user-facing description of a flow beat. Pure — unit-tested. */
export function formatFlowProgress(p: FlowProgress): string {
  const step = `Step ${p.step + 1}`;
  switch (p.phase) {
    case "filling":
      return `${step} · filling…`;
    case "advancing":
      return `${step} · next page…`;
    case "paused":
      return `${step} · paused — ${PAUSE_TEXT[p.pauseReason ?? "validation"]}`;
    case "done": {
      const steps = p.step + 1;
      const attention = p.filledFail > 0 ? `, ${p.filledFail} need attention` : "";
      return `Done — ${steps} step${steps === 1 ? "" : "s"} filled (${p.filledOk} ok${attention}). Review and submit.`;
    }
    case "stopped":
      return p.detail ?? "Autofill flow stopped.";
  }
}

/** Render a flow beat: status line + Stop button + late-step drafts. */
export function updateFlowProgress(p: FlowProgress): void {
  if (!refs) return;
  const running = p.phase === "filling" || p.phase === "advancing" || p.phase === "paused";
  refs.flow.style.display = running ? "flex" : "none";
  refs.flowText.textContent = formatFlowProgress(p);
  if (p.drafts && p.drafts.length > 0) renderReviewSection(p.drafts);
  if (p.phase === "done") showBanner(formatFlowProgress(p), "ok");
  if (p.phase === "stopped") showBanner(formatFlowProgress(p), "warn");
}
```

Add `FlowPauseReason` to the overlay's `../shared/types` type imports.

3b. **Panel markup + refs.** Grep `overlay.ts` for the banner element (`id="ap-banner"` or the `showBanner` target) inside the panel HTML template string. Directly after the banner element in that template, insert:

```html
<div class="ap-flow" id="ap-flow" style="display:none">
  <span class="ap-flow-text" id="ap-flow-text"></span>
  <button class="ap-flow-stop" id="ap-flow-stop" type="button">Stop</button>
</div>
```

In the `refs` assembly (grep for where `banner:` / `review:` elements are looked up by id), add:

```ts
    flow: root.getElementById("ap-flow")!,
    flowText: root.getElementById("ap-flow-text")!,
    flowStop: root.getElementById("ap-flow-stop")! as HTMLButtonElement,
```

(adjust the lookup call to match the file's existing pattern — it uses the shadow root/host consistently for the other refs), extend the `refs` type accordingly, and wire the listener where the other panel buttons get theirs:

```ts
  refs.flowStop.addEventListener("click", () => {
    callbacks?.onFlowStop();
    if (refs) refs.flow.style.display = "none";
    showBanner("Autofill flow stopped.", "warn");
  });
```

In the panel's CSS string (grep `.ap-review-head` and append alongside):

```css
.ap-flow { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
.ap-flow-text { flex: 1; }
.ap-flow-stop { flex: 0 0 auto; }
```

3c. **Drafts-cleared signal.** Add near `renderReviewSection`:

```ts
/** Tell a drafts-paused flow to resume once every card is handled. */
function maybeFlowResume(): void {
  if (!refs || !callbacks) return;
  const open = refs.review.querySelectorAll(".ap-review-card:not([data-done])").length;
  if (open === 0) callbacks.onFlowResume();
}
```

- In `renderReviewSection`'s skip handler (line ~1531), change to:

```ts
    btn.addEventListener("click", () => {
      btn.closest(".ap-review-card")?.remove();
      maybeFlowResume();
    });
```

- In `insertDraft`, locate the success branch (after `const res = await callbacks.onInsertAnswer(drafts[i].fieldId, ta.value);` at line ~1543 — the path that reports success in `#ap-review-status-${i}`). At its end, add:

```ts
    ta.closest(".ap-review-card")?.setAttribute("data-done", "1");
    maybeFlowResume();
```

3d. **Pass the picked upload résumé.** In `doAutofill` (line ~1467), the call `callbacks.onAutofill(ids)` becomes:

```ts
    const { ok, fail, total, drafts } = await callbacks.onAutofill(ids, currentUploadResumeId());
```

Add next to `doAutofill` (grep how the résumé-upload handler derives `picked` around `overlay.ts:1445` — it reads a select/list; mirror that read without side effects):

```ts
/** The résumé currently picked in the upload section, if the user picked one. */
function currentUploadResumeId(): number | null {
  // Mirror the read used by the upload handler (see onUploadResume call site):
  // return the same `picked` value it would use, or null when none is chosen.
  const sel = refs?.uploadPicker as HTMLSelectElement | undefined; // ← adjust to the real ref name found via grep
  const v = sel?.value ? Number(sel.value) : NaN;
  return Number.isFinite(v) ? v : null;
}
```

(The ref name MUST be taken from the real upload-picker element in the file; if the picker is not a `<select>`, reuse whatever state variable the upload handler reads as `picked`.)

- [ ] **Step 4: Verify**

Run: `node node_modules/vitest/vitest.mjs run test/overlayFlow.test.ts` then the full suite `node node_modules/vitest/vitest.mjs run` then `npx tsc -p tsconfig.json --noEmit`
Expected: ALL PASS; no tsc output.

- [ ] **Step 5: Manual smoke (extension build)**

Run from `chrome-extension/`: `node build.mjs`
Expected: build completes. Load the unpacked extension (`chrome-extension/dist`) in Chrome, open any Greenhouse posting, click Autofill: the flow line appears ("Step 1 · filling…"), then either advances or finishes "Done — 1 step filled…". Stop button hides the line.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/overlay.ts chrome-extension/test/overlayFlow.test.ts
git commit -m "feat(autofill): flow progress line, Stop button, drafts-resume signal"
```

# Phase 4 — Account-creation sub-flow

### Task 14: `password` control type + `accountPassword` category

**Files:**
- Modify: `chrome-extension/src/shared/types.ts`, `chrome-extension/src/shared/constants.ts`
- Modify: `chrome-extension/src/content/formScanner.ts`, `chrome-extension/src/content/writeEngine.ts`, `chrome-extension/src/content/overlay.ts`
- Test: `chrome-extension/test/scanPassword.test.ts`

**Interfaces:**
- Produces: `ControlType` gains `"password"`; `FieldCategory` gains `"accountPassword"`; password fields scan as `{ category: "accountPassword", fillable: false, currentValue: "filled" | undefined }`; `writeControl`/`verifyControl` handle `"password"` (exact-match verify). Panel never lists them; AI never sees them.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/scanPassword.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import { isAiCandidate } from "../src/content/aiFillPlanner";
import { isDefaultSelected } from "../src/shared/selection";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

beforeEach(() => {
  document.body.innerHTML = "";
});

function signupForm(): void {
  document.body.innerHTML = `
    <form>
      <label>Email <input type="email" name="email" /></label>
      <label>Password <input type="password" name="password" id="pw" /></label>
      <label>Verify Password <input type="password" name="confirm" /></label>
    </form>`;
}

describe("scanPage — password fields", () => {
  it("surfaces passwords as accountPassword, never fillable, never AI-eligible", () => {
    signupForm();
    const { fields } = scanPage(null, false);
    const pws = fields.filter((f) => f.controlType === "password");
    expect(pws).toHaveLength(2);
    for (const f of pws) {
      expect(f.category).toBe("accountPassword");
      expect(f.fillable).toBe(false);
      expect(f.proposedValue).toBeNull();
      expect(isAiCandidate(f)).toBe(false);
      expect(isDefaultSelected(f)).toBe(false);
    }
  });

  it("masks any pre-existing value as 'filled'", () => {
    signupForm();
    (document.getElementById("pw") as HTMLInputElement).value = "hunter2";
    const { fields } = scanPage(null, false);
    const pw = fields.find((f) => f.controlType === "password" && f.currentValue);
    expect(pw?.currentValue).toBe("filled");
  });
});

describe("writeControl / verifyControl — password", () => {
  it("writes and verifies with exact matching", () => {
    signupForm();
    const el = document.getElementById("pw") as HTMLInputElement;
    const control = { id: "x", controlType: "password" as const, el };
    expect(writeControl(control, "S3cure!Pass").written).toBe(true);
    expect(verifyControl(control, "S3cure!Pass")).toBe(true);
    expect(verifyControl(control, "s3cure!pass")).toBe(false); // never fuzzy
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/scanPassword.test.ts`
Expected: FAIL — passwords are skipped entirely today (`pws` is empty) and `"password"` is not a valid `ControlType`.

- [ ] **Step 3: Implement**

3a. `shared/types.ts`: add `| "password"` to `ControlType` (line ~166) and `| "accountPassword"` to `FieldCategory` before `| "unknown"` (line ~163).

3b. `shared/constants.ts`: add to `CATEGORY_LABELS` (line ~47):

```ts
  accountPassword: "Account password",
```

3c. `formScanner.ts`:
- Remove `"password", // never touch passwords` from `SKIPPED_INPUT_TYPES` (line ~76) and add a comment on the set: `// password intentionally NOT here — surfaced as accountPassword, filled only by the account sub-flow.`
- In `controlTypeOf`, add as the first check inside `el instanceof HTMLInputElement` (line ~104):

```ts
    if (el.type === "password") return "password"; // account sub-flow only
```

- In the single-control section of `scanPage`, right after `const signals = collectSignals(el);` (line ~270), add:

```ts
    // Passwords: registry-tracked for the account sub-flow, but never listed
    // as a generic field, never fillable generically, never sent to the AI —
    // and the value is never echoed into the serializable field.
    if (controlType === "password") {
      registry.set(id, { id, controlType, el });
      fields.push({
        id,
        category: "accountPassword",
        confidence: 1,
        label: bestDisplayLabel(signals),
        controlType,
        required: isRequiredField(el, signals),
        proposedValue: null,
        fillable: false,
        sensitive: false,
        note: "Handled by the account sign-up flow.",
        currentValue: (el as HTMLInputElement).value ? "filled" : undefined,
      });
      continue;
    }
```

(NB: the `const id = ensureFieldId(el);` line already runs before this insert point.)

3d. `writeEngine.ts`:
- `writeControl` switch — add before the `"text"`/`"textarea"` cases:

```ts
    case "password":
      return writeTextLike(control.el as HTMLInputElement, value);
```

- `verifyControl` switch — add:

```ts
    case "password": {
      const el = control.el as HTMLInputElement | undefined;
      if (isStale(el)) return false;
      return el!.value === value; // exact — never fuzzy-match a password
    }
```

3e. `overlay.ts`: in the field-list filter at line ~1332, extend:

```ts
    (f) => (f.fillable || f.category !== "unknown") && f.category !== "accountPassword" && !(f.sensitive && !fillEEO)
```

3f. `aiFillPlanner.ts` — no change needed (`fillable: false` blocks `isAiCandidate`), but confirm no `switch` on `ControlType` lacks a default: `mapType` has `default: return "text"` — fine.

- [ ] **Step 4: Run tests + typecheck**

Run: `node node_modules/vitest/vitest.mjs run test/scanPassword.test.ts test/formScanner.test.ts test/writeEngine.test.ts` then `npx tsc -p tsconfig.json --noEmit`
Expected: ALL PASS; tsc clean (its exhaustiveness checks are what force the writeEngine cases).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/shared/constants.ts chrome-extension/src/content/formScanner.ts chrome-extension/src/content/writeEngine.ts chrome-extension/src/content/overlay.ts chrome-extension/test/scanPassword.test.ts
git commit -m "feat(autofill): first-class password controls (accountPassword category)"
```

### Task 15: Password generation (`passwordGen.ts`)

**Files:**
- Create: `chrome-extension/src/content/passwordGen.ts`
- Test: `chrome-extension/test/passwordGen.test.ts`

**Interfaces:**
- Produces: `generatePassword(length = 20): string` — guaranteed ≥1 lower/upper/digit/symbol, ambiguous glyphs excluded, `crypto.getRandomValues` randomness. Task 17 consumes it.

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/passwordGen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generatePassword } from "../src/content/passwordGen";

describe("generatePassword", () => {
  it("is 20 chars by default and honors a custom length", () => {
    expect(generatePassword()).toHaveLength(20);
    expect(generatePassword(24)).toHaveLength(24);
  });

  it("always contains all four character classes", () => {
    for (let i = 0; i < 25; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*\-_=+?]/);
    }
  });

  it("never uses ambiguous glyphs (0/O, 1/l/I)", () => {
    for (let i = 0; i < 25; i++) {
      expect(generatePassword()).not.toMatch(/[01OlI]/);
    }
  });

  it("produces different values per call", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/passwordGen.test.ts`
Expected: FAIL — cannot resolve `../src/content/passwordGen`.

- [ ] **Step 3: Implement**

Create `chrome-extension/src/content/passwordGen.ts`:

```ts
/**
 * Signup-wall password generation. Local-only: the password is written into
 * the page and saved to chrome.storage.local (credentialStore) — it is never
 * sent to the Tailrd backend. Ambiguous glyphs (0/O, 1/l/I) are excluded so a
 * user reading the saved password back never mistypes it.
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz".replace("l", "");
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ".replace("I", "").replace("O", "").replace("L", "");
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

function pick(set: string, count: number): string[] {
  const buf = crypto.getRandomValues(new Uint32Array(count));
  return Array.from(buf, (v) => set[v % set.length]);
}

export function generatePassword(length = 20): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [
    ...pick(LOWER, 1),
    ...pick(UPPER, 1),
    ...pick(DIGITS, 1),
    ...pick(SYMBOLS, 1),
    ...pick(all, Math.max(length - 4, 0)),
  ];
  // Crypto-seeded Fisher-Yates so the guaranteed classes aren't positional.
  const rnd = crypto.getRandomValues(new Uint32Array(chars.length));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, length).join("");
}
```

Note the charset edits: `LOWER` drops `l`, `UPPER` drops `I`/`O` (and the `.replace` chain above must produce exactly that — simpler is to write the literals out:

```ts
const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";   // no I, no L, no O
```

Use the literal form, not the `.replace` form.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/passwordGen.test.ts`
Expected: PASS. (jsdom provides `crypto.getRandomValues`; no mock needed.)

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/passwordGen.ts chrome-extension/test/passwordGen.test.ts
git commit -m "feat(autofill): crypto-random signup password generation"
```

### Task 16: Credential store (`credentialStore.ts`)

**Files:**
- Create: `chrome-extension/src/content/credentialStore.ts`
- Test: `chrome-extension/test/credentialStore.test.ts`

**Interfaces:**
- Produces (Tasks 17-18 consume):
  - `interface SavedCredential { origin: string; email: string; password: string; createdAt: number }`
  - `saveCredential(origin: string, email: string, password: string): Promise<void>`
  - `getCredential(origin: string): Promise<SavedCredential | null>`
  - `listCredentials(): Promise<SavedCredential[]>` (newest first)
  - `deleteCredential(origin: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/credentialStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  deleteCredential,
  getCredential,
  listCredentials,
  saveCredential,
} from "../src/content/credentialStore";

function mockLocalStorage(): void {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: mem[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(mem, obj);
        },
      },
    },
  };
}

describe("credentialStore", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("saves and retrieves per-origin credentials", async () => {
    await saveCredential("https://acme.wd3.myworkdayjobs.com", "me@x.com", "S3cret!");
    const c = await getCredential("https://acme.wd3.myworkdayjobs.com");
    expect(c?.email).toBe("me@x.com");
    expect(c?.password).toBe("S3cret!");
    expect(c?.createdAt).toBeGreaterThan(0);
    expect(await getCredential("https://other.example.com")).toBeNull();
  });

  it("overwrites on re-save (last write wins) and lists newest first", async () => {
    await saveCredential("https://a.com", "a@x.com", "one");
    await saveCredential("https://b.com", "b@x.com", "two");
    await saveCredential("https://a.com", "a@x.com", "three");
    expect((await getCredential("https://a.com"))?.password).toBe("three");
    const all = await listCredentials();
    expect(all.map((c) => c.origin)).toHaveLength(2);
  });

  it("deletes a single origin", async () => {
    await saveCredential("https://a.com", "a@x.com", "one");
    await deleteCredential("https://a.com");
    expect(await getCredential("https://a.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/credentialStore.test.ts`
Expected: FAIL — cannot resolve `../src/content/credentialStore`.

- [ ] **Step 3: Implement**

Create `chrome-extension/src/content/credentialStore.ts`:

```ts
/**
 * Device-local store for signup-wall credentials, keyed by origin.
 *
 * SECURITY POSTURE (spec): chrome.storage.local only — never synced, never
 * sent to the Tailrd backend, never included in any AI_FILL payload. The panel
 * shows these under "Saved sign-ins" (reveal/copy/delete); Chrome's own
 * password manager usually also offers to save on submit.
 */

const KEY = "apCredentials";

export interface SavedCredential {
  origin: string;
  email: string;
  password: string;
  createdAt: number;
}

type StoredCredential = Omit<SavedCredential, "origin">;
type CredMap = Record<string, StoredCredential>;

async function readAll(): Promise<CredMap> {
  const got = await chrome.storage.local.get(KEY);
  return (got?.[KEY] as CredMap) ?? {};
}

export async function saveCredential(origin: string, email: string, password: string): Promise<void> {
  const all = await readAll();
  all[origin] = { email, password, createdAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: all });
}

export async function getCredential(origin: string): Promise<SavedCredential | null> {
  const all = await readAll();
  const c = all[origin];
  return c ? { origin, ...c } : null;
}

export async function listCredentials(): Promise<SavedCredential[]> {
  const all = await readAll();
  return Object.entries(all)
    .map(([origin, c]) => ({ origin, ...c }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteCredential(origin: string): Promise<void> {
  const all = await readAll();
  delete all[origin];
  await chrome.storage.local.set({ [KEY]: all });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/credentialStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/credentialStore.ts chrome-extension/test/credentialStore.test.ts
git commit -m "feat(autofill): device-local credential store for signup walls"
```

### Task 17: Wall detection + filling (`accountFlow.ts`)

**Files:**
- Create: `chrome-extension/src/content/accountFlow.ts`
- Test: `chrome-extension/test/accountFlow.test.ts`

**Interfaces:**
- Consumes: `generatePassword` (Task 15), `getCredential`/`saveCredential` (Task 16), `WriteResult` type from writeEngine, domUtils.
- Produces (Task 18 consumes):
  - `type WallKind = "signup" | "login"`
  - `interface WallInfo { kind: WallKind; passwordEls: HTMLInputElement[]; emailEl: HTMLInputElement | null }`
  - `detectWall(scope: HTMLElement): WallInfo | null`
  - `WALL_ADVANCE_RE: RegExp` (the wall verbs)
  - `runAccountWall(wall: WallInfo, origin: string, profileEmail: string, write: (el: HTMLInputElement, value: string) => WriteResult): Promise<{ extraAdvance?: RegExp; pause?: "account"; filled: number }>`

- [ ] **Step 1: Write the failing test**

Create `chrome-extension/test/accountFlow.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { detectWall, runAccountWall, WALL_ADVANCE_RE } from "../src/content/accountFlow";
import { getCredential, saveCredential } from "../src/content/credentialStore";
import type { WriteResult } from "../src/content/writeEngine";
import { stubLayout } from "./helpers/layout";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

function mockLocalStorage(): void {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: mem[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(mem, obj);
        },
      },
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  mockLocalStorage();
});

const write = (el: HTMLInputElement, value: string): WriteResult => {
  el.value = value;
  return { written: true };
};

function scope(): HTMLElement {
  return document.getElementById("s")!;
}

describe("detectWall", () => {
  it("detects a signup wall (two password fields)", () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" />
        <input type="password" name="password" />
        <input type="password" name="verifyPassword" />
      </div>`;
    const wall = detectWall(scope());
    expect(wall?.kind).toBe("signup");
    expect(wall?.passwordEls).toHaveLength(2);
    expect(wall?.emailEl?.name).toBe("email");
  });

  it("detects a login wall (one password + sign-in copy, EN and FR)", () => {
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" /><input type="password" /></div>`;
    expect(detectWall(scope())?.kind).toBe("login");
    document.body.innerHTML = `
      <div id="s"><h2>Se connecter</h2><input type="email" /><input type="password" /></div>`;
    expect(detectWall(scope())?.kind).toBe("login");
  });

  it("returns null with no password fields", () => {
    document.body.innerHTML = `<div id="s"><input type="email" /></div>`;
    expect(detectWall(scope())).toBeNull();
  });
});

describe("runAccountWall", () => {
  it("signup: generates, fills both password fields, saves the credential", async () => {
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" id="em" />
        <input type="password" id="p1" /><input type="password" id="p2" />
      </div>`;
    const wall = detectWall(scope())!;
    const out = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    const p1 = (document.getElementById("p1") as HTMLInputElement).value;
    const p2 = (document.getElementById("p2") as HTMLInputElement).value;
    expect(p1).toHaveLength(20);
    expect(p1).toBe(p2);
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("me@x.com");
    expect(out.extraAdvance).toBe(WALL_ADVANCE_RE);
    expect(out.pause).toBeUndefined();
    const saved = await getCredential("https://acme.jobs");
    expect(saved?.email).toBe("me@x.com");
    expect(saved?.password).toBe(p1);
  });

  it("signup revisit: reuses the already-saved password (idempotent)", async () => {
    await saveCredential("https://acme.jobs", "me@x.com", "Existing#Pass9x");
    document.body.innerHTML = `
      <div id="s"><h2>Create Account</h2>
        <input type="email" name="email" /><input type="password" id="p1" />
      </div>`;
    await runAccountWall(detectWall(scope())!, "https://acme.jobs", "me@x.com", write);
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Existing#Pass9x");
  });

  it("login with stored creds fills them; without creds pauses", async () => {
    document.body.innerHTML = `
      <div id="s"><h2>Sign In</h2><input type="email" id="em" /><input type="password" id="p1" /></div>`;
    const wall = detectWall(scope())!;
    const noCreds = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect(noCreds.pause).toBe("account");

    await saveCredential("https://acme.jobs", "me@x.com", "Stored#Pass9x");
    const withCreds = await runAccountWall(wall, "https://acme.jobs", "me@x.com", write);
    expect(withCreds.pause).toBeUndefined();
    expect((document.getElementById("p1") as HTMLInputElement).value).toBe("Stored#Pass9x");
    expect((document.getElementById("em") as HTMLInputElement).value).toBe("me@x.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run test/accountFlow.test.ts`
Expected: FAIL — cannot resolve `../src/content/accountFlow`.

- [ ] **Step 3: Implement**

Create `chrome-extension/src/content/accountFlow.ts`:

```ts
/**
 * Account-wall sub-flow: Workday-style signup/login pages that gate the real
 * application. Signup walls get a generated password (saved device-locally —
 * see credentialStore's security posture); login walls replay saved
 * credentials or pause for the user. Verification/2FA walls always pause
 * (flowChecks.isVerificationWall) — that part is human-only.
 */
import { cleanText, deepQueryAll, isHiddenButLabeled, isVisible } from "./domUtils";
import { generatePassword } from "./passwordGen";
import { getCredential, saveCredential } from "./credentialStore";
import type { WriteResult } from "./writeEngine";

export type WallKind = "signup" | "login";

export interface WallInfo {
  kind: WallKind;
  passwordEls: HTMLInputElement[];
  emailEl: HTMLInputElement | null;
}

const SIGNUP_RE = /create (an? )?account|sign ?up|register|new user|créer (un|mon) compte|s'?inscrire/i;
const LOGIN_RE = /sign ?in|log ?in|already registered|se connecter|connexion/i;

/** Wall verbs the advance search accepts ONLY while a wall is detected. */
export const WALL_ADVANCE_RE =
  /\b(create( an| my)? account|sign ?up|register|sign ?in|log ?in|créer (un|mon) compte|s'?inscrire|se connecter)\b/i;

export function detectWall(scope: HTMLElement): WallInfo | null {
  const passwordEls = (deepQueryAll(scope, 'input[type="password"]') as HTMLInputElement[]).filter(
    (el) => !el.disabled && (isVisible(el) || isHiddenButLabeled(el))
  );
  if (passwordEls.length === 0) return null;
  const text = cleanText(scope.textContent).slice(0, 4000);
  const kind: WallKind =
    passwordEls.length >= 2 ? "signup"
    : SIGNUP_RE.test(text) ? "signup"
    : LOGIN_RE.test(text) ? "login"
    : "signup";
  const emailEl =
    (deepQueryAll(
      scope,
      'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i]'
    ) as HTMLInputElement[]).filter((el) => !el.disabled && el.type !== "password")[0] ?? null;
  return { kind, passwordEls, emailEl };
}

export interface AccountWallOutcome {
  extraAdvance?: RegExp;
  pause?: "account";
  filled: number;
}

export async function runAccountWall(
  wall: WallInfo,
  origin: string,
  profileEmail: string,
  write: (el: HTMLInputElement, value: string) => WriteResult
): Promise<AccountWallOutcome> {
  let filled = 0;
  if (wall.kind === "signup") {
    // Revisits reuse the saved password so email+password always stay a pair.
    const existing = await getCredential(origin);
    const password = existing?.password ?? generatePassword();
    const email = wall.emailEl?.value || profileEmail || existing?.email || "";
    if (wall.emailEl && !wall.emailEl.value && email && write(wall.emailEl, email).written) filled++;
    for (const el of wall.passwordEls) {
      if (!el.value && write(el, password).written) filled++;
    }
    if (email) await saveCredential(origin, email, password);
    return { extraAdvance: WALL_ADVANCE_RE, filled };
  }
  const cred = await getCredential(origin);
  if (!cred) return { pause: "account", filled };
  if (wall.emailEl && !wall.emailEl.value && write(wall.emailEl, cred.email).written) filled++;
  for (const el of wall.passwordEls) {
    if (!el.value && write(el, cred.password).written) filled++;
  }
  return { extraAdvance: WALL_ADVANCE_RE, filled };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run test/accountFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/accountFlow.ts chrome-extension/test/accountFlow.test.ts
git commit -m "feat(autofill): signup/login wall detection and filling"
```

### Task 18: Account integration + Saved sign-ins panel

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts` (replace the `accountStep` stub; extend `pauseReason`)
- Modify: `chrome-extension/src/content/overlay.ts` (Saved sign-ins section)

**Interfaces:**
- Consumes: `detectWall`/`runAccountWall`/`WALL_ADVANCE_RE` (Task 17), `writeControl` (Task 14 password case), `listCredentials`/`deleteCredential` (Task 16).
- Produces: the flow passes signup/login walls end-to-end; the panel manages saved credentials.

- [ ] **Step 1: Replace the `accountStep` stub in `makeFlowDeps()`** (`contentScript.ts`, Task 12)

Add imports:

```ts
import { detectWall, runAccountWall } from "./accountFlow";
import { writeControl } from "./writeEngine"; // already imported — extend the list if needed
```

Add module state next to `flowResumeId`:

```ts
  // A login wall we have no credentials for — pauses the flow until it clears.
  let accountBlocked = false;
```

Replace `accountStep: async () => ({}),` with:

```ts
      accountStep: async (snap) => {
        const scope = snap.scopeEl ?? document.body;
        const wall = detectWall(scope);
        if (!wall) {
          accountBlocked = false;
          return {};
        }
        const out = await runAccountWall(
          wall,
          location.origin,
          lastProfile?.email ?? "",
          (el, value) =>
            writeControl({ id: el.getAttribute("data-ap-field") ?? "", controlType: el.type === "password" ? "password" : "text", el }, value)
        );
        accountBlocked = out.pause === "account";
        return { extraAdvance: out.extraAdvance };
      },
```

In the `pauseReason` dep (Task 12), add as the FIRST check:

```ts
        if (accountBlocked && detectWall(snap.scopeEl ?? document.body)) return "account";
        accountBlocked = accountBlocked && detectWall(snap.scopeEl ?? document.body) !== null;
```

(Exactly this pair: while the login wall is still on screen with no creds, report `"account"`; the moment the wall leaves the DOM — the user signed in, SPA-style — the flag clears and the flow resumes. A full-page navigation resumes via the session state instead.)

- [ ] **Step 2: Saved sign-ins section in `overlay.ts`**

2a. Imports:

```ts
import { deleteCredential, listCredentials } from "./credentialStore";
```

2b. Panel markup: after the flow line inserted in Task 13 (`#ap-flow`), add:

```html
<details class="ap-signins" id="ap-signins">
  <summary>Saved sign-ins</summary>
  <div class="ap-signins-body" id="ap-signins-body"></div>
</details>
```

Add refs `signins` (`#ap-signins`) and `signinsBody` (`#ap-signins-body`) following the file's ref pattern, and register a toggle listener where other listeners are wired:

```ts
  refs.signins.addEventListener("toggle", () => {
    if ((refs!.signins as HTMLDetailsElement).open) void renderSavedSignins();
  });
```

2c. Add the renderer (near the other render helpers; `esc()` already exists in this file):

```ts
async function renderSavedSignins(): Promise<void> {
  if (!refs) return;
  const host = refs.signinsBody;
  const creds = await listCredentials();
  if (creds.length === 0) {
    host.innerHTML = `<div class="ap-signins-empty">No saved sign-ins yet. Signup walls passed by autofill appear here.</div>`;
    return;
  }
  host.innerHTML = creds
    .map(
      (c, i) => `
    <div class="ap-signin-row" data-origin="${esc(c.origin)}">
      <div class="ap-signin-meta">
        <span class="ap-signin-site">${esc(c.origin.replace(/^https?:\/\//, ""))}</span>
        <span class="ap-signin-email">${esc(c.email)}</span>
      </div>
      <code class="ap-signin-pass" id="ap-pass-${i}" data-hidden="1">••••••••</code>
      <button class="ap-signin-reveal" data-i="${i}" type="button">Show</button>
      <button class="ap-signin-copy" data-i="${i}" type="button">Copy</button>
      <button class="ap-signin-del" data-i="${i}" type="button">Delete</button>
    </div>`
    )
    .join("");
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-reveal").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      const code = host.querySelector<HTMLElement>(`#ap-pass-${i}`);
      if (!code) return;
      const hidden = code.dataset.hidden === "1";
      code.textContent = hidden ? creds[i].password : "••••••••";
      code.dataset.hidden = hidden ? "0" : "1";
      btn.textContent = hidden ? "Hide" : "Show";
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(creds[Number(btn.dataset.i)].password).catch(() => {});
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".ap-signin-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      void deleteCredential(creds[Number(btn.dataset.i)].origin).then(renderSavedSignins);
    });
  });
}
```

2d. CSS (append with the Task-13 styles):

```css
.ap-signins { margin: 6px 0; font-size: 12px; }
.ap-signin-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.ap-signin-meta { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.ap-signin-site { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.ap-signin-email { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
.ap-signin-pass { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 3: Verify**

Run: `node node_modules/vitest/vitest.mjs run` then `npx tsc -p tsconfig.json --noEmit` then `node build.mjs`
Expected: full suite PASSES; tsc clean; build completes.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts chrome-extension/src/content/overlay.ts
git commit -m "feat(autofill): account-wall flow integration + saved sign-ins panel"
```

---

# Final verification

- [ ] **Full automated pass**

```bash
cd chrome-extension
node node_modules/vitest/vitest.mjs run
npx tsc -p tsconfig.json --noEmit
node build.mjs
cd ..
python -m pytest backend/tests/test_match_option.py -v
```

Expected: every suite green, tsc silent, build succeeds.

- [ ] **Manual checklist** (load `chrome-extension/dist` unpacked; use the `verify` skill if available)

1. **Scoping:** open a career page with a header language switcher (e.g. a Canadian posting with EN/FR) — the switcher must NOT appear in the panel's field list.
2. **Dropdowns:** a form with a lazily-mounted citizenship-style dropdown — Autofill must select the real option (e.g. "Canadian"), or surface it as a reviewed draft; never "No option matches".
3. **Multi-step (Workday demo posting):** one Autofill click fills step 1, clicks Next itself, fills step 2… and STOPS at the final Submit/Review step with "Done — N steps filled". Stop button interrupts mid-flow.
4. **Signup wall (fresh Workday tenant):** flow fills email, generates + fills password/confirm, clicks Create Account, continues; the credential appears under Saved sign-ins (reveal/copy/delete work).
5. **Pauses:** a captcha'd form pauses with "solve the captcha to continue" and resumes after solving; AI drafts pause the flow and Accept-all/Skip-all resumes it.
6. **Navigation resume:** on a flow that navigates between steps (full page load), the fill continues on the new page without another click.
7. **Embedded form regression:** a Greenhouse form embedded in a company site (cross-origin iframe) still scans, adopts into the top-frame panel, and fills — scoping and the flow must not break iframe adoption.
8. **French posting:** on an FR-Canadian application, the flow clicks "Suivant"/"Continuer" and stops at "Soumettre"/"Postuler".

- [ ] **Update memory/docs:** append the outcome (phases shipped, anything deferred) to `docs/autofill-rebuild/` notes if that file set is being maintained, and note completion in the session summary.




