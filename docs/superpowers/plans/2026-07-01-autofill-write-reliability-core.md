# Autofill Write‑Reliability Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably commit fills on react‑select and Workday widgets by driving their React internals from a MAIN‑world script, while leaving our working isolated‑world engine untouched for every other control.

**Architecture:** A new MAIN‑world driver (`mainWorld.js`, injected per‑frame by the service worker via `chrome.scripting` `world:"MAIN"`) reads each widget's React Fiber and calls its real `selectOption`/`onChange` callback (DOM‑interaction fallback when no instance is found). The isolated content script detects the widget kind during scanning, tags the control with a `driver`, and routes those fields to the driver over a `CustomEvent` bridge; results fold into the existing outcome tally. Everything else keeps its current path.

**Tech Stack:** TypeScript (strict), esbuild (IIFE bundles), MV3 (`chrome.scripting`, `web_accessible_resources`), vitest + jsdom (unit), Playwright (real‑browser integration).

## Global Constraints

- Manifest V3; background is a service worker; no remote code, no `eval`, no new host permissions. `scripting` permission already present.
- Bundles are IIFE (esbuild); MAIN‑world code must be self‑contained (no isolated‑world imports beyond shared type/constant modules that bundle cleanly).
- Cross‑world bridge payloads are JSON‑only (CustomEvent `detail` is structured‑cloned across worlds).
- Field locator across worlds is the existing stamp `FIELD_ID_ATTR = "data-ap-field"` (value === the field id).
- Driver call timeout: **2500 ms**; on timeout report the field as needs‑manual (never hang the reconciler).
- Work on branch `feature/autofill-rebuild`. Run `npm run typecheck` and `npm test` before every commit; commit after each task.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.

---

### Task 1: Shared bridge contract + driver types

**Files:**
- Create: `chrome-extension/src/content/mainWorldBridge.ts`
- Test: (none — pure constants/types; covered by consumers)

**Interfaces:**
- Produces: `FillDriver` (`"react-select" | "workday"`), `MW_FILL_EVENT`, `MW_RESULT_EVENT`, `MwFillDetail`, `MwResultDetail`.

- [ ] **Step 1: Create the shared contract module**

```ts
// chrome-extension/src/content/mainWorldBridge.ts
/**
 * Shared contract between the isolated-world client (mainWorldClient.ts) and the
 * MAIN-world driver (mainWorld.ts). Kept dependency-free so both worlds bundle it
 * without pulling in isolated-only code, and so the two sides can never drift.
 */
export type FillDriver = "react-select" | "workday";

/** Isolated → MAIN: please fill this field. */
export const MW_FILL_EVENT = "tailrd:mw:fill";
/** MAIN → isolated: here is the outcome. */
export const MW_RESULT_EVENT = "tailrd:mw:result";

export interface MwFillDetail {
  id: number;
  /** Value of FIELD_ID_ATTR on the target node (locates it in the MAIN world). */
  fieldId: string;
  value: string;
  kind: FillDriver;
}

export interface MwResultDetail {
  id: number;
  ok: boolean;
  /** The widget's committed/displayed value after the fill, if readable. */
  committed?: string;
  reason?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd chrome-extension && npm run typecheck`
Expected: PASS (no usages yet; module compiles).

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/content/mainWorldBridge.ts
git commit -m "feat(autofill): shared MAIN-world bridge contract + FillDriver type"
```

---

### Task 2: Driver detection

**Files:**
- Create: `chrome-extension/src/content/driverDetect.ts`
- Test: `chrome-extension/test/driverDetect.test.ts`

**Interfaces:**
- Consumes: `FillDriver` from `./mainWorldBridge`.
- Produces: `detectFillDriver(el: HTMLElement, hostname?: string): FillDriver | null`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/driverDetect.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { detectFillDriver } from "../src/content/driverDetect";

beforeEach(() => { document.body.innerHTML = ""; });

function reactSelectInput(): HTMLInputElement {
  const container = document.createElement("div");
  container.className = "myselect__container";
  const control = document.createElement("div");
  control.className = "myselect__control";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.id = "react-select-5-input";
  control.append(input);
  container.append(control);
  document.body.append(container);
  return input;
}

describe("detectFillDriver", () => {
  it("tags a react-select input (container + react-select id)", () => {
    expect(detectFillDriver(reactSelectInput(), "boards.greenhouse.io")).toBe("react-select");
  });

  it("tags a Workday widget on a Workday host by data-automation-id", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-automation-id", "multiSelectContainer");
    document.body.append(btn);
    expect(detectFillDriver(btn, "acme.wd5.myworkdayjobs.com")).toBe("workday");
  });

  it("does NOT tag a Workday-looking widget off a Workday host", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-automation-id", "multiSelectContainer");
    document.body.append(btn);
    expect(detectFillDriver(btn, "example.com")).toBeNull();
  });

  it("returns null for a plain native select", () => {
    const sel = document.createElement("select");
    document.body.append(sel);
    expect(detectFillDriver(sel, "boards.greenhouse.io")).toBeNull();
  });

  it("returns null for a plain ARIA combobox with no react-select signature", () => {
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "lb1");
    document.body.append(input);
    expect(detectFillDriver(input, "example.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd chrome-extension && npx vitest run test/driverDetect.test.ts`
Expected: FAIL — `detectFillDriver` is not exported / module not found.

- [ ] **Step 3: Implement the detector**

