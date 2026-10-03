// chrome-extension/src/content/adapters/lever.ts
/**
 * Lever (`*.lever.co`). Lever's standard fields (name/email/phone/country/
 * cover-letter) fill cleanly through the generic pipeline, so this adapter only
 * owns the two places the generic path gets Lever wrong:
 *
 *  1. Current-company / org text field, named `org` / `current-company`,
 *     whose visible label the generic classifier reads fine but whose machine
 *     name is the more reliable signal (kept from the old common-table entry).
 *
 *  2. The "Current location" typeahead (`input[data-qa="location-input"]`).
 *     Typing text into the visible input alone does NOT stick: Lever submits a
 *     hidden sibling `input[name="selectedLocation"]` holding a JSON
 *     `{"name": "<text>"}`, and validates on that. The generic text writer sets
 *     only the visible input, so the value silently reverts ("did not stick").
 *     We mirror Jobright's `handleLocationInput`: set BOTH the visible field and
 *     the hidden `selectedLocation` JSON.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import { setNativeValue } from "./shared";
import type { AdapterFillResult, FieldContext, FillContext, SiteAdapter } from "./types";
import type { Classification } from "../fieldMatcher";
import { countryByCode, countryFromName, regionFromText } from "../geo";

const LEVER_HOST = /(^|\.)lever\.co$/i;
const ORG_RE = /\borg(anization)?\b|current[_\s-]?(company|employer)/i;

function attrBlob(el: HTMLElement): string {
  return [el.getAttribute("name"), el.id].filter(Boolean).join(" ");
}

/** Set an input through the native setter and fire input/change so Lever's
 *  React state registers it. */
function setInput(el: HTMLInputElement, value: string): void {
  setNativeValue(el, value);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const norm = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Type like a user: key events around a native-setter write + input event,
 *  which is what Lever's typeahead listens to before it searches. */
function typeLikeUser(input: HTMLInputElement, text: string): void {
  const key = text ? text[text.length - 1] : "Backspace";
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true, composed: true };
  input.dispatchEvent(new KeyboardEvent("keydown", init));
  setInput(input, text);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
  input.dispatchEvent(new KeyboardEvent("keyup", init));
}

/**
 * The suggestion to pick for `value` ("Toronto, ON, Canada"): one whose first
 * part is the same city and whose remaining words agree with the rest of the
 * value. Exactly one such suggestion, or none: picking "Toronto, Ohio" for a
 * Toronto, Ontario applicant would be a confident wrong answer.
 */
/** City, province/state and country of "Toronto, ON, CAN" / "Toronto, Ontario, Canada". */
function placeOf(text: string): { city: string; region: string | null; country: string | null } {
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  let region: string | null = null;
  let country: string | null = null;
  for (const p of parts.slice(1)) {
    const c = countryFromName(p) ?? (p.length === 2 && /^(us|ca|uk)$/i.test(p) ? countryByCode(p === "uk" || p === "UK" ? "GB" : p) : null);
    if (c && !country) {
      country = c.code;
      continue;
    }
    const r = regionFromText(p);
    if (r && !region) {
      region = `${r.country}:${r.code}`;
      if (!country) country = r.country;
    }
  }
  return { city: norm(parts[0] ?? ""), region, country };
}

/**
 * The suggestion to pick for `value` ("Toronto, ON, Canada"): the one that is
 * the same PLACE, compared as places, not words: Lever writes "Toronto, ON,
 * CAN" (ISO-3), a profile says "Canada" or "Ontario". Every part the value
 * states must agree; exactly one suggestion must survive, or none is picked:
 * "Toronto, OH, USA" for a Toronto, Ontario applicant would be a confident
 * wrong answer.
 */
export function pickLocationSuggestion(suggestions: string[], value: string): number {
  const want = placeOf(value);
  if (!want.city) return -1;
  const hits = suggestions
    .map((s, i) => ({ i, place: placeOf(s) }))
    .filter(({ place }) =>
      place.city === want.city &&
      (!want.region || !place.region || place.region === want.region) &&
      (!want.country || !place.country || place.country === want.country)
    );
  if (hits.length === 1) return hits[0].i;
  // Still several: keep the ones that state the region/country the value
  // states (a suggestion silent on the country is weaker than one that agrees).
  const explicit = hits.filter(({ place }) => (!want.region || place.region === want.region) && (!want.country || place.country === want.country));
  return explicit.length === 1 ? explicit[0].i : -1;
}

/**
 * Fill Lever's "Current location" typeahead the way a user does: type the city,
 * wait for Lever's own suggestion list, click the suggestion that is the
 * applicant's city. Lever then writes BOTH the visible input and the hidden
 * `selectedLocation` it validates on.
 *
 * Writing the text (and a hand-built selectedLocation JSON) without picking a
 * suggestion did not stick on live pages (2026-10-03, three Lever forms): the
 * typeahead clears an unpicked entry. That path remains only as the fallback
 * when no suggestion list appears.
 */
async function fillLeverLocation(input: HTMLInputElement, value: string): Promise<AdapterFillResult> {
  const scope =
    input.closest(".application-question, .application-field, form") ?? input.parentElement ?? document;
  const hidden = scope.querySelector<HTMLInputElement>('input[name="selectedLocation"]');
  const results = scope.querySelector<HTMLElement>(".dropdown-results");
  input.focus({ preventScroll: true });
  if (results) {
    const query = value.split(",")[0].trim();
    typeLikeUser(input, query);
    for (let waited = 0; waited < 4000; waited += 100) {
      await sleep(100);
      const items = Array.from(results.children).filter((c) => (c.textContent || "").trim()) as HTMLElement[];
      if (items.length === 0) continue;
      const idx = pickLocationSuggestion(items.map((c) => (c.textContent || "").trim()), value);
      if (idx < 0) break; // a list with no confident match: leave it to the user
      const item = items[idx];
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      item.click();
      await sleep(150);
      input.blur();
      const picked = !hidden || Boolean(hidden.value);
      return picked && input.value.trim()
        ? { filled: true }
        : { filled: false, reason: "Lever did not accept the location suggestion. Pick it manually." };
    }
    // No (confident) suggestion: undo our query text, the user picks.
    typeLikeUser(input, "");
    input.blur();
    return { filled: false, reason: "Pick your location from Lever's suggestion list." };
  }
  // Older markup without a suggestion list: the visible + hidden write.
  setInput(input, value);
  if (!hidden) {
    input.blur();
    return { filled: false, reason: "Pick your location from Lever's suggestion list." };
  }
  setInput(hidden, JSON.stringify({ name: value }));
  input.blur();
  return { filled: true };
}

export const leverAdapter: SiteAdapter = {
  id: "lever",
  label: "Lever",
  match: (host) => LEVER_HOST.test(host),

  classify(ctx: FieldContext): Classification | undefined {
    const category: FieldCategory = "currentCompany";
    if (ORG_RE.test(attrBlob(ctx.el))) return { category, confidence: 0.95, sensitive: false };
    return undefined;
  },

  fillOperation(ctx: FillContext): Promise<AdapterFillResult> | undefined {
    const el = ctx.el;
    if (el instanceof HTMLInputElement && el.matches('input[data-qa="location-input"]')) {
      return fillLeverLocation(el, ctx.value);
    }
    return undefined;
  },
};

ADAPTERS.push(leverAdapter);
