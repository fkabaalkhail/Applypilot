/**
 * Layer B — Write Correctness.
 *
 * Splits a fill into two primitives the reconciler drives independently:
 *   - writeControl(): one attempt to push a value into a live control, using
 *     the native value setter and the exact event order focus → input →
 *     change → blur so React/Vue/Angular register it as real user input.
 *   - verifyControl(): does the live DOM now reflect the intended value?
 *
 * Neither schedules timers or retries — that is Layer C's job. Keeping write
 * and verify separate is what lets the reconciler retry, detect drift and stay
 * idempotent (verify-before-write means an already-correct field is untouched).
 */
import { cleanText, dispatchInputEvents, setNativeValue } from "./domUtils";
import { normalize } from "./fieldMatcher";
import { countryAlias } from "./countryAliases";
import { reinforceValue } from "./pageBridgeClient";
import type { RuntimeControl } from "./formScanner";

export interface WriteResult {
  /** True when an attempt was actually made (control is writable and live). */
  written: boolean;
  /** Why no attempt was made — unfillable control type, stale node, no match. */
  reason?: string;
}

const UNFILLABLE = "Control cannot be scripted — handle manually";
const STALE = "Field was removed — rescan the page";

function isStale(el: HTMLElement | undefined): boolean {
  return !el || !el.isConnected;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeControl(control: RuntimeControl, value: string): WriteResult {
  switch (control.controlType) {
    case "text":
    case "textarea":
      return writeTextLike(control.el as HTMLInputElement | HTMLTextAreaElement, value);
    case "select":
      return writeSelect(control.el as HTMLSelectElement, value);
    case "checkbox":
      return writeCheckbox(control.el as HTMLInputElement, value);
    case "radioGroup":
      return writeRadioGroup(control.radios ?? [], value);
    case "checkboxGroup":
      return writeCheckboxGroup(control.checkboxes ?? [], value);
    case "contenteditable":
      return writeContentEditable(control.el as HTMLElement, value);
    case "ariaRadioGroup":
      return writeAriaRadioGroup(control.el as HTMLElement, value);
    case "file":
    case "customDropdown":
    case "combobox": // driven asynchronously by comboboxEngine, never here
      return { written: false, reason: UNFILLABLE };
  }
}

/**
 * Fire the lifecycle a framework expects, in the exact order the spec mandates:
 * focus → input → change → blur. The value is set through the native prototype
 * setter between focus and input so handlers reading `el.value` see the new
 * value. .focus()/.blur() are used so document.activeElement is correct too.
 */
function writeTextLike(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): WriteResult {
  if (isStale(el)) return { written: false, reason: STALE };
  el.focus({ preventScroll: true });
  // Clear-first when overwriting existing content: masked / autocomplete inputs
  // (phone, date, currency) transform or APPEND typed text, so writing a full
  // value onto residual content yields garbage. Empty fields (the usual autofill
  // target) skip this, keeping the common path a single input/change pair.
  if (el.value && el.value !== value) {
    setNativeValue(el, "");
    dispatchInputEvents(el, "");
  }
  setNativeValue(el, value);
  dispatchInputEvents(el, value);
  el.blur(); // many ATS validate on blur
  reinforceValue(el, value); // page-realm reinforcement (no-op if unavailable)
  return { written: true };
}

function writeSelect(el: HTMLSelectElement, value: string): WriteResult {
  if (isStale(el)) return { written: false, reason: STALE };
  const match = matchSelectOption(el, value);
  if (!match) return { written: false, reason: `No option matches "${truncate(value)}"` };
  el.focus({ preventScroll: true });
  setNativeValue(el, match.value);
  dispatchInputEvents(el);
  el.blur();
  return { written: true };
}

function writeCheckbox(el: HTMLInputElement, value: string): WriteResult {
  if (isStale(el)) return { written: false, reason: STALE };
  const desired = parseDesiredBool(value);
  if (desired === null) return { written: false, reason: "Ambiguous checkbox value" };
  // click() drives the framework's own handlers — safer than setting .checked.
  if (el.checked !== desired) el.click();
  return { written: true };
}

function writeRadioGroup(radios: HTMLInputElement[], value: string): WriteResult {
  const live = radios.filter((r) => r.isConnected);
  if (live.length === 0) return { written: false, reason: STALE };
  const match = matchRadio(live, value);
  if (!match) return { written: false, reason: `No option matches "${truncate(value)}"` };
  if (!match.checked) match.click();
  return { written: true };
}

function writeContentEditable(el: HTMLElement, value: string): WriteResult {
  if (isStale(el)) return { written: false, reason: STALE };
  el.focus({ preventScroll: true });
  const doc = el.ownerDocument;
  const selection = doc.getSelection();
  if (selection) {
    selection.selectAllChildren(el);
    const inserted = doc.execCommand("insertText", false, value);
    if (!inserted) {
      el.textContent = value;
      dispatchInputEvents(el, value);
    }
  } else {
    el.textContent = value;
    dispatchInputEvents(el, value);
  }
  el.blur();
  return { written: true };
}

// ---------------------------------------------------------------------------
// Verify — does the live DOM reflect the intended value?
// ---------------------------------------------------------------------------

export function verifyControl(control: RuntimeControl, value: string): boolean {
  switch (control.controlType) {
    case "text":
    case "textarea": {
      const el = control.el as HTMLInputElement | HTMLTextAreaElement | undefined;
      if (isStale(el)) return false;
      return valueReflects(value, el!.value);
    }
    case "select": {
      const el = control.el as HTMLSelectElement | undefined;
      if (isStale(el)) return false;
      const match = matchSelectOption(el!, value);
      return Boolean(match) && el!.value === match!.value;
    }
    case "checkbox": {
      const el = control.el as HTMLInputElement | undefined;
      if (isStale(el)) return false;
      const desired = parseDesiredBool(value);
      return desired !== null && el!.checked === desired;
    }
    case "radioGroup": {
      const live = (control.radios ?? []).filter((r) => r.isConnected);
      if (live.length === 0) return false;
      const match = matchRadio(live, value);
      return Boolean(match) && match!.checked;
    }
    case "checkboxGroup": {
      const live = (control.checkboxes ?? []).filter((c) => c.isConnected);
      if (live.length === 0) return false;
      const matched = answerParts(value)
        .map((p) => matchCheckbox(live, p))
        .filter((c): c is HTMLInputElement => c !== null);
      return matched.length > 0 && matched.every((c) => c.checked);
    }
    case "contenteditable": {
      const el = control.el;
      if (isStale(el)) return false;
      return valueReflects(value, cleanText(el!.textContent));
    }
    case "ariaRadioGroup": {
      const group = control.el;
      if (isStale(group)) return false;
      const match = findAriaRadio(group!, value);
      return Boolean(match) && match!.getAttribute("aria-checked") === "true";
    }
    case "file":
    case "customDropdown":
    case "combobox":
      return false;
  }
}

/**
 * Whether the live string reflects what we wrote. Tolerant of whitespace and
 * framework reformatting (e.g. a phone field that turns "5551234567" into
 * "(555) 123-4567") so the reconciler does not loop reapplying a value the
 * framework legitimately reshaped — but still catches genuine mismatches.
 */
function valueReflects(written: string, current: string): boolean {
  const w = written.trim();
  const c = current.trim();
  if (w === c) return true;
  if (!c) return false;
  const core = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cw = core(w);
  return cw !== "" && cw === core(c);
}

// ---------------------------------------------------------------------------
// Option matching (shared by select + radio, write + verify)
// ---------------------------------------------------------------------------

/**
 * Option matching. Tries the target then its country-alias expansions (so
 * "…, USA" matches an option "United States"), strictest pass first for each.
 */
export function matchOption<T>(
  items: T[],
  getText: (item: T) => string,
  getValue: (item: T) => string,
  target: string
): T | null {
  for (const candidate of targetCandidates(target)) {
    const hit = matchOneTarget(items, getText, getValue, candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Candidate strings to match an option against: the raw target, plus the
 * canonical country label for any comma/slash segment that is an alias (or the
 * whole string). Lets "San Francisco, CA, USA" reach option "United States".
 */
function targetCandidates(target: string): string[] {
  const out = [target];
  const whole = countryAlias(target);
  if (whole) out.push(whole);
  for (const seg of target.split(/[,/|]/).map((s) => s.trim()).filter(Boolean)) {
    const alias = countryAlias(seg);
    if (alias) out.push(alias);
  }
  return [...new Set(out)];
}

/**
 * One target, strictest first:
 *  1. exact value / exact visible text
 *  2. one contains the other ("No" → "No, I do not require sponsorship")
 *  3. token overlap ("Ottawa, ON, Canada" → option "Canada")
 */
function matchOneTarget<T>(
  items: T[],
  getText: (item: T) => string,
  getValue: (item: T) => string,
  target: string
): T | null {
  const t = normalize(target);
  if (!t) return null;

  for (const item of items) if (getValue(item) === target) return item;
  for (const item of items) if (normalize(getText(item)) === t) return item;

  for (const item of items) {
    const text = normalize(getText(item));
    if (!text) continue;
    if (text.startsWith(t) || t.startsWith(text)) return item;
    if (text.includes(t) || t.includes(text)) return item;
  }

  const targetTokens = new Set(t.split(" ").filter((w) => w.length > 2));
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const tokens = normalize(getText(item))
      .split(" ")
      .filter((w) => w.length > 2);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((w) => targetTokens.has(w)).length;
    const score = overlap / tokens.length;
    if (overlap > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best ? best.item : null;
}

function matchSelectOption(el: HTMLSelectElement, value: string): HTMLOptionElement | null {
  const options = Array.from(el.options).filter((o) => !o.disabled);
  return matchOption(options, (o) => cleanText(o.textContent), (o) => o.value, value);
}

function matchRadio(radios: HTMLInputElement[], value: string): HTMLInputElement | null {
  const labelOf = (r: HTMLInputElement): string =>
    cleanText(r.labels?.[0]?.textContent) || r.value;
  return matchOption(radios, labelOf, (r) => r.value, value);
}

// Native checkbox groups ("select all that apply") — a multi-select answer may
// name one or more options; check each matching box (additive, never unchecks).
function answerParts(value: string): string[] {
  const parts = value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [value.trim()].filter(Boolean);
}

function matchCheckbox(boxes: HTMLInputElement[], value: string): HTMLInputElement | null {
  const labelOf = (c: HTMLInputElement): string => cleanText(c.labels?.[0]?.textContent) || c.value;
  return matchOption(boxes, labelOf, (c) => c.value, value);
}

function writeCheckboxGroup(checkboxes: HTMLInputElement[], value: string): WriteResult {
  const live = checkboxes.filter((c) => c.isConnected);
  if (live.length === 0) return { written: false, reason: STALE };
  let any = false;
  for (const part of answerParts(value)) {
    const match = matchCheckbox(live, part);
    if (match) {
      if (!match.checked) match.click();
      any = true;
    }
  }
  if (!any) return { written: false, reason: `No option matches "${truncate(value)}"` };
  return { written: true };
}

// ARIA radio groups (role=radiogroup with role=radio divs) — selected by clicking
// the matching radio; the framework flips its aria-checked.
function ariaRadiosOf(group: HTMLElement): HTMLElement[] {
  return Array.from(group.querySelectorAll('[role="radio"]')).filter(
    (r) => r.getAttribute("aria-disabled") !== "true"
  ) as HTMLElement[];
}

function findAriaRadio(group: HTMLElement, value: string): HTMLElement | null {
  return matchOption(
    ariaRadiosOf(group),
    (r) => cleanText(r.getAttribute("aria-label")) || cleanText(r.textContent),
    (r) => r.getAttribute("data-value") ?? r.getAttribute("value") ?? "",
    value
  );
}

function writeAriaRadioGroup(group: HTMLElement, value: string): WriteResult {
  if (isStale(group)) return { written: false, reason: STALE };
  const match = findAriaRadio(group, value);
  if (!match) return { written: false, reason: `No option matches "${truncate(value)}"` };
  if (match.getAttribute("aria-checked") !== "true") match.click();
  return { written: true };
}

function parseDesiredBool(value: string): boolean | null {
  if (/^(yes|y|true|1|agree|checked)$/i.test(value.trim())) return true;
  if (/^(no|n|false|0|unchecked)$/i.test(value.trim())) return false;
  return null;
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