```ts
// chrome-extension/src/content/driverDetect.ts
/**
 * Conservative widget-kind detection for the MAIN-world drivers. A false positive
 * routes an ordinary field through page-context injection, so each signature
 * requires a strong, specific marker — never a bare role=combobox.
 */
import type { FillDriver } from "./mainWorldBridge";

const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

/** react-select stamps its inputs `id="react-select-<n>-input"` and wraps the
 *  control in a `*__container` / `*__control` element pair (its classNamePrefix
 *  output). Require the container AND the react-select input id/class shape. */
function isReactSelect(el: HTMLElement): boolean {
  const input =
    el.matches('input[id^="react-select"]')
      ? el
      : el.querySelector<HTMLElement>('input[id^="react-select"]');
  const container = el.closest('[class*="-container"], [class*="__container"]');
  const control =
    el.closest('[class*="-control"], [class*="__control"]') ??
    container?.querySelector('[class*="-control"], [class*="__control"]');
  return Boolean((input || control) && container);
}

function isWorkdayWidget(el: HTMLElement): boolean {
  return Boolean(el.closest("[data-automation-id]"));
}

export function detectFillDriver(
  el: HTMLElement,
  hostname: string = location.hostname
): FillDriver | null {
  if (WORKDAY_HOST.test(hostname) && isWorkdayWidget(el)) return "workday";
  if (isReactSelect(el)) return "react-select";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd chrome-extension && npx vitest run test/driverDetect.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/driverDetect.ts chrome-extension/test/driverDetect.test.ts
git commit -m "feat(autofill): conservative react-select/Workday driver detection"
```

---

### Task 3: Scanner tags controls with a driver

**Files:**
- Modify: `chrome-extension/src/content/formScanner.ts` (RuntimeControl interface; combobox/customDropdown branch; fillable flag)
- Test: `chrome-extension/test/formScanner.test.ts` (add cases)

**Interfaces:**
- Consumes: `detectFillDriver` (Task 2), `FillDriver` (Task 1).
- Produces: `RuntimeControl.driver?: FillDriver`; driver‑tagged `combobox`/`customDropdown` fields have `fillable: true`.

- [ ] **Step 1: Write the failing test**

Append to `chrome-extension/test/formScanner.test.ts`:

```ts
import { detectFillDriver } from "../src/content/driverDetect";
// (existing imports of scanPage etc. remain)

describe("driver tagging", () => {
  it("tags a react-select control and marks it fillable", () => {
    document.body.innerHTML = `
      <label for="rs">Country</label>
      <div class="rs__container"><div class="rs__control">
        <input id="react-select-2-input" role="combobox" aria-controls="lb" aria-expanded="false" />
      </div></div>`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    expect(field).toBeTruthy();
    const control = registry.get(field!.id);
    expect(control?.driver).toBe("react-select");
    expect(field!.fillable).toBe(true);
  });

  it("leaves a plain ARIA combobox untagged", () => {
    document.body.innerHTML = `
      <label for="c">City</label>
      <input id="c" role="combobox" aria-controls="lb2" aria-expanded="false" />`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    const control = field ? registry.get(field.id) : undefined;
    expect(control?.driver).toBeUndefined();
  });
});
```

(If `formScanner.test.ts` does not already import `scanPage`/`describe`, mirror the imports at the top of the existing file — do not duplicate them.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/formScanner.test.ts -t "driver tagging"`
Expected: FAIL — `control.driver` is `undefined` (not yet tagged).

- [ ] **Step 3: Implement — add `driver` to the interface**

In `chrome-extension/src/content/formScanner.ts`, update imports and the interface:

```ts
// add to the existing import block:
import { detectFillDriver } from "./driverDetect";
import type { FillDriver } from "./mainWorldBridge";
```

```ts
export interface RuntimeControl {
  id: string;
  controlType: ControlType;
  el?: HTMLElement;
  radios?: HTMLInputElement[];
  checkboxes?: HTMLInputElement[];
  /** For customDropdown/combobox: which MAIN-world driver fills it, if any. */
  driver?: FillDriver;
}
```

- [ ] **Step 4: Implement — tag in the single-control branch**

In `scanPage`, replace the single-control creation block (currently):

```ts
    const control: RuntimeControl = { id, controlType, el };
    registry.set(id, control);
```

with:

```ts
    const driver =
      controlType === "combobox" || controlType === "customDropdown"
        ? detectFillDriver(el) ?? undefined
        : undefined;
    const control: RuntimeControl = { id, controlType, el, driver };
    registry.set(id, control);
```

Then in the `fields.push({ … })` for that block, change the `fillable` line:

```ts
      fillable:
        driver !== undefined ||
        (controlType !== "file" && controlType !== "customDropdown"),
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/formScanner.test.ts`
Expected: PASS (new cases + existing cases still green).

- [ ] **Step 6: Typecheck + full unit suite**

Run: `cd chrome-extension && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/formScanner.ts chrome-extension/test/formScanner.test.ts
git commit -m "feat(autofill): tag react-select/Workday controls with a driver during scan"
```

---

### Task 4: MAIN‑world driver — install guard, bridge, option matching

**Files:**
- Create: `chrome-extension/src/content/mainWorldDriver.ts` (pure logic + `installDriver`)
- Create: `chrome-extension/src/content/mainWorld.ts` (bundle entry)
- Modify: `chrome-extension/build.mjs` (add entry)
- Modify: `chrome-extension/manifest.json` (web_accessible_resources)
- Test: `chrome-extension/test/mainWorldDriver.test.ts`

**Interfaces:**
- Consumes: `FILL/RESULT` events + detail types (Task 1), `FIELD_ID_ATTR`.
- Produces: `installDriver(win: Window & typeof globalThis): void`, `pickOption(labels: string[], target: string): number` (index or −1), `fillField(doc, detail): Promise<MwResultDetail>`.

- [ ] **Step 1: Write the failing test (install guard + bridge echo + option matching)**

```ts
// chrome-extension/test/mainWorldDriver.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { installDriver, pickOption } from "../src/content/mainWorldDriver";
import { MW_FILL_EVENT, MW_RESULT_EVENT, type MwResultDetail } from "../src/content/mainWorldBridge";
import { FIELD_ID_ATTR } from "../src/shared/constants";

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__tailrdMWInstalled;
});

