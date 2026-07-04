// chrome-extension/src/content/adapters/lever.ts
/**
 * Lever (`*.lever.co`). Lever's standard fields (name/email/phone/country/
 * cover-letter) fill cleanly through the generic pipeline, so this adapter only
 * owns the two places the generic path gets Lever wrong:
 *
 *  1. Current-company / org text field — named `org` / `current-company`,
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

/**
 * Fill Lever's location typeahead by writing both the visible input and the
 * hidden `selectedLocation` field it actually submits. Resolves filled:true
 * when the hidden field exists (the value will stick); filled:false with a
 * manual hint when the markup is unexpectedly missing it.
 */
async function fillLeverLocation(input: HTMLInputElement, value: string): Promise<AdapterFillResult> {
  input.focus({ preventScroll: true });
  setInput(input, value);
  // The hidden field is a sibling in the same question container. Search the
  // parent first (matches Jobright), widening to the enclosing question/form.
  const scope =
    input.closest(".application-question, .application-field, form") ?? input.parentElement ?? document;
  const hidden = scope.querySelector<HTMLInputElement>('input[name="selectedLocation"]');
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
