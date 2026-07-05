// chrome-extension/src/content/repeatingSections.ts
/**
 * Repeating-section expansion (work experience / education).
 *
 * The resolver already fills row N of a repeating section from
 * `profile.experience[N]` / `profile.education[N]` (via each field's
 * `groupIndex`). What was missing: CREATING the extra rows. Many ATS (Workday,
 * Taleo, iCIMS, Greenhouse) show one empty work-history row and an
 * "Add another" button; a candidate with three jobs only got the first filled.
 *
 * This module plans how many "Add" clicks a section needs (profile entries −
 * rows present) and finds the add-row control. The imperative click→settle→
 * rescan loop lives in contentScript. Everything here is pure and testable.
 */
import type { DetectedField, FieldCategory, UserApplicationProfile } from "../shared/types";
import { cleanText, deepQueryAll, isVisible } from "./domUtils";

export type SectionKind = "experience" | "education";

export const SECTION_KINDS: readonly SectionKind[] = ["experience", "education"];

/** Safety cap on rows we will ever create for one section. */
export const MAX_ROWS = 6;

const KIND_CATEGORIES: Record<SectionKind, ReadonlySet<FieldCategory>> = {
  experience: new Set<FieldCategory>([
    "currentCompany",
    "currentTitle",
    "experienceStartDate",
    "experienceEndDate",
    "experienceDescription",
    "experienceCurrent",
  ]),
  education: new Set<FieldCategory>(["school", "degree", "graduationYear"]),
};

/** Section-specific "Add …" button text (matched anywhere on the page). */
const ADD_SPECIFIC: Record<SectionKind, RegExp> = {
  experience: /\badd\b[\s\S]{0,24}(employment|work\s*experience|experience|position|job|role)\b/i,
  education: /\badd\b[\s\S]{0,24}(education|school|degree|university|college|qualification)\b/i,
};

/** A generic add-row button ("Add", "+ Add another") — only trusted when it
 *  sits inside or adjacent to the section's own container. */
const ADD_GENERIC = /^\s*\+?\s*add(\s+(another|more|new|row|\+))?\s*\+?\s*$/i;

const ADD_SELECTOR = 'button, a[href], [role="button"], input[type="button"], input[type="submit"]';

function hasContent(entry: unknown): boolean {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      Object.values(entry as Record<string, unknown>).some((v) => typeof v === "string" && v.trim())
  );
}

/** Rows the profile supplies for a section (non-empty entries only). */
export function rowsNeeded(profile: UserApplicationProfile, kind: SectionKind): number {
  const arr = kind === "experience" ? profile.experience : profile.education;
  return Array.isArray(arr) ? arr.filter(hasContent).length : 0;
}

/** Rows already present on the page: (max group index among the section's
 *  fields) + 1; 1 when its fields exist without an index; 0 when none. */
export function rowsPresent(fields: DetectedField[], kind: SectionKind): number {
  const cats = KIND_CATEGORIES[kind];
  const indices = fields.filter((f) => cats.has(f.category)).map((f) => f.groupIndex ?? 0);
  return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

function buttonText(el: HTMLElement): string {
  return (
    cleanText(el.getAttribute("aria-label")) ||
    cleanText(el.textContent) ||
    cleanText((el as HTMLInputElement).value ?? "")
  );
}

function isClickable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return isVisible(el);
}

/** Lowest common ancestor of a set of elements (or the single element). */
function commonAncestor(els: HTMLElement[]): HTMLElement | null {
  if (els.length === 0) return null;
  let ancestor: HTMLElement | null = els[0];
  for (let i = 1; i < els.length && ancestor; i++) {
    const chain = new Set<HTMLElement>();
    for (let n: HTMLElement | null = ancestor; n; n = n.parentElement) chain.add(n);
    let n: HTMLElement | null = els[i];
    while (n && !chain.has(n)) n = n.parentElement;
    ancestor = n;
  }
  return ancestor;
}

function sectionContainer(
  fields: DetectedField[],
  kind: SectionKind,
  getEl: (id: string) => HTMLElement | undefined
): HTMLElement | null {
  const els = fields
    .filter((f) => KIND_CATEGORIES[kind].has(f.category))
    .map((f) => getEl(f.id))
    .filter((e): e is HTMLElement => Boolean(e));
  return commonAncestor(els);
}

/**
 * The "Add another <section>" control, or null. Prefers a section-specific
 * button (unambiguous); otherwise a generic add button inside/adjacent to the
 * section's container, so a generic "Add" from a different section can't match.
 */
export function findAddButton(
  fields: DetectedField[],
  kind: SectionKind,
  getEl: (id: string) => HTMLElement | undefined,
  doc: Document | HTMLElement = document
): HTMLElement | null {
  for (const el of deepQueryAll(doc, ADD_SELECTOR)) {
    const text = buttonText(el);
    if (text && text.length <= 40 && ADD_SPECIFIC[kind].test(text) && isClickable(el)) return el;
  }
  const container = sectionContainer(fields, kind, getEl);
  if (!container) return null;
  const roots = [container, container.nextElementSibling, container.parentElement].filter(
    (r): r is HTMLElement => r instanceof HTMLElement
  );
  for (const root of roots) {
    for (const el of deepQueryAll(root, ADD_SELECTOR)) {
      const text = buttonText(el);
      if (text && text.length <= 24 && ADD_GENERIC.test(text) && isClickable(el)) return el;
    }
  }
  return null;
}

export interface ExpansionStep {
  kind: SectionKind;
  addButton: HTMLElement;
  /** How many times to click to reach the profile's row count. */
  clicks: number;
}

/** Plan expansion for every repeating section present on the page. */
export function planExpansion(
  profile: UserApplicationProfile,
  fields: DetectedField[],
  getEl: (id: string) => HTMLElement | undefined,
  doc: Document | HTMLElement = document
): ExpansionStep[] {
  const steps: ExpansionStep[] = [];
  for (const kind of SECTION_KINDS) {
    const needed = Math.min(rowsNeeded(profile, kind), MAX_ROWS);
    if (needed === 0) continue;
    const clicks = needed - rowsPresent(fields, kind);
    if (clicks <= 0) continue;
    // findAddButton needs a section-specific button when there are no rows to
    // scope a generic "Add" — so an empty section only expands on unambiguous text.
    const addButton = findAddButton(fields, kind, getEl, doc);
    if (addButton) steps.push({ kind, addButton, clicks });
  }
  return steps;
}
