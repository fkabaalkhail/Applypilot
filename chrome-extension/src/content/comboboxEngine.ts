/**
 * ARIA combobox / listbox filler.
 *
 * Custom dropdowns (react-select, Headless UI, Radix, Workday button-listboxes…)
 * cannot be driven by setting `.value`: the chosen value lives in the widget's
 * own state and only commits when the user opens the popup and clicks an option.
 * This module mimics that interaction — open → find the listbox → click the
 * matching option → confirm — following the WAI-ARIA combobox/listbox pattern.
 *
 * It is async and ONE-SHOT on purpose: re-driving a dropdown on every page
 * mutation is exactly the focus-stealing churn the reconciler avoids, so these
 * controls are filled once during the autofill pass and never drift-tracked.
 */
import { cleanText, deepQueryAll, dispatchInputEvents, setNativeValue } from "./domUtils";
import { normalize } from "./fieldMatcher";
import { matchOption } from "./writeEngine";

export interface ComboboxResult {
  filled: boolean;
  reason?: string;
}

export interface FillComboboxOptions {
  /** Injectable for tests — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the menu to mount after opening. */
  openWaitMs?: number;
  /** How long to wait for the selection to commit after clicking. */
  commitWaitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
}

const DEFAULTS = { openWaitMs: 1000, commitWaitMs: 1000, pollMs: 50 };

/**
 * True when an element is an ARIA combobox/listbox we can drive by clicking an
 * option — as opposed to a free-text field. We require an explicit listbox
 * affordance so plain inputs are never mistaken for dropdowns.
 */
export function isAriaCombobox(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") || "").toLowerCase();
  const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  if (haspopup === "listbox") return true;
  if (role === "combobox") {
    // A combobox that actually toggles a listbox declares its state/target.
    return (
      el.hasAttribute("aria-expanded") ||
      el.hasAttribute("aria-controls") ||
      el.hasAttribute("aria-owns")
    );
  }
  return false;
}

export async function fillAriaCombobox(
  trigger: HTMLElement,
  value: string,
  opts: FillComboboxOptions = {}
): Promise<ComboboxResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const openWaitMs = opts.openWaitMs ?? DEFAULTS.openWaitMs;
  const commitWaitMs = opts.commitWaitMs ?? DEFAULTS.commitWaitMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;

  if (!trigger.isConnected) {
    return { filled: false, reason: "Field was removed — rescan the page" };
  }
  // Already showing the desired value — idempotent no-op, never opens the menu.
  if (comboboxShowsValue(trigger, value)) return { filled: true };

  open(trigger);

  // Wait for the listbox to mount. Typeahead inputs may need the value typed in
  // to surface (and filter) the options.
  let listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
  if (isTypeahead(trigger) && (!listbox || !findOption(listbox, value))) {
    typeInto(trigger as HTMLInputElement, value);
    listbox = await waitFor(() => getListbox(trigger), sleep, openWaitMs, pollMs);
  }
  if (!listbox) {
    close(trigger);
    return { filled: false, reason: `Couldn't open the "${truncate(value)}" dropdown — select it manually` };
  }

  const option = findOption(listbox, value);
  if (!option) {
    close(trigger);
    return { filled: false, reason: `No option matches "${truncate(value)}" — select it manually` };
  }

  clickOption(option);

  // Confirm: either the committed value now shows, or the popup closed after we
  // clicked a matching option (the standard "selected and dismissed" outcome).
  const committed = await waitFor(
    () => (comboboxShowsValue(trigger, value) || isCollapsed(trigger) ? true : null),
    sleep,
    commitWaitMs,
    pollMs
  );
  if (!committed) {
    return { filled: false, reason: "Selection didn't stick — select it manually" };
  }
  return { filled: true };
}

// ---------------------------------------------------------------------------
// Interaction primitives
// ---------------------------------------------------------------------------

/** A realistic activation sequence: pointer + mouse + click. Pointer events are
 *  a best-effort nicety (jsdom's PointerEvent is stricter than the DOM spec);
 *  the mouse events are what actually drive jsdom and real widgets. */
