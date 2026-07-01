/**
 * Isolated-world client for the MAIN-world page bridge (pageBridge.ts).
 *
 * Injects the bridge once per frame, then lets the write engine "reinforce" a
 * value it just wrote by asking the page realm to re-apply it the React-correct
 * way (native setter + `_valueTracker` rewind). Everything here is best-effort
 * and MUST be a safe no-op outside a real extension page (unit tests, or a page
 * whose CSP blocks the injected script) — the isolated-world write already stands.
 */
import { FIELD_ID_ATTR } from "../shared/constants";

let injected = false;
let bridgeReady = false;
let injectionUnavailable = false;
/** Reinforcement messages queued before the bridge finished loading. */
const pending: Array<Record<string, unknown>> = [];

/** Are we in a live extension content-script context (vs. jsdom unit tests)? */
function hasExtensionRuntime(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.runtime &&
    typeof chrome.runtime.getURL === "function" &&
    typeof document !== "undefined"
  );
}

/** Inject the page-realm bridge script once. Silent on failure (e.g. page CSP). */
function ensureBridge(): boolean {
  if (injected) return true;
  if (injectionUnavailable || !hasExtensionRuntime()) return false;
  try {
    const src = chrome.runtime.getURL("pageBridge.js");
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.apPageBridge = "1";
    (document.head || document.documentElement).appendChild(s);
    // Flush anything queued before the bridge's message listener existed; clean
    // up the node on load OR error (a CSP-blocked load still leaves a dead node).
    s.addEventListener("load", () => {
      bridgeReady = true;
      for (const msg of pending.splice(0)) {
        try {
          window.postMessage(msg, "*");
        } catch {
          /* ignore */
        }
      }
      s.remove();
    });
    s.addEventListener("error", () => s.remove());
    injected = true;
    return true;
  } catch {
    injectionUnavailable = true;
    return false;
  }
}

/**
 * Ask the page realm to re-apply `value` to `el` (identified by its stable field
 * id). Fire-and-forget: the caller has already written the value in the isolated
 * world; this only makes it stick on frameworks that would otherwise revert it.
 */
export function reinforceValue(el: HTMLElement, value: string): void {
  if (!hasExtensionRuntime()) return; // unit tests / non-extension context
  const isText = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (!isText || !el.isConnected) return;
  const fieldId = el.getAttribute(FIELD_ID_ATTR);
  if (!fieldId) return; // only reinforce controls the scanner has tagged
  if (!ensureBridge()) return;
  const msg = { __apPageBridge: true, action: "setValue", fieldId, value };
  // Queue until the bridge script has loaded (its message listener must exist),
  // so first-pass reinforcement isn't dropped in the async-load gap.
  if (!bridgeReady) {
    pending.push(msg);
    return;
  }
  try {
    window.postMessage(msg, "*");
  } catch {
    /* postMessage can throw on exotic values — ignore, the sync write stands */
  }
}
