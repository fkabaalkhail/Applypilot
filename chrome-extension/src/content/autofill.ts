/**
 * Autofill engine — writes values into detected controls.
 *
 * Guarantees:
 *  - Never clicks submit buttons or navigates. Filling only.
 *  - Never touches file inputs (browsers forbid scripted file selection,
 *    and we don't try to work around that).
 *  - Every write is dispatched as real input events so React/Vue/Angular
 *    forms register the change, then read back and verified.
 */
import type { FillInstruction, FillOutcome } from "../shared/types";
import {
  cleanText,
  dispatchInputEvents,
  flashHighlight,
  setNativeValue,
} from "./domUtils";
import { normalize } from "./fieldMatcher";
import type { RuntimeControl } from "./formScanner";

export function fillFields(
  instructions: FillInstruction[],
  registry: Map<string, RuntimeControl>
): FillOutcome[] {
  return instructions.map(({ fieldId, value }) => {
    const control = registry.get(fieldId);
    if (!control) {
      return { fieldId, ok: false, reason: "Field no longer found — rescan the page" };
    }
    try {
      return { fieldId, ...fillControl(control, value) };
    } catch (err) {
      return { fieldId, ok: false, reason: err instanceof Error ? err.message : "Fill failed" };
    }
  });
}

function fillControl(control: RuntimeControl, value: string): { ok: boolean; reason?: string } {
  switch (control.controlType) {
    case "text":
    case "textarea":
      return fillTextLike(control.el as HTMLInputElement | HTMLTextAreaElement, value);
    case "select":
      return fillSelect(control.el as HTMLSelectElement, value);
    case "checkbox":
      return fillCheckbox(control.el as HTMLInputElement, value);
    case "radioGroup":
      return fillRadioGroup(control.radios ?? [], value);
    case "contenteditable":
      return fillContentEditable(control.el as HTMLElement, value);
    case "file":
      return { ok: false, reason: "Browser security requires selecting files manually" };
    case "customDropdown":
      return { ok: false, reason: "Custom dropdown — select manually" };
  }
}

function stale(el: HTMLElement | undefined): boolean {
  return !el || !el.isConnected;
}

// ---------------------------------------------------------------------------

function fillTextLike(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): { ok: boolean; reason?: string } {
  if (stale(el)) return { ok: false, reason: "Field was removed — rescan the page" };

  el.focus();
  setNativeValue(el, value);
  dispatchInputEvents(el, value);
  el.blur(); // many ATS validate on blur

  // Read back: if a framework rejected/reset the value, report honestly.
  if (el.value !== value) {
    return { ok: false, reason: "Value did not stick — fill manually" };
  }
  flashHighlight(el);
  return { ok: true };
}

// ---------------------------------------------------------------------------

/**
 * Option matching, strictest first:
 *  1. exact value / exact visible text
 *  2. one contains the other ("No" → "No, I do not require sponsorship")
 *  3. token overlap ("Ottawa, ON, Canada" → option "Canada")
 */
function matchOption<T>(
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

  // Token overlap — best-scoring option wins, ties go to the earliest.
  const targetTokens = new Set(t.split(" ").filter((w) => w.length > 2));
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const tokens = normalize(getText(item)).split(" ").filter((w) => w.length > 2);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((w) => targetTokens.has(w)).length;
    const score = overlap / tokens.length;
    if (overlap > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best ? best.item : null;
}

function fillSelect(el: HTMLSelectElement, value: string): { ok: boolean; reason?: string } {
  if (stale(el)) return { ok: false, reason: "Field was removed — rescan the page" };

  const options = Array.from(el.options).filter((o) => !o.disabled);
  const match = matchOption(
    options,
    (o) => cleanText(o.textContent),
    (o) => o.value,
    value
  );
  if (!match) return { ok: false, reason: `No option matches "${truncate(value)}"` };

  setNativeValue(el, match.value);
  dispatchInputEvents(el);
  flashHighlight(el);
  return { ok: true };
}

// ---------------------------------------------------------------------------

function parseDesiredBool(value: string): boolean | null {
  if (/^(yes|y|true|1|agree|checked)$/i.test(value.trim())) return true;
  if (/^(no|n|false|0|unchecked)$/i.test(value.trim())) return false;
  return null;
}

function fillCheckbox(el: HTMLInputElement, value: string): { ok: boolean; reason?: string } {
  if (stale(el)) return { ok: false, reason: "Field was removed — rescan the page" };
  const desired = parseDesiredBool(value);
  if (desired === null) {
    return { ok: false, reason: "Ambiguous checkbox value — set manually" };
  }
  if (el.checked !== desired) {
    // click() drives the framework's own handlers — safer than setting .checked.
    el.click();
  }
  if (el.checked !== desired) return { ok: false, reason: "Checkbox did not change" };
  flashHighlight(el);
  return { ok: true };
}

function fillRadioGroup(
  radios: HTMLInputElement[],
  value: string
): { ok: boolean; reason?: string } {
  const live = radios.filter((r) => r.isConnected);
  if (live.length === 0) return { ok: false, reason: "Field was removed — rescan the page" };

  const labelOf = (r: HTMLInputElement): string =>
    cleanText(r.labels?.[0]?.textContent) || r.value;

  const match = matchOption(live, labelOf, (r) => r.value, value);
  if (!match) return { ok: false, reason: `No option matches "${truncate(value)}"` };

  if (!match.checked) match.click();
  if (!match.checked) return { ok: false, reason: "Option did not select" };
  flashHighlight(match.labels?.[0] ?? match);
  return { ok: true };
}

// ---------------------------------------------------------------------------

function fillContentEditable(el: HTMLElement, value: string): { ok: boolean; reason?: string } {
  if (stale(el)) return { ok: false, reason: "Field was removed — rescan the page" };

  el.focus();
  // execCommand is deprecated but remains the most compatible way to make
  // rich-text editors register inserted text; fall back to textContent.
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

  if (cleanText(el.textContent) === "") {
    return { ok: false, reason: "Editor rejected the text — fill manually" };
  }
  flashHighlight(el);
  return { ok: true };
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