function drive(fieldId: string, value: string, kind: "react-select" | "workday"): Promise<MwResultDetail> {
  return new Promise((resolve) => {
    const onResult = (e: Event): void => {
      const d = (e as CustomEvent<MwResultDetail>).detail;
      if (d.id !== 99) return;
      window.removeEventListener(MW_RESULT_EVENT, onResult);
      resolve(d);
    };
    window.addEventListener(MW_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent(MW_FILL_EVENT, { detail: { id: 99, fieldId, value, kind } }));
  });
}

describe("pickOption", () => {
  it("prefers exact, then contains, then token overlap", () => {
    expect(pickOption(["United States", "Canada"], "Canada")).toBe(1);
    expect(pickOption(["Yes", "No"], "Yes, I am authorized")).toBe(0);
    expect(pickOption(["Bachelor of Science", "Master of Science"], "master science")).toBe(1);
    expect(pickOption(["A", "B"], "Zorp")).toBe(-1);
  });
});

describe("installDriver", () => {
  it("installs once (guard) and ignores a second install", () => {
    installDriver(window);
    installDriver(window); // must not double-register
    expect((window as unknown as Record<string, unknown>).__tailrdMWInstalled).toBe(true);
  });

  it("replies not-ok when the field id is missing", async () => {
    installDriver(window);
    const res = await drive("nope-1", "Canada", "react-select");
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts`
Expected: FAIL — module `mainWorldDriver` not found.

- [ ] **Step 3: Implement the driver core (install + bridge + option matching + Fiber read)**

```ts
// chrome-extension/src/content/mainWorldDriver.ts
/**
 * MAIN-world autofill driver. Runs in the PAGE's JS world (injected by the
 * service worker), so it can read React's Fiber (`__reactFiber$…`, invisible to
 * the isolated content script) and drive react-select / Workday widgets through
 * their real React callbacks. Communicates with the isolated client purely over
 * CustomEvents with JSON detail. No chrome.* here.
 */
import { FIELD_ID_ATTR } from "../shared/constants";
import {
  MW_FILL_EVENT,
  MW_RESULT_EVENT,
  type MwFillDetail,
  type MwResultDetail,
} from "./mainWorldBridge";

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Index of the best option label for `target`, or −1. Exact → contains → token overlap. */
export function pickOption(labels: string[], target: string): number {
  const t = norm(target);
  if (!t) return -1;
  for (let i = 0; i < labels.length; i++) if (norm(labels[i]) === t) return i;
  for (let i = 0; i < labels.length; i++) {
    const l = norm(labels[i]);
    if (l && (l.includes(t) || t.includes(l))) return i;
  }
  const tt = new Set(t.split(" ").filter((w) => w.length > 2));
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < labels.length; i++) {
    const toks = norm(labels[i]).split(" ").filter((w) => w.length > 2);
    if (!toks.length) continue;
    const overlap = toks.filter((w) => tt.has(w)).length / toks.length;
    if (overlap > bestScore) { bestScore = overlap; best = i; }
  }
  return bestScore > 0 ? best : -1;
}

/** React attaches its Fiber under a per-render key on each host node. */
export function getFiber(el: Element): FiberNode | null {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  return key ? ((el as unknown as Record<string, FiberNode>)[key] ?? null) : null;
}

/** Walk up the fiber return chain, returning the first node matching `pred`. */
export function climbFiber(start: FiberNode | null, pred: (f: FiberNode) => boolean): FiberNode | null {
  let f = start;
  for (let i = 0; i < 60 && f; i++, f = f.return) if (pred(f)) return f;
  return null;
}

export interface FiberNode {
  return: FiberNode | null;
  stateNode: unknown;
  memoizedProps?: Record<string, unknown> | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fillField(doc: Document, detail: MwFillDetail): Promise<MwResultDetail> {
  const el = doc.querySelector<HTMLElement>(`[${FIELD_ID_ATTR}="${CSS.escape(detail.fieldId)}"]`);
  if (!el) return { id: detail.id, ok: false, reason: "field-not-found" };
  try {
    const committed =
      detail.kind === "react-select"
        ? await fillReactSelect(el, detail.value)
        : await fillWorkday(el, detail.value);
    return committed === null
      ? { id: detail.id, ok: false, reason: "no-match" }
      : { id: detail.id, ok: true, committed };
  } catch (err) {
    return { id: detail.id, ok: false, reason: err instanceof Error ? err.message : "driver-error" };
  }
}

// react-select + Workday routines are added in Tasks 6 and 8; provide stubs now
// so the bundle compiles and the bridge is exercised by tests.
async function fillReactSelect(_el: HTMLElement, _value: string): Promise<string | null> {
  return null;
}
async function fillWorkday(_el: HTMLElement, _value: string): Promise<string | null> {
  return null;
}

/** Install the fill listener once per frame. Idempotent via a window guard. */
export function installDriver(win: Window & typeof globalThis): void {
  const w = win as unknown as Record<string, unknown>;
  if (w.__tailrdMWInstalled) return;
  w.__tailrdMWInstalled = true;
  win.addEventListener(MW_FILL_EVENT, (e: Event) => {
    const detail = (e as CustomEvent<MwFillDetail>).detail;
    if (!detail || typeof detail.id !== "number") return;
    void fillField(win.document, detail).then((result) => {
      win.dispatchEvent(new CustomEvent(MW_RESULT_EVENT, { detail: result }));
    });
  });
}

// Exported for tests only.
export const __test = { fillField, sleep };
```

- [ ] **Step 4: Create the bundle entry**

```ts
// chrome-extension/src/content/mainWorld.ts
import { installDriver } from "./mainWorldDriver";
installDriver(window);
```

- [ ] **Step 5: Add the esbuild entry**

In `chrome-extension/build.mjs`, add to `entryPoints`:

```js
    { in: "src/background/serviceWorker.ts", out: "serviceWorker" },
    { in: "src/content/contentScript.ts", out: "contentScript" },
    { in: "src/content/mainWorld.ts", out: "mainWorld" },
```

- [ ] **Step 6: Declare the web‑accessible resource**

In `chrome-extension/manifest.json`, add a top‑level key (after `content_scripts`):

```json
  "web_accessible_resources": [
    { "resources": ["mainWorld.js"], "matches": ["<all_urls>"] }
  ]
```

- [ ] **Step 7: Run the driver test**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts`
Expected: PASS (pickOption + install guard + field-not-found).

- [ ] **Step 8: Build to confirm the new bundle emits**

Run: `cd chrome-extension && npm run build`
Expected: `Build complete → dist/`, and `dist/mainWorld.js` exists.

- [ ] **Step 9: Commit**

```bash
git add chrome-extension/src/content/mainWorldDriver.ts chrome-extension/src/content/mainWorld.ts \
        chrome-extension/build.mjs chrome-extension/manifest.json chrome-extension/test/mainWorldDriver.test.ts
git commit -m "feat(autofill): MAIN-world driver harness (install guard, CustomEvent bridge, option matching)"
```

---

### Task 5: Service worker installs the driver on request

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (add `INSTALL_MAIN_WORLD_DRIVER` to `BackgroundRequest`)
- Modify: `chrome-extension/src/background/serviceWorker.ts` (handle in the onMessage listener, using `sender.frameId`)
- Test: `chrome-extension/test/installDriver.test.ts`

**Interfaces:**
- Consumes: `chrome.scripting.executeScript`, `sender.tab.id`, `sender.frameId`.
- Produces: exported `injectMainWorldDriver(tabId: number, frameId: number): Promise<SimpleResponse>`; message `{ type: "INSTALL_MAIN_WORLD_DRIVER" }` → `SimpleResponse`.

- [ ] **Step 1: Add the request type**

Run to locate the union: `cd chrome-extension && grep -n "export type BackgroundRequest" src/shared/types.ts`

Add an interface near the other request interfaces and a member to the union:

```ts
export interface InstallMainWorldDriverRequest {
  type: "INSTALL_MAIN_WORLD_DRIVER";
}
```
Add `| InstallMainWorldDriverRequest` to the `BackgroundRequest` union.

- [ ] **Step 2: Write the failing test**

```ts
// chrome-extension/test/installDriver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectMainWorldDriver } from "../src/background/serviceWorker";

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
  };
});

describe("injectMainWorldDriver", () => {
  it("injects mainWorld.js into the given frame in the MAIN world", async () => {
    const res = await injectMainWorldDriver(7, 3);
    expect(res.ok).toBe(true);
    const arg = (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({
      target: { tabId: 7, frameIds: [3] },
      world: "MAIN",
      files: ["mainWorld.js"],
    });
  });

  it("returns ok:false with a reason when injection throws", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("frame gone"));
    const res = await injectMainWorldDriver(7, 3);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/frame gone/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/installDriver.test.ts`
Expected: FAIL — `injectMainWorldDriver` not exported.

- [ ] **Step 4: Implement the helper + wire the listener**

In `chrome-extension/src/background/serviceWorker.ts` (`SimpleResponse` is already imported from `../shared/types` — do not re-import it), add near the top (after imports):

```ts
/** Inject the MAIN-world driver bundle into one frame. Idempotent (the script
 *  self-guards with window.__tailrdMWInstalled), so re-injection is harmless. */
export async function injectMainWorldDriver(tabId: number, frameId: number): Promise<SimpleResponse> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      files: ["mainWorld.js"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Driver injection failed" };
  }
}
```

Inside the `chrome.runtime.onMessage.addListener(...)` body, add this branch alongside the other sender‑aware relays (before the `handle(message)` call):

```ts
    if (message.type === "INSTALL_MAIN_WORLD_DRIVER") {
      const installTabId = _sender.tab?.id;
      const frameId = _sender.frameId ?? 0;
      if (installTabId === undefined) {
        sendResponse({ ok: false, error: "No tab" });
        return false;
      }
      void injectMainWorldDriver(installTabId, frameId).then(sendResponse);
      return true; // async response
    }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/installDriver.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `cd chrome-extension && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/background/serviceWorker.ts chrome-extension/test/installDriver.test.ts
git commit -m "feat(autofill): service worker injects the MAIN-world driver per frame"
```

---

### Task 6: react‑select driver routine

**Files:**
- Modify: `chrome-extension/src/content/mainWorldDriver.ts` (replace the `fillReactSelect` stub)
- Test: `chrome-extension/test/mainWorldDriver.test.ts` (add react‑select cases)

**Interfaces:**
- Consumes: `getFiber`, `climbFiber`, `pickOption`.
- Produces: working `fillReactSelect(el, value): Promise<string | null>` (Fiber `selectOption`/`onChange` path + DOM‑interaction fallback).

- [ ] **Step 1: Write the failing tests**

Append to `chrome-extension/test/mainWorldDriver.test.ts`:

```ts
import { FIELD_ID_ATTR } from "../src/shared/constants";

/** react-select container with a mock Fiber exposing selectOption(). */
function reactSelectWithFiber(fieldId: string, options: string[]): { display: HTMLElement } {
  const container = document.createElement("div");
  container.className = "rs__container";
  container.setAttribute(FIELD_ID_ATTR, fieldId);
  const control = document.createElement("div");
  control.className = "rs__control";
  const single = document.createElement("div");
  single.className = "rs__single-value";
  const input = document.createElement("input");
  input.id = "react-select-9-input";
  input.setAttribute("role", "combobox");
  control.append(single, input);
  container.append(control);
  document.body.append(container);

  const opts = options.map((label) => ({ label, value: label }));
  const instance = {
    props: { options: opts, getOptionLabel: (o: { label: string }) => o.label },
    selectOption: (o: { label: string }) => { single.textContent = o.label; },
  };
  const fiber = { return: null, stateNode: instance, memoizedProps: instance.props };
  (container as unknown as Record<string, unknown>)["__reactFiber$abc"] = fiber;
  return { display: single };
}

describe("fillReactSelect via Fiber", () => {
  it("calls selectOption for the matching option and reports committed text", async () => {
    installDriver(window);
    const { display } = reactSelectWithFiber("rs-1", ["United States", "Canada", "Mexico"]);
    const res = await drive("rs-1", "Canada", "react-select");
    expect(res.ok).toBe(true);
    expect(display.textContent).toBe("Canada");
    expect(res.committed).toBe("Canada");
  });

  it("reports no-match when the option is absent", async () => {
    installDriver(window);
    reactSelectWithFiber("rs-2", ["United States", "Canada"]);
    const res = await drive("rs-2", "Atlantis", "react-select");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-match");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts -t "fillReactSelect"`
Expected: FAIL — stub returns `null` (no-match) even for "Canada".

- [ ] **Step 3: Implement `fillReactSelect`**

Replace the `fillReactSelect` stub in `mainWorldDriver.ts` with:

```ts
interface RsInstance {
  props: {
    options?: unknown[];
    getOptionLabel?: (o: unknown) => string;
    onChange?: (o: unknown, meta: { action: string }) => void;
  };
  selectOption?: (o: unknown) => void;
}

function rsLabel(inst: RsInstance, opt: unknown): string {
  if (inst.props.getOptionLabel) return inst.props.getOptionLabel(opt);
  const o = opt as { label?: string; value?: string };
  return o.label ?? o.value ?? String(opt);
}

/** Flatten react-select options (supports grouped `{ options: [...] }`). */
function rsFlatten(options: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const o of options) {
    const grp = o as { options?: unknown[] };
    if (grp && Array.isArray(grp.options)) out.push(...grp.options);
    else out.push(o);
  }
  return out;
}

async function fillReactSelect(el: HTMLElement, value: string): Promise<string | null> {
  const container = el.closest('[class*="-container"], [class*="__container"]') ?? el;
  const inst = climbFiber(getFiber(container), (f) => {
    const sn = f.stateNode as RsInstance | null;
    return Boolean(sn && (typeof sn.selectOption === "function" || sn.props?.onChange) && Array.isArray(sn.props?.options));
  })?.stateNode as RsInstance | undefined;

  if (inst && inst.props.options) {
    const flat = rsFlatten(inst.props.options);
    const idx = pickOption(flat.map((o) => rsLabel(inst, o)), value);
    if (idx < 0) return null;
    const opt = flat[idx];
    if (typeof inst.selectOption === "function") inst.selectOption(opt);
    else inst.props.onChange?.(opt, { action: "select-option" });
    return rsLabel(inst, opt);
  }
  return fillReactSelectByDom(container as HTMLElement, value);
}

/** Fallback when no instance is found: open, filter, click the option in page context. */
async function fillReactSelectByDom(container: HTMLElement, value: string): Promise<string | null> {
  const input = container.querySelector<HTMLInputElement>('input[id^="react-select"], input[role="combobox"]');
  const opener = (input as HTMLElement) ?? container;
  fireMouse(opener, "mousedown");
  opener.focus?.();
  if (input) setNativeInputValue(input, value);
  await sleep(60);
  const menu = document.querySelector('[class*="-menu"], [class*="__menu"], [role="listbox"]');
  const options = menu ? Array.from(menu.querySelectorAll<HTMLElement>('[class*="-option"], [class*="__option"], [role="option"]')) : [];
  const idx = pickOption(options.map((o) => norm(o.textContent ?? "")), value);
  if (idx < 0) { fireKey(opener, "Escape"); return null; }
  fireMouse(options[idx], "mousedown");
  fireMouse(options[idx], "mouseup");
  options[idx].click();
  await sleep(30);
  const single = container.querySelector('[class*="-singleValue"], [class*="__single-value"], [class*="-single-value"]');
  return norm(single?.textContent ?? options[idx].textContent ?? "") || null;
}

function fireMouse(el: HTMLElement, type: string): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
}
function fireKey(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts`
Expected: PASS (all cases incl. react-select Fiber).

- [ ] **Step 5: Typecheck + build**

Run: `cd chrome-extension && npm run typecheck && npm run build`
Expected: PASS; `dist/mainWorld.js` rebuilt.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/mainWorldDriver.ts chrome-extension/test/mainWorldDriver.test.ts
git commit -m "feat(autofill): react-select MAIN-world driver (Fiber selectOption + DOM fallback)"
```

---

### Task 7: Isolated‑world client + content‑script routing

**Files:**
- Create: `chrome-extension/src/content/mainWorldClient.ts`
- Modify: `chrome-extension/src/content/contentScript.ts` (route driver fields)
- Test: `chrome-extension/test/mainWorldClient.test.ts`

**Interfaces:**
- Consumes: bridge events/types (Task 1); `chrome.runtime.sendMessage` (Task 5).
- Produces: `driveField(fieldId, value, kind, opts?): Promise<{ ok: boolean; committed?: string; reason?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/mainWorldClient.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { driveField, __resetDriverInstall } from "../src/content/mainWorldClient";
import { MW_FILL_EVENT, MW_RESULT_EVENT, type MwFillDetail } from "../src/content/mainWorldBridge";

beforeEach(() => {
  __resetDriverInstall();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true }) },
  };
});

/** Echo driver: replies ok to any fill request, after a tick. */
function installEcho(committed = "Canada"): void {
  window.addEventListener(MW_FILL_EVENT, (e) => {
    const d = (e as CustomEvent<MwFillDetail>).detail;
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(MW_RESULT_EVENT, { detail: { id: d.id, ok: true, committed } }));
    }, 0);
  });
}

describe("driveField", () => {
  it("requests install, sends a fill event, and resolves with the driver result", async () => {
    installEcho("Canada");
    const res = await driveField("f1", "Canada", "react-select");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "INSTALL_MAIN_WORLD_DRIVER" });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe("Canada");
  });

  it("soft-fails on timeout when no driver replies", async () => {
    // no echo installed
    const res = await driveField("f2", "Canada", "react-select", { timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/timeout/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/mainWorldClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```ts
// chrome-extension/src/content/mainWorldClient.ts
/**
 * Isolated-world side of the MAIN-world driver bridge. Ensures the driver is
 * injected into this frame (asking the service worker, which owns chrome.scripting),
 * then dispatches a fill request and awaits the matching result with a timeout.
 */
import {
  MW_FILL_EVENT,
  MW_RESULT_EVENT,
  type FillDriver,
  type MwFillDetail,
  type MwResultDetail,
} from "./mainWorldBridge";

export interface DriverResult { ok: boolean; committed?: string; reason?: string; }

const DEFAULT_TIMEOUT_MS = 2500;
let installed: Promise<boolean> | null = null;
let nextId = 1;

/** Test-only: forget the memoized install so each test starts clean. */
export function __resetDriverInstall(): void { installed = null; }

function ensureInstalled(): Promise<boolean> {
  if (!installed) {
    installed = chrome.runtime
      .sendMessage({ type: "INSTALL_MAIN_WORLD_DRIVER" })
      .then((r: { ok?: boolean } | undefined) => Boolean(r?.ok))
      .catch(() => false);
  }
  return installed;
}

export async function driveField(
  fieldId: string,
  value: string,
  kind: FillDriver,
  opts: { timeoutMs?: number } = {}
): Promise<DriverResult> {
  await ensureInstalled();
  const id = nextId++;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<DriverResult>((resolve) => {
    let done = false;
    const finish = (r: DriverResult): void => {
      if (done) return;
      done = true;
      window.removeEventListener(MW_RESULT_EVENT, onResult);
      clearTimeout(timer);
      resolve(r);
    };
    const onResult = (e: Event): void => {
      const d = (e as CustomEvent<MwResultDetail>).detail;
      if (!d || d.id !== id) return;
      finish({ ok: d.ok, committed: d.committed, reason: d.reason });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "driver-timeout" }), timeoutMs);
    window.addEventListener(MW_RESULT_EVENT, onResult);
    const detail: MwFillDetail = { id, fieldId, value, kind };
    window.dispatchEvent(new CustomEvent(MW_FILL_EVENT, { detail }));
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/mainWorldClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Route driver fields in the content script**

In `chrome-extension/src/content/contentScript.ts`, add the import:

```ts
import { driveField } from "./mainWorldClient";
```

Add a driver‑targets filler next to `fillComboboxTargets`:

```ts
  /** Fill react-select / Workday fields via the MAIN-world driver. */
  async function fillDriverTargets(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ fieldId: string; ok: boolean }[]> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    for (const t of targets) {
      const control = registry.get(t.fieldId);
      if (!control?.driver) { outcomes.push({ fieldId: t.fieldId, ok: false }); continue; }
      const res = await driveField(t.fieldId, t.value, control.driver);
      outcomes.push({ fieldId: t.fieldId, ok: res.ok });
    }
    return outcomes;
  }

  const isDriverField = (fieldId: string): boolean => Boolean(registry.get(fieldId)?.driver);
```

In `overlayCallbacks.onAutofill`, replace the target-splitting + combobox block with driver‑aware routing:

```ts
      const driverTargets = selected
        .filter((f) => isDriverField(f.id))
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const targets = selected
        .filter((f) => !isDriverField(f.id) && f.controlType !== "combobox")
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const localReports = await getEngine().run(targets, registry);

      const comboOutcomes = [
        ...(await fillComboboxTargets(
          selected
            .filter((f) => !isDriverField(f.id) && f.controlType === "combobox")
            .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }))
        )),
        ...(await fillDriverTargets(driverTargets)),
      ];
```

In the AI section, split driver fields out of `plan.simpleTargets` too:

```ts
            const aiDriver = plan.simpleTargets.filter((t) => isDriverField(t.fieldId));
            const aiCombo = plan.simpleTargets.filter((t) => !isDriverField(t.fieldId) && isComboboxField(t.fieldId));
            const aiSimple = plan.simpleTargets.filter((t) => !isDriverField(t.fieldId) && !isComboboxField(t.fieldId));
            if (aiSimple.length > 0) aiReports = await getEngine().addTargets(aiSimple, registry);
            if (aiCombo.length > 0) aiComboOutcomes = await fillComboboxTargets(aiCombo);
            if (aiDriver.length > 0) aiComboOutcomes = [...aiComboOutcomes, ...(await fillDriverTargets(aiDriver))];
```

In `onInsertAnswer`, handle driver controls before the combobox branch:

```ts
      if (control.driver) {
        const res = await driveField(fieldId, value, control.driver);
        return res.ok
          ? { ok: true }
          : { ok: false, reason: res.reason ?? "Couldn't select that option — choose it manually." };
      }
```

- [ ] **Step 6: Typecheck + full suite + build**

Run: `cd chrome-extension && npm run typecheck && npm test && npm run build`
Expected: PASS across the board; `dist/` includes `serviceWorker.js`, `contentScript.js`, `mainWorld.js`.

- [ ] **Step 7: Commit**

```bash
git add chrome-extension/src/content/mainWorldClient.ts chrome-extension/src/content/contentScript.ts chrome-extension/test/mainWorldClient.test.ts
git commit -m "feat(autofill): route react-select/Workday fields through the MAIN-world driver"
```

---

### Task 8: Workday driver routine

**Files:**
- Modify: `chrome-extension/src/content/mainWorldDriver.ts` (replace the `fillWorkday` stub)
- Test: `chrome-extension/test/mainWorldDriver.test.ts` (add Workday cases)

**Interfaces:**
- Consumes: `getFiber`, `climbFiber`, `pickOption`, `fireMouse`, `sleep`.
- Produces: working `fillWorkday(el, value): Promise<string | null>` (Fiber `onChange` path + `data-automation-id` prompt‑option DOM fallback).

- [ ] **Step 1: Write the failing tests**

Append to `chrome-extension/test/mainWorldDriver.test.ts`:

```ts
/** Workday prompt: button + on-click list of [data-automation-id=promptOption]. */
function workdayPrompt(fieldId: string, options: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-automation-id", "multiSelectContainer");
  wrap.setAttribute(FIELD_ID_ATTR, fieldId);
  const btn = document.createElement("button");
  btn.setAttribute("data-automation-id", "promptButton");
  btn.textContent = "Select One";
  wrap.append(btn);
  document.body.append(wrap);

  btn.addEventListener("mousedown", () => {
    if (wrap.querySelector('[data-automation-id="promptOption"]')) return;
    for (const label of options) {
      const o = document.createElement("div");
      o.setAttribute("data-automation-id", "promptOption");
      o.textContent = label;
      o.addEventListener("mousedown", () => { btn.textContent = label; o.parentElement?.querySelectorAll('[data-automation-id="promptOption"]').forEach((n) => n.remove()); });
      wrap.append(o);
    }
  });
  return wrap;
}

describe("fillWorkday via DOM prompt", () => {
  it("opens the prompt and selects the matching option", async () => {
    installDriver(window);
    const wrap = workdayPrompt("wd-1", ["United States", "Canada"]);
    const res = await drive("wd-1", "Canada", "workday");
    expect(res.ok).toBe(true);
    expect(wrap.querySelector('[data-automation-id="promptButton"]')?.textContent).toBe("Canada");
  });
});

describe("fillWorkday via Fiber onChange", () => {
  it("invokes the widget's onChange with the matched option", async () => {
    installDriver(window);
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "selectinput");
    wrap.setAttribute(FIELD_ID_ATTR, "wd-2");
    document.body.append(wrap);
    let chosen: string | null = null;
    const props = {
      options: [{ label: "Female", value: "f" }, { label: "Male", value: "m" }],
      onChange: (o: { label: string }) => { chosen = o.label; },
    };
    (wrap as unknown as Record<string, unknown>)["__reactFiber$z"] = { return: null, stateNode: null, memoizedProps: props };
    const res = await drive("wd-2", "Female", "workday");
    expect(res.ok).toBe(true);
    expect(chosen).toBe("Female");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts -t "fillWorkday"`
Expected: FAIL — stub returns `null`.

- [ ] **Step 3: Implement `fillWorkday`**

Replace the `fillWorkday` stub in `mainWorldDriver.ts` with:

```ts
interface WorkdayProps {
  options?: unknown[];
  onChange?: (o: unknown) => void;
  onValueChange?: (o: unknown) => void;
}

/** Prefer the widget's React onChange (via memoizedProps on the fiber), else drive
 *  Workday's `data-automation-id` prompt list in page context. */
async function fillWorkday(el: HTMLElement, value: string): Promise<string | null> {
  const widget = el.closest("[data-automation-id]") ?? el;

  const propFiber = climbFiber(getFiber(widget), (f) => {
    const p = f.memoizedProps as WorkdayProps | null;
    return Boolean(p && Array.isArray(p.options) && (p.onChange || p.onValueChange));
  });
  const props = propFiber?.memoizedProps as WorkdayProps | undefined;
  if (props?.options) {
    const labels = props.options.map((o) => {
      const x = o as { label?: string; value?: string };
      return x.label ?? x.value ?? String(o);
    });
    const idx = pickOption(labels, value);
    if (idx < 0) return null;
    (props.onChange ?? props.onValueChange)?.(props.options[idx]);
    return labels[idx];
  }

  // DOM fallback: open the prompt, wait for options, click the match.
  const opener = widget.querySelector<HTMLElement>('[data-automation-id="promptButton"], button') ?? (widget as HTMLElement);
  fireMouse(opener, "mousedown");
  fireMouse(opener, "click");
  await sleep(80);
  const options = Array.from(
    (widget.ownerDocument ?? document).querySelectorAll<HTMLElement>('[data-automation-id="promptOption"], [role="option"]')
  );
  const idx = pickOption(options.map((o) => norm(o.textContent ?? "")), value);
  if (idx < 0) return null;
  fireMouse(options[idx], "mousedown");
  fireMouse(options[idx], "mouseup");
  options[idx].click();
  await sleep(30);
  return norm(opener.textContent ?? options[idx].textContent ?? "") || null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chrome-extension && npx vitest run test/mainWorldDriver.test.ts`
Expected: PASS (react-select + Workday cases).

- [ ] **Step 5: Typecheck + build**

Run: `cd chrome-extension && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add chrome-extension/src/content/mainWorldDriver.ts chrome-extension/test/mainWorldDriver.test.ts
git commit -m "feat(autofill): Workday MAIN-world driver (Fiber onChange + prompt-option DOM fallback)"
```

---

### Task 9: Real‑browser integration test (react‑select)

**Files:**
- Create: `chrome-extension/test/browser/react-select-driver.mjs`
- Test: itself (a Playwright runner)

**Interfaces:**
- Consumes: built `dist/mainWorld.js`; the bridge event names.
- Produces: a pass/fail runner proving a REAL react-select commits via the driver in Chromium.

- [ ] **Step 1: Write the runner (this IS the test)**

```js
// chrome-extension/test/browser/react-select-driver.mjs
/**
 * Loads a REAL react-select (React 18 + react-select from esm.sh) into Chromium,
 * injects the shipping dist/mainWorld.js, dispatches a fill request over the
 * bridge, and asserts the value commits through the widget's own React state —
 * the exact path jsdom cannot exercise.
 *
 * Usage: npm run build && node test/browser/react-select-driver.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_WORLD = readFileSync(path.join(here, "..", "..", "dist", "mainWorld.js"), "utf8");
const FIELD_ID_ATTR = "data-ap-field";

const PAGE = `<!doctype html><html><body><div id="root"></div>
<script type="module">
  import React from "https://esm.sh/react@18";
  import { createRoot } from "https://esm.sh/react-dom@18/client";
  import Select from "https://esm.sh/react-select@5?deps=react@18,react-dom@18";
  const options = [{value:"us",label:"United States"},{value:"ca",label:"Canada"},{value:"mx",label:"Mexico"}];
  function App(){
    const [v,setV] = React.useState(null);
    return React.createElement("div", { className:"rs__container", "${FIELD_ID_ATTR}":"rs-real-1" },
      React.createElement(Select, { classNamePrefix:"rs", options, value:v, onChange:setV }),
      React.createElement("div", { id:"chosen" }, v ? v.label : ""));
  }
  createRoot(document.getElementById("root")).render(React.createElement(App));
  window.__ready = true;
</script></body></html>`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForSelector(".rs__control");
  // The wrapper div already carries FIELD_ID_ATTR (set in the fixture markup), so
  // the driver locates it directly; react-select's Fiber lives on the subtree the
  // driver climbs from via closest('[class*="-container"]').
  await page.addScriptTag({ content: MAIN_WORLD });

  const committed = await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener("tailrd:mw:result", (e) => resolve(e.detail), { once: true });
    window.dispatchEvent(new CustomEvent("tailrd:mw:fill", {
      detail: { id: 1, fieldId: "rs-real-1", value: "Canada", kind: "react-select" },
    }));
    setTimeout(() => resolve({ ok: false, reason: "timeout" }), 4000);
  }));

  const shown = await page.textContent("#chosen");
  await browser.close();

  const ok = committed.ok && String(shown).trim() === "Canada";
  console.log(`react-select driver: committed=${JSON.stringify(committed)} shown="${shown}" → ${ok ? "✅ PASS" : "❌ FAIL"}`);
  if (!ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add an npm script**

In `chrome-extension/package.json` `scripts`, add:

```json
    "test:driver": "node build.mjs && node test/browser/react-select-driver.mjs",
```

- [ ] **Step 3: Run it**

Run: `cd chrome-extension && npm run test:driver`
Expected: `react-select driver: … → ✅ PASS`. (If Playwright's Chromium is not installed, run `npx playwright install chromium` once.)

Note: if the driver's `closest('[class*="-container"]')` does not resolve to a node carrying a Fiber with the react-select instance, adjust `fillReactSelect` to climb from the `.rs__control` element's fiber (react-select's `Select` instance is on the control subtree). Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/test/browser/react-select-driver.mjs chrome-extension/package.json
git commit -m "test(autofill): real-Chromium react-select driver integration test"
```

---

### Task 10: Docs + final verification

**Files:**
- Modify: `docs/autofill-rebuild/jobright-reference-analysis.md` (mark Phase 1 status)
- Test: full suite

- [ ] **Step 1: Full verification**

Run: `cd chrome-extension && npm run typecheck && npm test && npm run build && npm run test:driver`
Expected: all PASS.

- [ ] **Step 2: Note Phase 1 completion**

Append to `docs/autofill-rebuild/jobright-reference-analysis.md` under §15 Phase 1:

```markdown
> **Phase 1 status (2026-07-01):** Implemented — MAIN-world react-select & Workday drivers behind targeted detection. See `docs/superpowers/specs/2026-07-01-autofill-write-reliability-core-design.md` and the plan of the same date.
```

- [ ] **Step 3: Commit**

```bash
git add docs/autofill-rebuild/jobright-reference-analysis.md
git commit -m "docs(autofill): mark Phase 1 write-reliability core complete"
```

---

## Self-Review notes

- **Spec coverage:** detection (Task 2/3 → spec §4.1), client (Task 7 → §4.2), worker install (Task 5 → §4.3), MAIN driver + guard + bridge (Task 4 → §4.4/4.5), react-select (Task 6 → §5.1), Workday (Task 8 → §5.2), integration point (Task 7 → §6), error/timeout/idempotency (Tasks 4/7 → §7), manifest/build (Task 4 → §8), tests (Tasks 2–9 → §9), acceptance criteria 1–6 (Tasks 6/8/9 real-browser + unit + build gates).
- **Deferred within Phase 1 (documented risk, not a gap):** the react-select browser test may require climbing the Fiber from the `.rs__control` subtree rather than the wrapper — Task 9 Step 3 calls this out with the concrete fix. Workday real-site validation is left to manual/extension-harness testing since no public Workday React fixture exists; jsdom mock-fiber + prompt-DOM tests (Task 8) pin the two code paths.
- **Type consistency:** `driveField(fieldId,value,kind,opts?)`, `DriverResult{ok,committed?,reason?}`, `MwFillDetail{id,fieldId,value,kind}`, `MwResultDetail{id,ok,committed?,reason?}`, `FillDriver`, `detectFillDriver(el,hostname?)`, `injectMainWorldDriver(tabId,frameId)`, `installDriver(win)`, `pickOption(labels,target)` are used consistently across tasks.
