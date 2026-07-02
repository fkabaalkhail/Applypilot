/**
 * Applies adapter hooks over the generic pipeline. Each helper falls back to
 * generic behavior when the adapter is null, the hook is absent, the hook
 * declines (undefined), or the hook throws — so an adapter can only ever refine,
 * never break, the pipeline.
 */
import { classifyField, resolveProfileValue, type Classification } from "../fieldMatcher";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../../shared/types";
import type { RuntimeControl } from "../formScanner";
import type { AdapterFillResult, FieldContext, FillContext, SiteAdapter } from "./types";

function safe<T>(fn: () => T, label: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.warn(`[adapter ${label}]`, e);
    return undefined;
  }
}

export function classifyWithAdapter(adapter: SiteAdapter | null, ctx: FieldContext): Classification {
  const generic = classifyField(ctx.signals);
  if (!adapter?.classify) return generic;
  const override = safe(() => adapter.classify!(ctx, generic), "classify");
  return override ?? generic;
}

export function resolveAnswerWithAdapter(
  adapter: SiteAdapter | null,
  category: FieldCategory,
  profile: UserApplicationProfile | null,
  control: { controlType: ControlType; options?: string[]; groupIndex?: number | null },
  fillEEO: boolean,
  el: HTMLElement
): string | null {
  if (!profile) return null;
  if (adapter?.resolveAnswer) {
    const override = safe(() => adapter.resolveAnswer!({ category, profile, control, fillEEO, el }), "resolveAnswer");
    if (override !== undefined) return override;
  }
  return resolveProfileValue(category, profile, control, fillEEO);
}

/** undefined = adapter declines this field (generic fill); Promise = adapter owns it. */
export function tryAdapterOperation(
  adapter: SiteAdapter | null,
  ctx: FillContext
): Promise<AdapterFillResult> | undefined {
  if (!adapter?.fillOperation) return undefined;
  return safe(() => adapter.fillOperation!(ctx), "fillOperation");
}

/** Give the adapter first refusal on each item; run claimed ops, return the rest. */
export async function runAdapterOperations(
  adapter: SiteAdapter | null,
  items: { fieldId: string; value: string }[],
  getControl: (id: string) => RuntimeControl | undefined
): Promise<{ opOutcomes: { fieldId: string; ok: boolean }[]; remaining: { fieldId: string; value: string }[] }> {
  const opOutcomes: { fieldId: string; ok: boolean }[] = [];
  const remaining: { fieldId: string; value: string }[] = [];
  for (const it of items) {
    const control = getControl(it.fieldId);
    const op = control?.el ? tryAdapterOperation(adapter, { control, value: it.value, el: control.el }) : undefined;
    if (op) {
      const r = await op.catch(() => ({ filled: false as const }));
      opOutcomes.push({ fieldId: it.fieldId, ok: r.filled });
    } else {
      remaining.push(it);
    }
  }
  return { opOutcomes, remaining };
}
