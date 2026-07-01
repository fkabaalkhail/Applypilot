# Autofill Write‑Reliability Core — MAIN‑world drivers for react‑select & Workday

- **Date:** 2026-07-01
- **Status:** Approved (design)
- **Branch:** `feature/autofill-rebuild`
- **Phase:** 1 of the Jobright‑parity rebuild (see `docs/autofill-rebuild/jobright-reference-analysis.md` §15)
- **Scope owner module set:** `chrome-extension/`

## 1. Problem & goal

Our isolated‑world write path (`writeEngine.ts`, `comboboxEngine.ts`) is solid for native inputs, native `<select>`, checkboxes/radios, contenteditable, ARIA radio groups, and well‑behaved ARIA comboboxes. It still fails on the two widget families that dominate real ATS forms:

- **react‑select** (Greenhouse, Lever, Ashby, and many others) — synthetic clicks on option nodes don't always commit; the widget manages its selection through its React instance.
- **Workday** (`*.myworkdayjobs.com`, the single highest‑volume ATS) — prompt/multiselect/date widgets are driven by an internal React component system that DOM‑event simulation cannot reliably satisfy.

**Goal:** make fills *commit reliably* on react‑select and Workday by adding a MAIN‑world driver harness that reaches each widget's React internals, while leaving the working isolated engine untouched for everything else.

### Why MAIN world is required (the crux)

Chrome isolates content scripts in a separate JS world. Isolated and MAIN worlds **share the live DOM tree** but **not JS expando properties** set on nodes. React attaches its Fiber to each host node under a `__reactFiber$<hash>` (and `__reactProps$<hash>`) key. Those keys are **invisible from the isolated content script**. The reliable way to drive react‑select/Workday is to read the Fiber, locate the component instance, and invoke its real `onChange`/`selectOption` callback — which can only happen **in the page's MAIN world where React runs**. This is the exact technique the Jobright reference uses (`injectReactSelectFiber`, `injectWorkdayFiber` via `chrome.scripting` `world:"MAIN"`), re‑derived here from behavior, not copied.

## 2. Non‑goals (explicitly deferred to later phases)

- Per‑site ATS adapter framework (`rules`/`answer`/`operations`) and new ATS breadth.
- AI‑primary answering / rule caching.
- iframe "agent apply" and `declarativeNetRequest` header stripping.
- Repeating‑group (education/employment) operations.
- Any change to how answers are *sourced*; Phase 1 only changes how a resolved value is *written* to two widget families.

## 3. Architecture — targeted drivers

```
 formScanner (isolated)         mainWorldClient (isolated)        serviceWorker (worker)         mainWorld.js (MAIN)
 ─────────────────────          ──────────────────────────        ──────────────────────         ────────────────────
 tags control.driver   ──▶      driveField(fieldId,value,kind)
                                   ├─ ensureInstalled() ──msg──▶  installMainWorldDriver
                                   │                                 executeScript{world:MAIN,   ──▶ install once/frame
                                   │                                   frameIds:[sender.frameId], func→listener guarded
                                   │                                   files:["mainWorld.js"]}         by window.__tailrdMWInstalled
                                   └─ CustomEvent tailrd:mw:fill ───────────────────────────────▶  locate [data-tailrd-fid],
 verifyControl(isolated) ◀── DOM  ◀──────────── CustomEvent tailrd:mw:result ──────────────────────  read Fiber, call React
 reads committed display text                                                                        onChange / selectOption
```

Only `customDropdown`/`combobox` controls whose `driver` is `"react-select"` or `"workday"` take the MAIN‑world path. Every other control keeps its current isolated path with **no behavior change**.

## 4. Components & interfaces

### 4.1 `formScanner.ts` — driver tagging
Extend `RuntimeControl` with an optional discriminator:
```ts
export type FillDriver = "react-select" | "workday";
interface RuntimeControl {
  // …existing fields…
  driver?: FillDriver;   // set only for customDropdown/combobox controls
}
```
Detection signatures (must be conservative — a false positive routes a normal field through injection):
- **react‑select:** an ancestor matching `[class*="-container"]` that also contains `input[id^="react-select"]`, or the classic `[class$="__control"]`/`[class*="-control"]` + `[class*="-indicatorContainer"]` shape. Require at least the container **and** the react‑select input/id pattern.
- **workday:** `location.hostname` ends with a Workday host (`myworkdayjobs.com`, `myworkday.com`, `myworkdayjobs-impl.com`, `myworkdaysite.com`) **and** the control (or ancestor) carries `[data-automation-id]`.

