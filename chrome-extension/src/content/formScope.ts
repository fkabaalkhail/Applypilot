/**
 * Application-form scoping. scanPage sweeps the whole document, so beyond page
 * chrome (pageChrome.ts) stray controls, footer newsletter signups, sidebar
 * widgets, still surface. This module finds THE application-form container and
 * callers drop fields outside it.
 *
 * Candidates: every <form> holding a recognized field, main/[role=main], and
 * the lowest common ancestor of all recognized fields. Winner: the DEEPEST
 * candidate containing >= 80% of recognized fields. No qualifying candidate →
 * null, and callers keep the unscoped result (scoping only ever narrows).
 */
import type { DetectedField } from "../shared/types";
import { composedAncestors } from "./pageChrome";

export interface ScopeEntry {
  field: DetectedField;
  /** The control's live element (first member for radio/checkbox groups). */
  el: HTMLElement;
}

const SCOPE_SHARE = 0.8;

export function resolveFormScope(entries: ScopeEntry[]): HTMLElement | null {
  const recognized = entries.filter((e) => e.field.category !== "unknown");
  if (recognized.length < 2) return null; // one field can't outline a form

  // Scope within the document owning the most recognized fields (deepQueryAll
  // may pull fields from same-origin iframes; containment never crosses docs).
  const byDoc = new Map<Document, ScopeEntry[]>();
  for (const e of recognized) {
    const doc = e.el.ownerDocument;
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), e]);
  }
  let home: ScopeEntry[] = [];
  for (const list of byDoc.values()) if (list.length > home.length) home = list;
  if (home.length < 2) return null;
  const doc = home[0].el.ownerDocument;

  const candidates = new Set<HTMLElement>();
  for (const e of home) {
    const form = e.el.closest("form");
    if (form) candidates.add(form as HTMLElement);
  }
  doc.querySelectorAll('main, [role="main"]').forEach((m) => candidates.add(m as HTMLElement));
  const lca = lowestCommonAncestor(home.map((e) => e.el));
  if (lca && lca !== doc.documentElement && lca !== doc.body) candidates.add(lca);
  candidates.delete(doc.documentElement);
  if (doc.body) candidates.delete(doc.body);

  const needed = Math.ceil(home.length * SCOPE_SHARE);
  let best: { el: HTMLElement; depth: number } | null = null;
  for (const c of candidates) {
    const inside = home.filter((e) => composedContains(c, e.el)).length;
    if (inside < needed) continue;
    const depth = composedAncestors(c).length;
    if (!best || depth > best.depth) best = { el: c, depth };
  }
  return best?.el ?? null;
}

/** Entries kept under `scope`: outside entries are dropped whatever their
 *  category (a footer newsletter email is noise even though "email" is known). */
export function filterToScope(entries: ScopeEntry[], scope: HTMLElement): ScopeEntry[] {
  return entries.filter((e) => composedContains(scope, e.el));
}

/** contains() that also pierces open shadow roots (Node.contains does not). */
function composedContains(container: HTMLElement, el: HTMLElement): boolean {
  if (container === el || container.contains(el)) return true;
  return composedAncestors(el).includes(container);
}

/** LCA across the composed tree (shadow-piercing), or null. */
function lowestCommonAncestor(els: HTMLElement[]): HTMLElement | null {
  if (els.length === 0) return null;
  const first: HTMLElement[] = [els[0], ...composedAncestors(els[0])];
  const rest = els.slice(1).map((el) => new Set<HTMLElement>([el, ...composedAncestors(el)]));
  for (const node of first) {
    if (rest.every((s) => s.has(node))) return node;
  }
  return null;
}
