/**
 * Autofill telemetry — build a per-fill summary from the combined pass
 * reports/outcomes so the backend can see which sites and fields the filler
 * struggles with. This is the signal that tells us where a server-side override
 * rule is worth authoring (see api/autofill overrides).
 *
 * Privacy: emits field LABELS + outcomes only, never the user's answer values.
 * Pure — host/url are passed in, so it unit-tests without a document.
 */
import type { AutofillTelemetry, DetectedField } from "../shared/types";
import type { FieldReport } from "./reconciler";

export function buildAutofillTelemetry(
  fields: DetectedField[],
  ctx: { host: string; url: string; atsType: string },
  reports: FieldReport[],
  outcomes: { fieldId: string; ok: boolean }[]
): AutofillTelemetry {
  // Final outcome per attempted field: ok in ANY pass wins (a field the AI pass
  // filled after the local pass missed counts as filled).
  const finalOk = new Map<string, boolean>();
  const reasonById = new Map<string, string>();
  const mark = (id: string, ok: boolean, reason?: string): void => {
    finalOk.set(id, (finalOk.get(id) ?? false) || ok);
    if (!ok && reason && !reasonById.has(id)) reasonById.set(id, reason);
  };
  for (const r of reports) mark(r.fieldId, r.ok, r.reason);
  for (const o of outcomes) mark(o.fieldId, o.ok);

  const byId = new Map(fields.map((f) => [f.id, f]));
  const failedFields: { label: string; category: string; reason: string }[] = [];
  let filled = 0;
  let failed = 0;
  for (const [id, ok] of finalOk) {
    if (ok) {
      filled++;
      continue;
    }
    failed++;
    const f = byId.get(id);
    failedFields.push({
      label: (f?.label ?? "").slice(0, 200),
      category: f?.category ?? "unknown",
      reason: (reasonById.get(id) ?? "").slice(0, 200),
    });
  }

  return {
    host: ctx.host,
    atsType: ctx.atsType,
    url: ctx.url,
    totalFields: finalOk.size,
    filled,
    failed,
    skipped: 0,
    failedFields,
  };
}