Tagging happens during scan; the value continues to flow through the normal resolve pipeline. `formScanner` already stamps each field with `FIELD_ID_ATTR` — reuse that as the cross‑world locator (call it `fid` below).

### 4.2 `mainWorldClient.ts` (new, isolated)
```ts
export interface DriverResult { ok: boolean; committed?: string; reason?: string; }
export function driveField(fid: string, value: string, kind: FillDriver,
                           opts?: { timeoutMs?: number }): Promise<DriverResult>;
```
- `ensureInstalled()` — sends `installMainWorldDriver` to the worker at most once per frame (memoized Promise). Resolves when the worker confirms injection.
- `driveField` — assigns a monotonic request `id`, dispatches `tailrd:mw:fill`, resolves on the matching `tailrd:mw:result` or rejects/soft‑fails on timeout (default **2500 ms**). Never throws to callers; timeout ⇒ `{ ok:false, reason:"driver-timeout" }`.

### 4.3 `serviceWorker.ts` — `installMainWorldDriver` handler
```ts
// message: { type: "installMainWorldDriver" }; sender provides tabId + frameId
chrome.scripting.executeScript({
  target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
  world: "MAIN",
  files: ["mainWorld.js"],
});
```
Idempotent: the injected script self‑guards with `window.__tailrdMWInstalled`; re‑injection is harmless. Returns `{ ok: true }` (or `{ ok:false, reason }` on injection error) to the client. Content scripts cannot call `chrome.scripting`, which is why installation is brokered by the worker using `sender.frameId`.

### 4.4 `mainWorld.ts` (new, MAIN world, bundled to `mainWorld.js`)
Self‑contained, no `chrome.*`, no imports from isolated modules (bundled standalone). On load:
1. If `window.__tailrdMWInstalled` return; else set it.
2. Add a `tailrd:mw:fill` listener. For each request: locate `document.querySelector([data-<FIELD_ID_ATTR>="fid"])`; dispatch to the `react-select` or `workday` routine; reply with `tailrd:mw:result` `{ id, ok, committed, reason }`. Catches all errors → `{ ok:false, reason }` (never throws into the page).

### 4.5 Bridge protocol
- Request event `tailrd:mw:fill`, `detail = { id, fid, value, kind }`.
- Response event `tailrd:mw:result`, `detail = { id, ok, committed?, reason? }`.
- `detail` is JSON‑only (CustomEvent detail is cloned across worlds; no live objects/functions). Correlate by `id`. The client ignores results with unknown ids.

## 5. Driver behavior

Shared helper (ported page‑side, mirrors `matchOption` semantics — exact → contains → numeric‑range → token overlap): `pickOption(candidates, target)`.

### 5.1 react‑select
1. Locate the container from the stamped node (climb to `[class*="-container"]`).
2. Read Fiber (`node[keyStartingWith("__reactFiber$")]`), walk up to the `StateManager`/`Select` instance whose `props` expose `options`, `onChange`, and `getOptionLabel`/`getOptionValue` (or `selectOption`).
3. `match = pickOption(props.options.map(label))`; if found, call the instance's commit path: prefer `instance.selectOption(option)`, else `props.onChange(option, { action: "select-option" })`.
4. **Fallback (no instance/props):** page‑context interaction — focus the internal `input`, native‑set its value + dispatch `input` to filter, then `pointerdown`+`mouseup`+`click` the rendered `[class*="-option"]` whose text matches. Page‑context events at least share React's world.
5. Return `committed` = the container's single/multi‑value display text.

