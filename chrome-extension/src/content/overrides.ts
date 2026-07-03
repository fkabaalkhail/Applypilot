/**
 * Server-driven classification overrides — the hot-fix layer.
 *
 * Rules authored server-side (GET /autofill/overrides) let us correct a broken or
 * newly-changed site WITHOUT shipping a new extension: match a field by host +
 * a normalized-label regex and force its category. Applied last in
 * classifyWithAdapter, so an override wins over both the generic classifier and
 * the compiled site adapter (the adapter being wrong is exactly why we hot-fix).
 *
 * State is per-frame module scope, set once after the background delivers the
 * cached rules. Empty by default, so with no rules this is a pure no-op and the
 * generic pipeline is untouched.
 */
import type { Classification } from "./fieldMatcher";
import type { FieldContext } from "./adapters/types";
import type { AutofillOverrideRule, FieldCategory } from "../shared/types";

interface CompiledRule {
  re: RegExp;
  category: string;
  valueSynonyms: Record<string, string>;
}

let compiled: CompiledRule[] = [];

/** Host match: "*" (any), exact, or a domain suffix (rule "greenhouse.io"
 *  matches "boards.greenhouse.io"). "*.x" is treated as the suffix "x". */
function hostMatches(rule: string, host: string): boolean {
  if (rule === "*") return true;
  const r = rule.toLowerCase().replace(/^\*\./, "");
  const h = host.toLowerCase();
  return h === r || h.endsWith("." + r);
}

/** Compile the rules that apply to `host` (called after the background fetch). */
export function setOverrideRules(rules: AutofillOverrideRule[], host: string): void {
  const next: CompiledRule[] = [];
  for (const r of rules) {
    if (!r.category || !r.labelPattern || !hostMatches(r.host, host)) continue;
    let re: RegExp;
    try {
      re = new RegExp(r.labelPattern, "i");
    } catch {
      continue; // a bad pattern must never break classification
    }
    next.push({ re, category: r.category, valueSynonyms: r.valueSynonyms ?? {} });
  }
  compiled = next;
}

/** Test hook / reset. */
export function clearOverrideRules(): void {
  compiled = [];
}

export function hasOverrideRules(): boolean {
  return compiled.length > 0;
}

/**
 * Apply a matching override to a classification. The label haystack combines the
 * field's label sources so a rule matches whichever one carries the text.
 */
export function applyOverride(ctx: FieldContext, current: Classification): Classification {
  if (compiled.length === 0) return current;
  const s = ctx.signals;
  const hay = `${s.label} ${s.ariaLabel} ${s.nearby} ${s.placeholder}`.toLowerCase();
  for (const r of compiled) {
    if (r.re.test(hay)) {
      return { ...current, category: r.category as FieldCategory, confidence: Math.max(current.confidence, 0.95) };
    }
  }
  return current;
}
