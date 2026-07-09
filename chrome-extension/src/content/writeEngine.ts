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
import { cleanText, dispatchCommitKeys, dispatchInputEvents, setNativeValue } from "./domUtils";
import { normalize } from "./fieldMatcher";
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
    case "password":
      return writeTextLike(control.el as HTMLInputElement, value);
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
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse a flexible date ("2020-01", "Jan 2020", "01/2020", "1/15/2020", "2020")
 *  into ISO parts, or null. */
function parseFlexibleDate(v: string): { y: string; m: string; d: string } | null {
  const s = v.trim();
  const pad = (n: string): string => n.padStart(2, "0");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/))) return { y: m[1], m: pad(m[2]), d: pad(m[3] ?? "1") };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return { y: m[3], m: pad(m[1]), d: pad(m[2]) };
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return { y: m[2], m: pad(m[1]), d: "01" };
  if ((m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{4})/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return { y: m[2], m: pad(String(mi + 1)), d: "01" };
  }
  if ((m = s.match(/^(\d{4})$/))) return { y: m[1], m: "01", d: "01" };
  return null;
}

/** Native date/month inputs only accept ISO (YYYY-MM-DD / YYYY-MM). Reshape a
 *  flexible profile date to fit; anything else passes through unchanged. */
export function formatForDateInput(el: HTMLElement, value: string): string {
  if (!(el instanceof HTMLInputElement) || (el.type !== "date" && el.type !== "month")) return value;
  const p = parseFlexibleDate(value);
  if (!p) return value;
  return el.type === "month" ? `${p.y}-${p.m}` : `${p.y}-${p.m}-${p.d}`;
}

function writeTextLike(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): WriteResult {
  if (isStale(el)) return { written: false, reason: STALE };
  const v = formatForDateInput(el, value);
  el.focus({ preventScroll: true });
  setNativeValue(el, v);
  dispatchInputEvents(el, v);
  // Enter commits typeaheads / applies input masks / wakes keyup validators.
  // Only for single-line inputs: Enter is a newline in a textarea, and a
  // password field gains nothing (and stays safest untouched by key events).
  if (el instanceof HTMLInputElement && el.type !== "password") dispatchCommitKeys(el);
  el.blur(); // many ATS validate on blur
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
    case "password": {
      const el = control.el as HTMLInputElement | undefined;
      if (isStale(el)) return false;
      return el!.value === value; // exact — never fuzzy-match a password
    }
    case "text":
    case "textarea": {
      const el = control.el as HTMLInputElement | HTMLTextAreaElement | undefined;
      if (isStale(el)) return false;
      return valueReflects(formatForDateInput(el!, value), el!.value);
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
 * Option matching, strictest first:
 *  1. exact value / exact visible text
 *  2. one contains the other ("No" → "No, I do not require sponsorship")
 *  3. numeric-range containment ("about 3 years" → option "2-3 years")
 *  4. token overlap ("Ottawa, ON, Canada" → option "Canada")
 */
export function matchOption<T>(
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
    const tWords = t.split(" ");
    const textWords = text.split(" ");

    // For single-word targets, require word-boundary match (not substring of another word).
    // "No" matches "No, I do not require sponsorship" because "no" is a complete word.
    // "cat" does NOT match "category" because "cat" is just a prefix, not a word.
    if (tWords.length === 1) {
      if (textWords[0] === t) return item; // target is first word of option
      if (textWords.includes(t)) return item; // target is a word in option
    } else {
      // Multi-word targets: allow substring matching
      if (text.startsWith(t) || t.startsWith(text)) return item;
      if (text.includes(t) || t.includes(text)) return item;
    }
  }

  // Bucketed numeric options ("2-3 years", "$90,000-$110,000", "6+ years") all
  // reduce to the same handful of tokens ("years" / "000") once normalized, so
  // generic token overlap can't tell them apart — it would always pick the
  // first bucket. The AI is told to answer with exact option text but often
  // answers conversationally with just the number ("about 3 years"); check
  // whether the target's number actually falls inside an option's range
  // before falling back to plain token overlap.
  const targetNum = firstNumber(target);
  if (targetNum !== null) {
    for (const item of items) {
      const range = parseRange(getText(item));
      if (range && targetNum >= range[0] && targetNum <= range[1]) return item;
    }
  }

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

/** The first number (comma thousands-separators tolerated) mentioned in text, or null. */
function firstNumber(text: string): number | null {
  const m = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Parse a bucketed-range option label ("2-3 years", "$90,000-$110,000",
 * "6+ years", "Under 1 year") into an inclusive [min, max] (Infinity for an
 * open end) — or null when the text isn't a recognizable numeric range.
 */
function parseRange(text: string): [number, number] | null {
  // Strip thousands separators and currency symbols so "$50,000-$70,000"
  // reads as "50000-70000" — a "$" between the dash and the second number
  // would otherwise break the separator match below.
  const cleaned = text.replace(/,/g, "").replace(/[$€£¥]/g, "");
  const between = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/i);
  if (between) return [parseFloat(between[1]), parseFloat(between[2])];
  const plus = cleaned.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return [parseFloat(plus[1]), Infinity];
  const under = cleaned.match(/(?:under|less than|<)\s*(\d+(?:\.\d+)?)/i);
  if (under) return [-Infinity, parseFloat(under[1])];
  return null;
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
