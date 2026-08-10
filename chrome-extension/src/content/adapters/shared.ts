// chrome-extension/src/content/adapters/shared.ts
/**
 * Shared helpers for site adapters. They keep the per-ATS modules small and
 * uniform: attribute-based classification, React-safe writes, date parsing, and
 * selector-based advance-button discovery.
 *
 * Everything here is advisory. A helper returns `undefined`/`null` whenever a
 * rule doesn't apply, so an adapter built on them still defers to the generic
 * pipeline by default and can only ever *refine* classification, never break it.
 */
import type { Classification } from "../fieldMatcher";
import type { FieldCategory } from "../../shared/types";

/**
 * Structural attributes an ATS uses to *name* a field, most reliable first.
 * Deliberately excludes the visible label / aria-label — the generic classifier
 * already reads those. Adapters win precisely where the machine name carries
 * meaning the label hides (e.g. Lever's `urls[LinkedIn]`, Workday's
 * `data-automation-id`).
 */
const FIELD_ATTRS = [
  "name",
  "id",
  "data-automation-id",
  "data-automation",
  "data-test",
  "data-testid",
  "data-qa",
  "data-ui",
  "data-field",
] as const;

/**
 * Lower-cased concatenation of `el`'s structural attributes, plus — for each
 * name in `ancestorAttrs` — the value on its closest ancestor carrying that
 * attribute (Workday wraps the real input in a `[data-automation-id]` div).
 */
export function attrBlob(el: HTMLElement, ancestorAttrs: readonly string[] = []): string {
  const parts: string[] = [];
  for (const a of FIELD_ATTRS) {
    const v = el.getAttribute(a);
    if (v) parts.push(v);
  }
  for (const a of ancestorAttrs) {
    const v = el.closest(`[${a}]`)?.getAttribute(a);
    if (v) parts.push(v);
  }
  return parts.join(" ").toLowerCase();
}

const SENSITIVE: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "eeoGender",
  "eeoGenderIdentity",
  "eeoPronouns",
  "eeoRace",
  "eeoHispanic",
  "eeoVeteran",
  "eeoDisability",
  "eeoSexualOrientation",
  "eeoOther",
]);

export type AttrRule = readonly [RegExp, FieldCategory];

/**
 * First rule whose regex matches `el`'s attribute blob → a Classification;
 * no match → `undefined` (defer to the generic classifier). EEO categories are
 * flagged `sensitive` so they stay excluded from autofill unless the user opts in.
 */
export function classifyByAttr(
  el: HTMLElement,
  rules: readonly AttrRule[],
  confidence = 0.95,
  ancestorAttrs: readonly string[] = []
): Classification | undefined {
  const blob = attrBlob(el, ancestorAttrs);
  if (!blob) return undefined;
  for (const [re, category] of rules) {
    if (re.test(blob)) return { category, confidence, sensitive: SENSITIVE.has(category) };
  }
  return undefined;
}

/**
 * Social / profile-URL questions keyed by machine name. Many ATS render these
 * with a generic label ("URL", "Link") while the network lives only in the
 * `name`/`id` (`urls[LinkedIn]`, `candidate[github_url]`). The portfolio rule
 * intentionally excludes a bare "website" so a *company* website field is never
 * mistaken for the candidate's portfolio (mirrors the generic matcher's veto).
 */
export const SOCIAL_URL_RULES: readonly AttrRule[] = [
  [/linked\s*in/, "linkedin"],
  [/git\s*hub/, "github"],
  [/portfolio|personal.?(web\s*site|site|url|page)|other[_\s-]?(url|web\s*site|link)/, "portfolio"],
];

/**
 * First/last name by machine name — for ATS that namespace fields
 * (`candidate[first_name]`, `job_application[last_name]`). Kept to the two
 * unambiguous names; email/phone are left to the generic matcher because their
 * machine names collide with country-code / extension sub-fields.
 */
export const NAME_ATTR_RULES: readonly AttrRule[] = [
  [/first[_\s-]?name|given[_\s-]?name|\bfname\b/, "firstName"],
  [/last[_\s-]?name|family[_\s-]?name|\blname\b/, "lastName"],
];

/** React-tracker-safe value write + the event sequence frameworks listen for. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export interface DateParts {
  month: string;
  day: string;
  year: string;
}

/** Parse ISO (`YYYY-MM-DD`) or US (`M/D/YYYY`) into unpadded parts; null otherwise. */
export function parseDateParts(v: string): DateParts | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { year: iso[1], month: String(Number(iso[2])), day: String(Number(iso[3])) };
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { month: String(Number(us[1])), day: String(Number(us[2])), year: us[3] };
  return null;
}

/**
 * First enabled element matching any selector, searching `scope` first then the
 * whole document (multi-step footers frequently sit outside the field
 * container). Falls back to the first match at all when none look enabled, since
 * `findAdvanceButton` re-applies its own terminal + visibility gate anyway.
 */
export function advanceBySelectors(
  scope: HTMLElement,
  selectors: readonly string[]
): HTMLElement | null {
  const roots: (ParentNode | null)[] = [scope, scope.ownerDocument];
  let firstAny: HTMLElement | null = null;
  for (const sel of selectors) {
    for (const root of roots) {
      if (!root) continue;
      for (const el of root.querySelectorAll<HTMLElement>(sel)) {
        firstAny ??= el;
        if (isEnabled(el)) return el;
      }
    }
  }
  return firstAny;
}

function isEnabled(el: HTMLElement): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
}
