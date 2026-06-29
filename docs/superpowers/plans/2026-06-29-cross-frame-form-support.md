# Cross-Frame Form Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overlay detect and fill a job-application form that lives in a cross-origin iframe (e.g. Databricks' embedded `job-boards.greenhouse.io` form), with the panel UI staying pinned in the top frame.

**Architecture:** Every frame scans autonomously. The frame with the most recognized fields is the "form host." When the top frame has the form (the common case) nothing changes — the overlay calls its callbacks locally. When a **child** frame is the host, the top-frame overlay mounts with **proxy callbacks** that marshal each call as a generic `FORM_OP {op, args}` message; the background relays it to the host frame (by `frameId`), which runs the real implementation against its own registry and returns the result. A push channel relays the host frame's field updates (rescan / profile-resolved / mutation observer) back up to the top-frame overlay. Field ids already carry a per-frame `FRAME_TOKEN`, so fills route to the right frame.

**Tech Stack:** TypeScript, Chrome MV3 (`chrome.runtime` / `chrome.tabs.sendMessage` with `{frameId}`), esbuild, vitest + jsdom.

## Global Constraints

- Content scripts cannot message each other directly; cross-frame traffic **must** relay through the background service worker (`chrome.tabs.sendMessage(tabId, msg, {frameId})`). Never use `window.postMessage` for profile/answer data — that would leak PII to the page.
- The **local path must be behaviorally unchanged**: when the top frame owns the form, no cross-frame messaging happens and the overlay works exactly as today.
- Reuse the existing `FRAME_TOKEN` (in `formScanner.ts`) for field-ownership; do not invent a second id scheme.
- Run tests with `node node_modules/vitest/vitest.mjs run <file>` (the `npm test` wrapper is flaky in this shell). Typecheck with `node node_modules/typescript/lib/tsc.js --noEmit`. Build with `node build.mjs`.
- Keep `OverlayCallbacks` (in `overlay.ts`) unchanged — both the local impl and the proxy implement that exact interface.
- Chrome message handlers that respond asynchronously **must `return true`** from the `onMessage` listener.

---

## File Structure

- `src/shared/types.ts` — add cross-frame message types + extend the request unions.
- `src/content/crossFrame.ts` (**new**) — pure, unit-testable helpers: form-host selection, proxy-callback factory (transport-injected), and form-op dispatch. No `chrome.*`, no DOM.
- `src/content/contentScript.ts` — wire it up: autonomous child scanning, host announce, `FORM_OP` dispatch, top-frame adoption + proxy mount, and the field-update push indirection (`reportFields`).
- `src/background/serviceWorker.ts` — stateless relay between frames of a tab.
- `test/crossFrame.test.ts` (**new**) — unit tests for `crossFrame.ts`.

---

## Task 1: Cross-frame message types

**Files:**
- Modify: `src/shared/types.ts` (append near the existing `ContentRequest` / `FieldsUpdatedEvent` definitions, ~line 336-382)

**Interfaces:**
- Produces: `FormOpName` (string union of the 14 `OverlayCallbacks` method names); `FormOpRequest {type:"FORM_OP"; op: FormOpName; args: unknown[]}`; `FormOpResult {ok: boolean; value?: unknown; error?: string}`; `FormHostAnnounce {type:"FORM_HOST_ANNOUNCE"; recognized: number}`; `RemoteFormAvailable {type:"REMOTE_FORM_AVAILABLE"; frameId: number; recognized: number; fields: DetectedField[]}`; `RemoteFieldsUpdated {type:"REMOTE_FIELDS_UPDATED"; fields: DetectedField[]}`; `RelayFormOp {type:"RELAY_FORM_OP"; frameId: number; op: FormOpName; args: unknown[]}`; `RelayToTop {type:"RELAY_TO_TOP"; payload: RemoteFormAvailable | RemoteFieldsUpdated}`.

- [ ] **Step 1: Add the types**

