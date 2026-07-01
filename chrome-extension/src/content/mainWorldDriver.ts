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

// Workday routine is added in Task 8; provide a stub now so the bundle
// compiles and the bridge is exercised by tests.
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
