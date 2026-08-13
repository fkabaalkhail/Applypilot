/**
 * Autofill telemetry sender. Reports one fill-pass summary (field labels +
 * outcomes, never values) to the backend so we can see where the filler struggles
 * and author server-side override rules in response. Best-effort; runs in the SW.
 */
import { authedRequest } from "./client";
import type { AutofillTelemetry } from "../shared/types";

/**
 * Whether this account turned diagnostic capture on.
 *
 * Cached for the life of the service worker: it changes at most when the user
 * flips a setting, and asking once per fill would add a round trip to every
 * autofill for a value that is almost always `false`.
 */
let diagnosticCache: { at: number; value: boolean } | null = null;
const DIAGNOSTIC_TTL_MS = 10 * 60 * 1000;

export async function isDiagnosticCaptureEnabled(): Promise<boolean> {
  const now = Date.now();
  if (diagnosticCache && now - diagnosticCache.at < DIAGNOSTIC_TTL_MS) return diagnosticCache.value;
  const res = await authedRequest<{ enabled?: boolean }>("/autofill/diagnostic");
  const value = Boolean(res?.enabled);
  diagnosticCache = { at: now, value };
  return value;
}

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
      // Successes included: see FieldOutcomeRecord. Labels, categories,
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
      extension_version: t.extensionVersion ?? "",
      durations: t.durations ?? null,
      // Diagnostic mode only. Absent for every account that did not opt in,
      // which is what keeps the default posture above true.
      field_captures: (t.fieldCaptures ?? []).map((c) => ({
        field_id: c.fieldId,
        label: c.label,
        category: c.category,
        confidence: c.confidence,
        control_type: c.controlType,
        input_type: c.inputType,
        help_text: c.helpText,
        required: c.required,
        group_index: c.groupIndex,
        options: c.options,
        proposed_value: c.proposedValue,
        observed_value: c.observedValue,
        redacted: c.redacted,
        tier: c.tier,
        pass: c.pass,
        outcome: c.outcome,
        reason: c.reason,
        dom: c.dom,
        selector: c.selector,
      })),
    }),
  });
}
