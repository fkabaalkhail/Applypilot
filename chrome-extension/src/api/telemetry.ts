/**
 * Autofill telemetry sender. Reports one fill-pass summary (field labels +
 * outcomes, never values) to the backend so we can see where the filler struggles
 * and author server-side override rules in response. Best-effort; runs in the SW.
 */
import { authedRequest } from "./client";
import type { AutofillTelemetry } from "../shared/types";

export async function reportAutofillTelemetry(t: AutofillTelemetry): Promise<void> {
  await authedRequest("/autofill/telemetry", {
    method: "POST",
    body: JSON.stringify({
      host: t.host,
      ats_type: t.atsType,
      url: t.url,
      total_fields: t.totalFields,
      filled: t.filled,
      failed: t.failed,
      skipped: t.skipped,
      failed_fields: t.failedFields,
      // Successes included — see FieldOutcomeRecord. Labels, categories,
      // provenance and booleans only; the wire carries no answer text.
      field_outcomes: (t.fieldOutcomes ?? []).map((f) => ({
        label: f.label,
        category: f.category,
        tier: f.tier,
        pass: f.pass,
        expected_value_present: f.expectedValuePresent,
        observed_value_present: f.observedValuePresent,
        outcome: f.outcome,
        reason: f.reason ?? "",
      })),
      reverted: t.reverted ?? 0,
    }),
  });
}