Append to `src/shared/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// Cross-frame form support (form lives in a child iframe; panel in top frame)
// ---------------------------------------------------------------------------

/** Every OverlayCallbacks method name — the generic form-op surface. */
export type FormOpName =
  | "onAutofill"
  | "onInsertAnswer"
  | "onSaveAnswer"
  | "onRescan"
  | "onListResumes"
  | "onUploadResume"
  | "onTailorResume"
  | "onAttachTailored"
  | "onDownloadTailored"
  | "onGenerateCoverLetter"
  | "onInsertCoverLetter"
  | "onDownloadCoverLetter"
  | "onCopyCoverLetter"
  | "onProfileResolved";

/** One overlay operation, marshaled for execution in the form-owning frame. */
export interface FormOpRequest {
  type: "FORM_OP";
  op: FormOpName;
  args: unknown[];
}

/** Result of a FORM_OP, wrapping the callback's return value. */
export interface FormOpResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** A child frame telling the top frame it owns a real form. */
export interface RemoteFormAvailable {
  type: "REMOTE_FORM_AVAILABLE";
  frameId: number;
  recognized: number;
  fields: DetectedField[];
}

/** A child host pushing fresh fields (rescan / profile / mutation) to the top. */
export interface RemoteFieldsUpdated {
  type: "REMOTE_FIELDS_UPDATED";
  fields: DetectedField[];
}

/** Child → background: "I own a form." Background forwards as REMOTE_FORM_AVAILABLE. */
export interface FormHostAnnounce {
  type: "FORM_HOST_ANNOUNCE";
  recognized: number;
  fields: DetectedField[];
}

/** Top → background → host frame: run this overlay op in the owning frame. */
export interface RelayFormOp {
  type: "RELAY_FORM_OP";
  frameId: number;
  op: FormOpName;
  args: unknown[];
}

/** Host → background → top frame (frameId 0): deliver a push payload. */
export interface RelayToTop {
  type: "RELAY_TO_TOP";
  payload: RemoteFormAvailable | RemoteFieldsUpdated;
}
```

- [ ] **Step 2: Extend the `ContentRequest` union** so the content-script `onMessage` listener accepts the new inbound messages. Change (around line 336):

```typescript
export type ContentRequest =
  | { type: "PING" }
  | { type: "TOGGLE_PANEL" }
  | {
      type: "SCAN_PAGE";
      profile: UserApplicationProfile | null;
      fillEEO: boolean;
    }
  | { type: "FILL_FIELDS"; instructions: FillInstruction[] }
  | FormOpRequest
  | RemoteFormAvailable
  | RemoteFieldsUpdated;
```

- [ ] **Step 3: Extend `BackgroundRequest`** so the background relay handlers are typed (around line 387):

```typescript
export type BackgroundRequest =
  | { type: "GET_STATUS" }
  // …existing variants unchanged…
  | { type: "RENDER_COVER_LETTER"; text: string; filename?: string }
  | FormHostAnnounce
  | RelayFormOp
  | RelayToTop;
```

- [ ] **Step 4: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS (no usages yet; this only adds types). If the background's `onMessage` handler now fails exhaustiveness, that is fixed in Task 4 — if it errors here, proceed; Task 4 resolves it.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(extension): cross-frame form message types"
```

---

## Task 2: Pure cross-frame helpers (host selection + proxy + dispatch)

**Files:**
- Create: `src/content/crossFrame.ts`
- Test: `test/crossFrame.test.ts`

**Interfaces:**
- Consumes: `FormOpName`, `FormOpResult` (Task 1); `OverlayCallbacks` (from `overlay.ts`).
- Produces:
  - `shouldAdoptRemoteHost(localRecognized: number, remoteRecognized: number): boolean` — true iff the top frame should defer to a child host (local has none, remote has ≥1).
  - `makeProxyCallbacks(send: (op: FormOpName, args: unknown[]) => Promise<FormOpResult>): OverlayCallbacks` — an OverlayCallbacks whose every method marshals through `send` and unwraps `.value` (void methods ignore the result).
  - `dispatchFormOp(ops: OverlayCallbacks, op: FormOpName, args: unknown[]): Promise<FormOpResult>` — invokes `ops[op](...args)`, wraps the return in `{ok:true, value}` or `{ok:false, error}`.

- [ ] **Step 1: Write the failing tests**

Create `test/crossFrame.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { shouldAdoptRemoteHost, makeProxyCallbacks, dispatchFormOp } from "../src/content/crossFrame";
import type { OverlayCallbacks } from "../src/content/overlay";

