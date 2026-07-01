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

/**
 * `CSS.escape` per spec, with a same-behavior fallback for environments
 * where the `CSS` global is unavailable (this project's jsdom test
 * environment does not implement it; every Chrome version this extension
 * targets, 110+, has full native support). Field ids are always plain
 * tokens assigned by formScanner.ts, so the fallback only needs to keep the
 * attribute selector well-formed, not be spec-perfect.
 */
const escapeAttrValue = (s: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(s)
    : s.replace(/["\\]/g, "\\$&");

async function fillField(doc: Document, detail: MwFillDetail): Promise<MwResultDetail> {
  // The whole body is wrapped so this NEVER rejects — installDriver's bridge
  // reply must always fire, or the isolated-world caller hangs forever.
  try {
    const el = doc.querySelector<HTMLElement>(`[${FIELD_ID_ATTR}="${escapeAttrValue(detail.fieldId)}"]`);
    if (!el) return { id: detail.id, ok: false, reason: "field-not-found" };
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
