/**
 * Layer B: Write Correctness.
 *
 * Splits a fill into two primitives the reconciler drives independently:
 *   - writeControl(): one attempt to push a value into a live control, using
 *     the native value setter and the exact event order focus → input →
 *     change → blur so React/Vue/Angular register it as real user input.
 *   - verifyControl(): does the live DOM now reflect the intended value?
 *
 * Neither schedules timers or retries, that is Layer C's job. Keeping write
 * and verify separate is what lets the reconciler retry, detect drift and stay
 * idempotent (verify-before-write means an already-correct field is untouched).
 */
import {
  cleanText,
  dispatchCommitKeys,
  dispatchInputEvents,
  isPlaceholderFiller,
  setNativeValue,
} from "./domUtils";
import { normalize } from "./fieldMatcher";
import type { RuntimeControl } from "./formScanner";
import { isBooleanOptionSet, optionPolarity } from "./answerKind";

export interface WriteResult {
  /** True when an attempt was actually made (control is writable and live). */
  written: boolean;
  /** Why no attempt was made, unfillable control type, stale node, no match. */
  reason?: string;
}

const UNFILLABLE = "Control cannot be scripted. Handle manually";
const STALE = "Field was removed. Rescan the page";

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
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

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
  // click() drives the framework's own handlers, safer than setting .checked.
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
// Verify: does the live DOM reflect the intended value?
// ---------------------------------------------------------------------------