describe("shouldAdoptRemoteHost", () => {
  it("adopts a child host only when the top frame has no recognized fields", () => {
    expect(shouldAdoptRemoteHost(0, 5)).toBe(true);
    expect(shouldAdoptRemoteHost(3, 5)).toBe(false); // top owns its own form → keep local
    expect(shouldAdoptRemoteHost(0, 0)).toBe(false); // remote has nothing either
  });
});

describe("makeProxyCallbacks", () => {
  it("marshals onAutofill through the transport and unwraps the value", async () => {
    const send = vi.fn(async (_op, _args) => ({ ok: true, value: { ok: 2, fail: 0, total: 2, drafts: [] } }));
    const cb = makeProxyCallbacks(send);
    const res = await cb.onAutofill(["a", "b"]);
    expect(send).toHaveBeenCalledWith("onAutofill", [["a", "b"]]);
    expect(res).toEqual({ ok: 2, fail: 0, total: 2, drafts: [] });
  });

  it("fires void methods (onProfileResolved) through the transport without throwing", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const cb = makeProxyCallbacks(send);
    cb.onProfileResolved(null);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("onProfileResolved", [null]);
  });
});

describe("dispatchFormOp", () => {
  it("invokes the named callback with the args and wraps the result", async () => {
    const ops = { onInsertAnswer: vi.fn(async () => ({ ok: true })) } as unknown as OverlayCallbacks;
    const res = await dispatchFormOp(ops, "onInsertAnswer", ["f-1", "hi"]);
    expect((ops.onInsertAnswer as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("f-1", "hi");
    expect(res).toEqual({ ok: true, value: { ok: true } });
  });

  it("wraps a thrown error as ok:false", async () => {
    const ops = { onRescan: () => { throw new Error("boom"); } } as unknown as OverlayCallbacks;
    const res = await dispatchFormOp(ops, "onRescan", []);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run test/crossFrame.test.ts`
Expected: FAIL — `Cannot find module '../src/content/crossFrame'`.

- [ ] **Step 3: Implement `crossFrame.ts`**

Create `src/content/crossFrame.ts`:

```typescript
/**
 * Pure cross-frame helpers — no chrome.* and no DOM, so they unit-test cleanly.
 * The chrome-messaging plumbing that uses these lives in contentScript.ts.
 */
import type { FormOpName, FormOpResult } from "../shared/types";
import type { OverlayCallbacks } from "./overlay";

/** Void callbacks: the proxy fires them and does not wait for a value. */
const VOID_OPS: ReadonlySet<FormOpName> = new Set<FormOpName>(["onRescan", "onProfileResolved"]);

/** The top frame defers to a child host only when it has no form of its own. */
export function shouldAdoptRemoteHost(localRecognized: number, remoteRecognized: number): boolean {
  return localRecognized === 0 && remoteRecognized > 0;
}

/**
 * An OverlayCallbacks whose every method marshals to `send(op, args)` and
 * returns the unwrapped value. Void methods (rescan / profile-resolved) fire
 * and forget — the host pushes fields back over the update channel.
 */
export function makeProxyCallbacks(
  send: (op: FormOpName, args: unknown[]) => Promise<FormOpResult>
): OverlayCallbacks {
  const call = (op: FormOpName, args: unknown[]): Promise<unknown> =>
    send(op, args).then((r) => {
      if (!r.ok) throw new Error(r.error ?? `Form op ${op} failed`);
      return r.value;
    });

  const proxy = {} as Record<FormOpName, (...args: unknown[]) => unknown>;
  const ALL: FormOpName[] = [
    "onAutofill", "onInsertAnswer", "onSaveAnswer", "onRescan", "onListResumes",
    "onUploadResume", "onTailorResume", "onAttachTailored", "onDownloadTailored",
    "onGenerateCoverLetter", "onInsertCoverLetter", "onDownloadCoverLetter",
    "onCopyCoverLetter", "onProfileResolved",
  ];
  for (const op of ALL) {
    proxy[op] = VOID_OPS.has(op)
      ? (...args: unknown[]) => { void call(op, args).catch(() => {}); }
      : (...args: unknown[]) => call(op, args);
  }
  return proxy as unknown as OverlayCallbacks;
}

/** Run one overlay op against the local callbacks, wrapping the outcome. */
export async function dispatchFormOp(
  ops: OverlayCallbacks,
  op: FormOpName,
  args: unknown[]
): Promise<FormOpResult> {
  try {
    const fn = ops[op] as (...a: unknown[]) => unknown;
    const value = await fn(...args);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run test/crossFrame.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `node node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS.

```bash
git add src/content/crossFrame.ts test/crossFrame.test.ts
git commit -m "feat(extension): pure cross-frame proxy/dispatch helpers"
```

---

## Task 3: Background relay

**Files:**
- Modify: `src/background/serviceWorker.ts` (the `chrome.runtime.onMessage` listener, ~line 123-140)

**Interfaces:**
- Consumes: `FormHostAnnounce`, `RelayFormOp`, `RelayToTop`, `FormOpResult` (Task 1).
- Produces: relay behavior — `FORM_HOST_ANNOUNCE`/`RELAY_TO_TOP` forwarded to frame 0; `RELAY_FORM_OP` forwarded to `msg.frameId`; the host frame's `FormOpResult` returned to the caller.

- [ ] **Step 1: Add relay handling at the TOP of the `onMessage` listener body**

In `src/background/serviceWorker.ts`, the listener currently starts (~line 124):

```typescript
chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest | FieldsUpdatedEvent, _sender, sendResponse) => {
    // Content scripts emit FIELDS_UPDATED for the popup; not addressed to us.
    if (!message || typeof message.type !== "string" || message.type === "FIELDS_UPDATED") {
      return false;
    }
```

Immediately after that guard, insert:

```typescript
    // --- Cross-frame relay (form lives in a child iframe) ---------------------
    const tabId = _sender.tab?.id;
    if (message.type === "FORM_HOST_ANNOUNCE") {
      // A child frame owns a form — tell the top frame which frame, plus fields.
      if (tabId !== undefined && _sender.frameId !== undefined && _sender.frameId !== 0) {
        void chrome.tabs.sendMessage(
          tabId,
          { type: "REMOTE_FORM_AVAILABLE", frameId: _sender.frameId, recognized: message.recognized, fields: message.fields },
          { frameId: 0 }
        ).catch(() => {});
      }
      return false;
    }
    if (message.type === "RELAY_TO_TOP") {
      if (tabId !== undefined) {
        void chrome.tabs.sendMessage(tabId, message.payload, { frameId: 0 }).catch(() => {});
      }
      return false;
    }
    if (message.type === "RELAY_FORM_OP") {
      // Top frame → owning child frame; bridge the response back.
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No tab" });
        return false;
      }
      chrome.tabs.sendMessage(
        tabId,
        { type: "FORM_OP", op: message.op, args: message.args },
        { frameId: message.frameId }
      ).then(sendResponse).catch((err: unknown) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "Frame unreachable" });
      });
      return true; // async response
    }
```

- [ ] **Step 2: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS. (If the existing handler dispatch complains that the new `BackgroundRequest` variants are unhandled, confirm the relay block above returns before that dispatch is reached — it does, because all three are handled and `return`.)

- [ ] **Step 3: Build to confirm the worker bundles**

Run: `node build.mjs`
Expected: `Build complete → dist/` with `serviceWorker.js` listed.

- [ ] **Step 4: Commit**

```bash
git add src/background/serviceWorker.ts
git commit -m "feat(extension): background relay for cross-frame form ops"
```

---

## Task 4: Form-op dispatch + field-update push indirection in the content script

**Files:**
- Modify: `src/content/contentScript.ts` (the `initialize()` closure: the `overlayCallbacks` object, the `onMessage` listener, and the UI-update calls)

**Interfaces:**
- Consumes: `dispatchFormOp` (Task 2); `FormOpRequest` (Task 1); the existing `overlayCallbacks`.
- Produces: a `reportFields()` indirection used everywhere the code currently calls `updateOverlay`/`maybeShowOrUpdateOverlay` for *field changes*; a `FORM_OP` handler in the `onMessage` listener that runs `dispatchFormOp(overlayCallbacks, op, args)`.

- [ ] **Step 1: Add a role flag + `reportFields()` near the top of `initialize()`**

After the `let overlayShown = false;` line, add:

```typescript
  // When this frame is a child that owns the form, it has no overlay of its own —
  // it pushes field changes up to the top frame's panel instead of calling
  // updateOverlay locally. Set once the top frame adopts us as the form host.
  let actingAsRemoteHost = false;

  /** Push the current fields to wherever the panel lives (local or top frame). */
  function reportFields(): void {
    if (actingAsRemoteHost) {
      void chrome.runtime
        .sendMessage({ type: "RELAY_TO_TOP", payload: { type: "REMOTE_FIELDS_UPDATED", fields: lastFields } })
        .catch(() => {});
      return;
    }
    maybeShowOrUpdateOverlay();
  }
```

- [ ] **Step 2: Route the host-frame `onProfileResolved` / `onRescan` through `reportFields()`**

In the `overlayCallbacks` object, change `onRescan` and `onProfileResolved` so their UI push goes through `reportFields()` instead of `updateOverlay`/`maybeUpdateOverlay`:

```typescript
    onRescan: () => {
      runScan();
      reportFields();
    },
    // …
    onProfileResolved: (profile) => {
      lastProfile = profile;
      runScan();
      reportFields();
    },
```

(Leave the local-frame `updateOverlay` behavior intact: when `actingAsRemoteHost` is false, `reportFields()` → `maybeShowOrUpdateOverlay()` which calls `updateOverlay` for an already-mounted panel — same as before.)

- [ ] **Step 3: Add the `FORM_OP` case to the content-script `onMessage` listener**

Inside the `switch (message.type)` in `chrome.runtime.onMessage.addListener` (after the `FILL_FIELDS` case), add:

```typescript
        case "FORM_OP": {
          // This frame owns the form; run the requested overlay op locally.
          void dispatchFormOp(overlayCallbacks, message.op, message.args).then(sendResponse);
          return true; // async
        }
```

Add the import at the top of the file:

```typescript
import { dispatchFormOp } from "./crossFrame";
```

- [ ] **Step 4: Typecheck**

Run: `node node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: PASS (existing 109 + Task 2's 4 = 113).

- [ ] **Step 6: Commit**

```bash
git add src/content/contentScript.ts
git commit -m "feat(extension): form-op dispatch + field-push indirection"
```

---

## Task 5: Autonomous child scanning + form-host announce + top-frame adoption

**Files:**
- Modify: `src/content/contentScript.ts` (`autoInit`, `maybeShowOrUpdateOverlay`, and a new `REMOTE_FORM_AVAILABLE` / `REMOTE_FIELDS_UPDATED` handler)

**Interfaces:**
- Consumes: `shouldAdoptRemoteHost`, `makeProxyCallbacks` (Task 2); `RemoteFormAvailable`, `RemoteFieldsUpdated`, `FormOpName`, `FormOpResult` (Task 1).
- Produces: child frames that announce a found form; a top frame that adopts a remote host and mounts the overlay with proxy callbacks.

- [ ] **Step 1: Let child frames scan and announce**

Replace `autoInit` (currently `if (!isTopFrame) return; runScan(); …`) with:

```typescript
  function autoInit(): void {
    runScan();
    ensureObserver();
    if (isTopFrame) {
      maybeShowOrUpdateOverlay();
    } else {
      announceIfFormHost();
    }
  }

  /** A child frame with a real form tells the top frame it owns one. */
  function announceIfFormHost(): void {
    if (isTopFrame) return;
    const recognized = recognizedCount(lastFields);
    if (recognized < MIN_FIELDS_FOR_OVERLAY) return;
    actingAsRemoteHost = true;
    void chrome.runtime
      .sendMessage({ type: "FORM_HOST_ANNOUNCE", recognized, fields: lastFields })
      .catch(() => {});
  }
```

- [ ] **Step 2: Make the child observer/late-mount push announces too**

In `ensureObserver`'s callback and `watchForLateMount`, after `runScan()` add a branch so child hosts re-announce/refresh. The simplest: in both places replace the trailing `maybeShowOrUpdateOverlay();` with `reportFields(); if (!isTopFrame) announceIfFormHost();`. (`reportFields()` already pushes `REMOTE_FIELDS_UPDATED` when `actingAsRemoteHost`; the re-announce covers the first-detection case where the top hasn't adopted yet.)

- [ ] **Step 3: Add the top-frame adoption handler to `onMessage`**

Add these cases to the `switch (message.type)`:

```typescript
        case "REMOTE_FORM_AVAILABLE": {
          // A child frame owns a form. Adopt it only if WE have none of our own.
          if (isTopFrame && shouldAdoptRemoteHost(recognizedCount(lastFields), message.recognized)) {
            const frameId = message.frameId;
            const send = (op: FormOpName, args: unknown[]): Promise<FormOpResult> =>
              chrome.runtime.sendMessage({ type: "RELAY_FORM_OP", frameId, op, args }) as Promise<FormOpResult>;
            const proxy = makeProxyCallbacks(send);
            lastFields = message.fields; // show the child's fields in our panel
            overlayShown = true;
            showOverlay({ fields: lastFields, tabUrl: location.href }, proxy);
          }
          sendResponse({ ok: true });
          return false;
        }

        case "REMOTE_FIELDS_UPDATED": {
          // The child host re-scanned (profile/rescan/mutation) — refresh the panel.
          if (isTopFrame && overlayShown) {
            lastFields = message.fields;
            updateOverlay({ fields: lastFields, tabUrl: location.href });
          }
          sendResponse({ ok: true });
          return false;
        }
```

Add `shouldAdoptRemoteHost`, `makeProxyCallbacks` to the `crossFrame` import, and `FormOpName`, `FormOpResult` to the `shared/types` import.

- [ ] **Step 4: Typecheck + full suite**

Run: `node node_modules/typescript/lib/tsc.js --noEmit` then `node node_modules/vitest/vitest.mjs run`
Expected: both PASS (113 tests).

- [ ] **Step 5: Build**

Run: `node build.mjs`
Expected: `Build complete → dist/`.

- [ ] **Step 6: Commit**

```bash
git add src/content/contentScript.ts
git commit -m "feat(extension): child-frame form host announce + top-frame adoption"
```

---

## Task 6: Manual verification on the real embedded form

**Files:** none (verification only). Automated tests can't exercise real cross-origin frames + `chrome.tabs`; this task is the integration gate.

- [ ] **Step 1: Load the unpacked extension** from `chrome-extension/dist` (chrome://extensions → Reload).

- [ ] **Step 2: Open the Databricks job page** used in diagnosis (a `...?gh_jid=...` URL). Open DevTools console.

- [ ] **Step 3: Confirm both frames scan.** Expected console lines: a `frame=TOP` scan AND a `frame=child` scan (the Greenhouse iframe now scans autonomously). Previously only `frame=TOP` appeared.

- [ ] **Step 4: Confirm the panel mounts and shows the iframe's fields.** Expected: the overlay appears (top frame) listing first name / email / etc. from the Greenhouse form, with a non-zero Autofill count — not "No form fields detected."

- [ ] **Step 5: Click Autofill.** Expected: the Greenhouse form fields populate; the panel reports "N of M filled." Confirm focus is not stolen while you then edit a field (Bug 2 fix still holds across frames).

- [ ] **Step 6: Regression — a normal single-frame form** (e.g. a Greenhouse-hosted `job-boards.greenhouse.io/...` page opened directly, or a Lever page). Expected: identical behavior to before (local path, panel mounts in the top frame, autofill works). No double panels.

- [ ] **Step 7: Document the outcome** in the PR description (which sites pass, any quirks). If a step fails, return to `superpowers:systematic-debugging` with the console evidence before changing code.

---

## Self-Review Notes

- **Spec coverage:** root cause (cross-origin iframe, top-frame-only overlay) → Tasks 3-5 surface child-frame fields to the top panel and route ops back. Proxy covers all 14 callbacks (Task 2) so autofill, AI drafts, resume upload, cover letter all work cross-frame. Local path untouched (Task 5 adopts a remote host only when `shouldAdoptRemoteHost` is true, i.e. the top frame has no form).
- **PII:** profile/answers travel content→background→frame over `chrome.tabs.sendMessage` (isolated world), never `window.postMessage`. ✔
- **Type consistency:** `FormOpName`/`FormOpResult` used identically in Tasks 1, 2, 4, 5; `makeProxyCallbacks(send)` signature matches the `send` built in Task 5; `dispatchFormOp(overlayCallbacks, …)` matches Task 4's call site.
- **Known follow-ups (out of scope):** multiple form-bearing child frames (we adopt one host); a child host whose iframe later unmounts (panel would show stale fields until next top-frame scan); AI-driven combobox fill (already deferred in the combobox work).
```