### 5.2 Workday
1. Locate the widget by nearest `[data-automation-id]`; classify by automation id (prompt/multiselect, dropdown, date, checkbox).
2. Read Fiber; find the component exposing the relevant callback (`onChange`/`onOptionClick`/date setter); invoke it with the matched option/value.
3. **Fallback:** Workday's documented DOM sequence in page context (open the prompt, wait for the option list `[data-automation-id*="promptOption"]`, click the match; for dates, set the three `spinbutton` inputs).
4. Return `committed` = the widget's rendered selected text/value.

Implementation order within Phase 1: **react‑select first** (broadest impact, simpler), **Workday second** (harder, highest single‑ATS volume). Both ship in Phase 1.

## 6. Integration point

The isolated orchestrator (currently in `contentScript.ts`/`reconciler.ts`, wherever `customDropdown`/`combobox` controls are routed to `comboboxEngine.fillAriaCombobox`) gains one branch:
```
if (control.driver) result = await driveField(fid, value, control.driver);
else                result = await fillAriaCombobox(trigger, value);
```
`verifyControl` is unchanged: it re‑reads the committed value from the DOM display, which is visible cross‑world. The reconciler treats a driver `{ok:false}` exactly like a failed combobox fill today (reports `needs-manual`).

## 7. Error handling, idempotency, concurrency

- **Timeout:** client soft‑fails after 2500 ms → `needs-manual`; never blocks the reconciler.
- **Install failure** (strict CSP / Trusted Types, rare for `world:"MAIN"` injection): fall back to the existing isolated `fillAriaCombobox` attempt for that field.
- **Idempotency:** `window.__tailrdMWInstalled` guard; already‑correct fields short‑circuit before opening anything (mirror `comboboxShowsValue`); request `id`s prevent cross‑talk.
- **Concurrency:** fills are sequential (reconciler drives one field at a time); the driver handles one request at a time per frame. No shared mutable page state beyond the install guard.
- **Frames:** each frame installs its own driver instance (keyed by `sender.frameId`); events stay within a frame's `window`.

## 8. Manifest & build changes

- `build.mjs`: add entry `{ in: "src/content/mainWorld.ts", out: "mainWorld" }` (IIFE, same as others).
- `manifest.json`: add
  ```json
  "web_accessible_resources": [
    { "resources": ["mainWorld.js"], "matches": ["<all_urls>"] }
  ]
  ```
  `scripting` permission already present. No new host permissions. No remote code, no `eval`.

## 9. Testing strategy

- **vitest / jsdom (unit):** driver‑tagging in `formScanner` (react‑select & Workday fixtures → `driver` set; normal fields → unset); Fiber‑walk helpers against a hand‑built mock fiber object; `pickOption` parity with `matchOption`; bridge request/response correlation & timeout in `mainWorldClient` (fake event target); worker handler targets the right `frameId`.
- **Playwright (integration, existing `test/browser/` harness):** load the built unpacked extension against (a) a real react‑select page and (b) a Workday‑shaped fixture; assert the value **commits** (display text + underlying form state) and that `verifyControl` reports success. Add these fixtures under `test/browser/`.
- **Regression:** existing combobox/native tests must stay green (isolated path unchanged).

## 10. Acceptance criteria

1. A react‑select field resolved to a valid option commits and verifies, in the top frame and in an iframe.
2. A Workday prompt/dropdown and a Workday date field commit and verify.
3. Non‑driver controls behave identically to today (no new injection, unit tests unchanged).
4. Driver failures degrade to `needs-manual` within the timeout without hanging the pass.
5. Injection happens at most once per frame; re‑running autofill does not re‑inject or double‑fill.
6. `npm run build`, `npm run typecheck`, `npm test` all pass; new Playwright tests pass locally.

## 11. Risks & mitigations

- **react‑select internals vary by version** → prefer `selectOption`/`onChange` discovered from props (version‑tolerant); DOM fallback covers the rest.
- **Workday variety** (many automation‑id widgets) → Phase 1 targets prompt/dropdown/date; unknown Workday widgets fall back to isolated/`needs-manual`, not errors.
- **False‑positive driver tagging** routes a normal field through injection → detection requires strong signatures; when the driver finds no instance it falls back gracefully.
- **CustomEvent cloning** limits detail to JSON → protocol is JSON‑only by design.