export function verifyControl(control: RuntimeControl, value: string): boolean {
  switch (control.controlType) {
    case "password": {
      const el = control.el as HTMLInputElement | undefined;
      if (isStale(el)) return false;
      return el!.value === value; // exact, never fuzzy-match a password
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
 * framework legitimately reshaped, but still catches genuine mismatches.
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
 * Option matching. A choice control only ever gets one of its REAL options,
 * and only when the match is confident; when it is not, the answer is "no
 * match" and the field stays blank. Tiers, strictest first:
 *
 *  1. exact value / exact visible text
 *  2. yes/no POLARITY: an answer that reads as Yes or No ("No", "I am not a
 *     protected veteran", "Not authorized") can only select an option of the
 *     same polarity, and only when exactly one exists. It never falls through
 *     to the fuzzy tiers: a "Yes" must not select "Maybe So", and a negated
 *     answer must not select the affirmative option that shares its words.
 *     Conversely a value with NO polarity ("Quebec") never selects an option
 *     of a yes/no set, whatever words they share.
 *  3. word containment ("No" → "No, I do not require sponsorship"), on whole
 *     words, never characters ("no" is not inside "not"); the most specific
 *     option wins and a tie is refused
 *  4. numeric range ("1.42" → "1-3 years"); a number on the boundary of two
 *     buckets is refused rather than placed in the first
 *  5. token overlap ("Ottawa, ON, Canada" → "Canada"); a tie is refused
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

  // Tier 2: polarity. Decided here and never revisited by a fuzzier tier.
  const texts = items.map((item) => getText(item));
  const polarities = texts.map((text) => optionPolarity(text));
  const targetPolarity = optionPolarity(target);
  if (targetPolarity !== null) {
    const same = items.filter((_, i) => polarities[i] === targetPolarity);
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      // Several options share the polarity ("No", "No, but in the future"):
      // only a bare "Yes"/"No" option is the unambiguous one.
      const bare = same.filter((item) => /^(yes|no|true|false|y|n)$/.test(normalize(getText(item))));
      return bare.length === 1 ? bare[0] : null;
    }
    // No option carries this polarity. Only an option set with no yes/no
    // meaning at all may still be searched (a "No" answer to "Clearance
    // type: None | Secret | Top Secret" reads "None" as its polarity anyway).
    if (polarities.some((p) => p !== null)) return null;
  } else if (isBooleanOptionSet(texts)) {
    // A value that is not a yes/no answer cannot answer a yes/no choice.
    return null;
  }

  // Bucketed numeric options ("0-1 year", "1-3 years") are matched by range
  // only: as words, "1" is inside both "0-1 year" and "1-3 years".
  const ranged = items.filter((item) => parseRange(getText(item)) !== null);

  // Tier 3: whole-word containment, most specific option first.
  const tWords = t.split(" ");
  const contained: Array<{ item: T; size: number; first: boolean }> = [];
  for (const item of ranged.length >= 2 ? [] : items) {
    const text = normalize(getText(item));
    if (!text) continue;
    const words = text.split(" ");
    if (tWords.length === 1) {
      if (words.includes(t)) contained.push({ item, size: -words.length, first: words[0] === t });
    } else if (containsWords(words, tWords) || containsWords(tWords, words)) {
      // Bigger is better when the option is INSIDE the answer ("Software
      // Engineer" in "Software Engineer Intern"); tighter is better when the
      // answer is inside the option.
      contained.push({ item, size: containsWords(tWords, words) ? words.length : -words.length, first: false });
    }
  }
  if (contained.length > 0) {
    // A bare number (a year, a count) inside several options is not narrowed
    // by how many OTHER words each adds: "2027" fits "January - June 2027"
    // and "December 2027" equally, and the shorter one was picked (Ashby,
    // live 2026-10-03). Refuse.
    if (/^\d+$/.test(t) && contained.length > 1) return null;
    const firstWord = contained.filter((c) => c.first);
    const pool = firstWord.length > 0 ? firstWord : contained;
    const bestSize = Math.max(...pool.map((c) => c.size));
    const best = pool.filter((c) => c.size === bestSize);
    if (best.length === 1) return best[0].item;
    return null; // equally good candidates: ambiguous, refuse
  }

  // Tier 4: bucketed numeric options ("2-3 years", "$90,000-$110,000", "6+
  // years") all reduce to the same handful of tokens ("years" / "000") once
  // normalized, so generic token overlap can't tell them apart. Place the
  // answer's number inside exactly one bucket, or refuse.
  const targetNum = firstNumber(target);
  if (targetNum !== null && ranged.length > 0) {
    const hits = ranged.filter((item) => {
      const range = parseRange(getText(item))!;
      return targetNum >= range[0] && targetNum <= range[1];
    });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // on a shared boundary: ambiguous
  }

  // A bucketed-range option set that the range tier could not place the answer
  // in must FAIL here: the buckets normalize to the same tokens ("years",
  // "000"), so token overlap would just select the first bucket, a confidently
  // wrong answer. No match lets the re-ask round supply the real options.
  if (ranged.length >= 2) return null;

  const targetTokens = t.split(" ").filter((w) => w.length > 2);
  const targetSet = new Set(targetTokens);
  let best: { item: T; score: number } | null = null;
  let tied = false;
  for (const item of items) {
    const tokens = normalize(getText(item))
      .split(" ")
      .filter((w) => w.length > 2);
    if (tokens.length === 0) continue;
    // A token overlaps on equality OR as a morphological variant ("canada" ↔
    // "canadian"): AI answers often use one. A variant shares at least 5
    // leading characters AND most of the shorter word; a 5-letter stem alone
    // made "Mechanical Engineering" a perfect match for "Mechatronics
    // Engineering" (Greenhouse discipline list, live 2026-10-03).
    const overlap = tokens.filter(
      (w) => targetSet.has(w) || targetTokens.some((tw) => isVariant(w, tw))
    ).length;
    const score = overlap / tokens.length;
    // Incidental overlap must not select: one shared generic token scores 0.5
    // on a two-token option ("University of Ottawa" → "University of
    // Oklahoma"). Require at least two shared tokens, or a fully-covered
    // single-token option ("Canadian", "Canada").
    if (score < 0.5 || (overlap < 2 && score !== 1)) continue;
    if (!best || score > best.score) {
      best = { item, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  return best && !tied ? best.item : null;
}

/** `needle`'s words appear contiguously, in order, inside `hay`. */
function containsWords(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Length of the common leading substring of two tokens. */
function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Two forms of one word ("canada" / "canadian" / "canadien", "engineer" /
 *  "engineering"): a 5+ letter stem with at most an ending (3 letters) past it
 *  on either side. Not two words sharing a stem ("mechanical" / "mechatronics"). */
function isVariant(a: string, b: string): boolean {
  const shared = sharedPrefixLen(a, b);
  return shared >= 5 && Math.max(a.length, b.length) - shared <= 3;
}

/** The first number (comma thousands-separators tolerated) mentioned in text, or null. */
function firstNumber(text: string): number | null {
  const m = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Parse a bucketed-range option label ("2-3 years", "$90,000-$110,000",
 * "6+ years", "Under 1 year") into an inclusive [min, max] (Infinity for an
 * open end), or null when the text isn't a recognizable numeric range.
 */
function parseRange(text: string): [number, number] | null {
  // Strip thousands separators and currency symbols so "$50,000-$70,000"
  // reads as "50000-70000", a "$" between the dash and the second number
  // would otherwise break the separator match below.
  const cleaned = text.replace(/,/g, "").replace(/[$€£¥]/g, "");
  const between = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/i);
  if (between) return [parseFloat(between[1]), parseFloat(between[2])];
  const plus = cleaned.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return [parseFloat(plus[1]), Infinity];
  // "Over 6 years" / "More than 10" exclude their bound; "6 or more" includes it.
  const over = cleaned.match(/(?:over|more than|greater than|above|>)\s*(\d+(?:\.\d+)?)/i);
  if (over) return [parseFloat(over[1]) + 1e-9, Infinity];
  const orMore = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:years?\s*)?(?:or more|and (?:up|above|over))/i);
  if (orMore) return [parseFloat(orMore[1]), Infinity];
  const under = cleaned.match(/(?:under|less than|fewer than|below|<)\s*(\d+(?:\.\d+)?)/i);
  if (under) return [-Infinity, parseFloat(under[1]) - 1e-9];
  return null;
}

function matchSelectOption(el: HTMLSelectElement, value: string): HTMLOptionElement | null {
  const options = Array.from(el.options).filter((o) => !o.disabled);
  // Split-date pickers render Month / Day / Year as three separate <select>s
  // that often share one visual label ("Date of birth"), so the resolver hands
  // the SAME full date to each. Reduce it to the part this select expects before
  // matching, a no-op for every non-date select (returns the value unchanged).
  const target =
    reduceDateForOptions(value, options.map((o) => cleanText(o.textContent))) ?? value;
  return matchOption(options, (o) => cleanText(o.textContent), (o) => o.value, target);
}

type DatePart = "monthName" | "monthNum" | "day" | "year";

/**
 * When `value` is a full date AND this option set is one part of a split date
 * picker, return just that part (as the form expects it); otherwise null so the
 * caller matches the value unchanged. Gated on BOTH conditions so an ordinary
 * numeric or text select is never reinterpreted as a date.
 */
function reduceDateForOptions(value: string, optionTexts: string[]): string | null {
  const p = parseFlexibleDate(value);
  if (!p) return null; // not a date answer, leave every other select untouched
  switch (classifyDatePartOptions(optionTexts)) {
    case "monthName":
      return MONTHS_FULL[Number(p.m) - 1] ?? null;
    case "monthNum":
      return String(Number(p.m));
    case "day":
      return String(Number(p.d));
    case "year":
      return p.y;
    default:
      return null;
  }
}

/**
 * Classify a select's options as a date part, or null. Requires a strong,
 * near-complete signature (all 12 months, days running to 28–31, a run of
 * 4-digit years) so a short numeric or bucketed-range select never trips it.
 */
function classifyDatePartOptions(texts: string[]): DatePart | null {
  const vals = texts.map((t) => t.trim()).filter((t) => t && !isPlaceholderFiller(t));
  if (vals.length < 4) return null;
  const monthHits = vals.filter((t) => MONTHS.includes(t.slice(0, 3).toLowerCase())).length;
  if (monthHits >= 12) return "monthName";
  // Every remaining candidate must be a bare integer, or this isn't a date part.
  if (!vals.every((t) => /^\d{1,4}$/.test(t))) return null;
  const nums = vals.map(Number);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (vals.every((t) => /^\d{4}$/.test(t)) && min >= 1900 && max <= 2100) return "year";
  if (min === 1 && max >= 28 && max <= 31) return "day";
  if (min === 1 && max === 12 && vals.length >= 12) return "monthNum";
  return null;
}

function matchRadio(radios: HTMLInputElement[], value: string): HTMLInputElement | null {
  const labelOf = (r: HTMLInputElement): string =>
    cleanText(r.labels?.[0]?.textContent) || r.value;
  return matchOption(radios, labelOf, (r) => r.value, value);
}

// Native checkbox groups ("select all that apply"), a multi-select answer may
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

// ARIA radio groups (role=radiogroup with role=radio divs), selected by clicking
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