function activate(el: HTMLElement): void {
  const base: MouseEventInit = { bubbles: true, cancelable: true };
  firePointer(el, "pointerdown");
  el.dispatchEvent(new MouseEvent("mousedown", base));
  firePointer(el, "pointerup");
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

function firePointer(el: HTMLElement, type: string): void {
  const PE = (el.ownerDocument.defaultView as unknown as { PointerEvent?: typeof PointerEvent })?.PointerEvent;
  if (!PE) return;
  try {
    el.dispatchEvent(new PE(type, { bubbles: true, cancelable: true }));
  } catch {
    // jsdom rejects some PointerEvent inits — ignore; mouse events cover it.
  }
}

function open(trigger: HTMLElement): void {
  trigger.focus({ preventScroll: true });
  if (trigger.getAttribute("aria-expanded") === "true") return;
  activate(trigger);
}

function close(trigger: HTMLElement): void {
  trigger.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })
  );
  // Many widgets dismiss the popup on a pointer-down outside it rather than on
  // Escape — fire one on <body> too. (Never re-activate the trigger: that would
  // re-open a widget that opens, rather than toggles, on click.)
  const body = trigger.ownerDocument.body;
  if (body && trigger.getAttribute("aria-expanded") === "true") {
    body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  }
}

function clickOption(option: HTMLElement): void {
  option.scrollIntoView?.({ block: "nearest" });
  activate(option);
}

function isTypeahead(trigger: HTMLElement): boolean {
  if (!(trigger instanceof HTMLInputElement)) return false;
  const ac = (trigger.getAttribute("aria-autocomplete") || "").toLowerCase();
  return ac === "list" || ac === "both" || ac === "inline" || trigger.type === "text";
}

function typeInto(input: HTMLInputElement, value: string): void {
  setNativeValue(input, value);
  dispatchInputEvents(input, value);
}

// ---------------------------------------------------------------------------
// Listbox + option lookup
// ---------------------------------------------------------------------------

/** Locate the open listbox: prefer the one the combobox points at (it may be
 *  portaled far away in the DOM), else any visible listbox in the document. */
function getListbox(trigger: HTMLElement): HTMLElement | null {
  const doc = trigger.ownerDocument;
  const ids = `${trigger.getAttribute("aria-controls") ?? ""} ${trigger.getAttribute("aria-owns") ?? ""}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const lb = (el.getAttribute("role") === "listbox" ? el : el.querySelector('[role="listbox"]')) as HTMLElement | null;
    if (lb && isVisible(lb) && hasOptions(lb)) return lb;
  }
  // Fallback: a visible listbox with options anywhere (portals, shadow roots).
  for (const lb of deepQueryAll(doc, '[role="listbox"]')) {
    if (isVisible(lb) && hasOptions(lb)) return lb;
  }
  return null;
}

function hasOptions(listbox: HTMLElement): boolean {
  return deepQueryAll(listbox, '[role="option"]').length > 0;
}

function findOption(listbox: HTMLElement, value: string): HTMLElement | null {
  const options = deepQueryAll(listbox, '[role="option"]').filter(
    (o) => o.getAttribute("aria-disabled") !== "true"
  );
  return matchOption(
    options,
    (o) => optionText(o),
    (o) => o.getAttribute("data-value") ?? o.getAttribute("value") ?? "",
    value
  );
}

/** Visible label of an option, ignoring nested check/icon glyph text. */
function optionText(option: HTMLElement): string {
  const labelled = option.getAttribute("aria-label");
  return cleanText(labelled) || cleanText(option.textContent);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function isCollapsed(trigger: HTMLElement): boolean {
  return trigger.getAttribute("aria-expanded") === "false";
}

/** Whether the combobox's committed/displayed value reflects the target. */
function comboboxShowsValue(trigger: HTMLElement, value: string): boolean {
  const candidates: string[] = [];
  if (trigger instanceof HTMLInputElement && trigger.value) candidates.push(trigger.value);
  if (trigger.tagName === "BUTTON") candidates.push(cleanText(trigger.textContent));

  const active = trigger.getAttribute("aria-activedescendant");
  if (active) {
    const opt = trigger.ownerDocument.getElementById(active);
    if (opt) candidates.push(optionText(opt));
  }

  const container =
    trigger.closest('[class*="select" i], [class*="combobox" i], [role="combobox"]') ??
    trigger.parentElement ??
    trigger;
  container
    .querySelectorAll('[class*="single-value" i], [class*="singlevalue" i], [class*="multi-value" i], [class*="multivalue" i]')
    .forEach((e) => candidates.push(cleanText(e.textContent)));

  return candidates.some((c) => textMatches(c, value));
}

function textMatches(displayed: string, target: string): boolean {
  const a = normalize(displayed);
  const b = normalize(target);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return true;
}

async function waitFor<T>(
  probe: () => T | null,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
  pollMs: number
): Promise<T | null> {
  let elapsed = 0;
  for (;;) {
    const hit = probe();
    if (hit) return hit;
    if (elapsed >= budgetMs) return null;
    await sleep(pollMs);
    elapsed += pollMs;
  }
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
