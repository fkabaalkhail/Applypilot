/**
 * Autofill telemetry: build a per-fill summary from the combined pass
 * reports/outcomes so the backend can see which sites and fields the filler
 * struggles with. This is the signal that tells us where a server-side override
 * rule is worth authoring (see api/autofill overrides).
 *
 * It now records SUCCESSES as well as failures, and it diffs what was written
 * against what the page holds afterwards.
 *
 * Why: recording only failures made one whole bug class unobservable by
 * construction, a field answered wrongly but written successfully produced a
 * `filled` count and nothing else, so the record of the page said everything
 * went well. That is exactly the bug we keep hitting ("reported filled,
 * actually wasn't" / "filled with the wrong value"), and it was the one thing
 * the data could never show.
 *
 * The re-scan diff is the second half. Per-write verification (writeEngine)
 * proves the commit stuck AT WRITE TIME. A framework can still revert a value
 * on blur, on validation, or on a re-render that a LATER field triggered, none
 * of which a per-write check can see, because by then it has moved on.
 *
 * Privacy: emits field LABELS, categories, provenance and booleans only, never
 * the user's answer values. `observedValuePresent` is a boolean for that reason
 * "this control holds something" is the observation, not what it holds.
 *
 * Pure: host/url/observations are passed in, so it unit-tests without a
 * document.
 */
import type { AutofillTelemetry, DetectedField, FieldOutcomeRecord } from "../shared/types";
import type { FieldReport } from "./reconciler";

export interface PassOutcomeLike {
  fieldId: string;
  ok: boolean;
  reason?: string;
}

/** Where a field's value came from, for one fill pass. */
export interface FieldProvenance {
  /** "profile" (on-device fast path) | "backend" | "device" (EEO matching) | "user". */
  tier: string;
  /** Backend pass, when the backend produced it: "derived" | "rule" | "memory" | "ai". */
  pass?: string;
}

/** A field the backend gate refused, with its reason. Never carries a value. */
export interface DroppedAnswerLike {
  fieldId: string;
  reason: string;
  /** Which pass proposed the value that was dropped. */
  source?: string;
}

/**
 * Collapse every pass's reports/outcomes into one verdict per attempted field:
 * ok in ANY pass wins (a field the AI pass filled after the local pass missed
 * counts as filled). The first failure reason seen is kept for the ones that
 * never succeeded.
 */
export function finalOutcomes(
  reports: FieldReport[],
  outcomes: PassOutcomeLike[]
): { ok: Map<string, boolean>; reason: Map<string, string> } {
  const ok = new Map<string, boolean>();
  const reason = new Map<string, string>();
  const mark = (id: string, passed: boolean, why?: string): void => {
    ok.set(id, (ok.get(id) ?? false) || passed);
    if (!passed && why && !reason.has(id)) reason.set(id, why);
  };
  for (const r of reports) mark(r.fieldId, r.ok, r.reason);
  for (const o of outcomes) mark(o.fieldId, o.ok, o.reason);
  return { ok, reason };
}

/**
 * What the page holds for one field after the fill, read from a fresh scan.
 *
 * `value` is compared, never transmitted, the record carries only whether it
 * was present and whether it still matches what was written.
 */
export interface ObservedField {
  fieldId: string;
  value: string;
}

/** What one field was asked to hold. */
export interface IntendedField {
  fieldId: string;
  value: string;
}

/** Loose equality between a written value and what the control reads back.
 *
 *  Mirrors writeEngine's own read-back comparison: a control may normalize
 *  case, punctuation or surrounding space without having changed the answer,
 *  and a choice widget may display more than was written ("Yes" → "Yes, I am").
 *
 *  An EMPTY control is never equal to a non-empty write. That has to be stated
 *  outright: every string contains "", so a substring test alone reports a
 *  cleared field as unchanged, which would silently drop the most common
 *  revert there is.
 *
 *  Lenience is deliberately one-directional: a missed revert costs a record, a
 *  spurious one costs the user a question they already answered. */
function sameValue(written: string, observed: string): boolean {
  const core = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = core(written);
  const o = core(observed);
  if (!w) return !o;
  if (!o) return false;
  return w === o || o.includes(w) || w.includes(o);
}

/** One field whose committed value disagrees with what was written. */
export interface RevertedField {
  fieldId: string;
  /** True when the control is now empty; false when it holds something else. */
  cleared: boolean;
}

/**
 * Fields that were written successfully and no longer hold what was written.
 *
 * Only fields we actually wrote AND believed we wrote are considered: a field
 * whose write already failed is a failure, not a revert, and conflating the two
 * would hide the interesting case behind the ordinary one.
 *
 * A field missing from `observed` is NOT reported. It left the DOM between the
 * fill and the re-scan (a step change, a collapsed section), which says nothing
 * about whether the value stuck.
 */
export function revertedFields(
  intended: IntendedField[],
  observed: ObservedField[],
  filledOk: ReadonlySet<string>
): RevertedField[] {
  const byId = new Map(observed.map((o) => [o.fieldId, o.value]));
  const out: RevertedField[] = [];
  for (const { fieldId, value } of intended) {
    if (!filledOk.has(fieldId)) continue;
    if (!byId.has(fieldId)) continue;
    const now = (byId.get(fieldId) ?? "").trim();
    if (sameValue(value, now)) continue;
    out.push({ fieldId, cleared: now === "" });
  }
  return out;
}

export interface TelemetryInputs {
  reports: FieldReport[];
  outcomes: PassOutcomeLike[];
  /** fieldId → where its value came from. Missing → tier "" (unknown). */
  provenance?: ReadonlyMap<string, FieldProvenance>;
  /** What each field was asked to hold, for the re-scan diff. */
  intended?: IntendedField[];
  /** Fresh scan of the page after the fill settled. */
  observed?: ObservedField[];
  /** Candidate values the backend gate refused. */
  dropped?: DroppedAnswerLike[];
}

export function buildAutofillTelemetry(
  fields: DetectedField[],
  ctx: { host: string; url: string; atsType: string },
  inputs: TelemetryInputs
): AutofillTelemetry {
  const { ok: finalOk, reason: reasonById } = finalOutcomes(inputs.reports, inputs.outcomes);

  const byId = new Map(fields.map((f) => [f.id, f]));
  const intended = inputs.intended ?? [];
  const observed = inputs.observed ?? [];
  const okIds = new Set([...finalOk].filter(([, ok]) => ok).map(([id]) => id));
  const reverted = observed.length > 0 ? revertedFields(intended, observed, okIds) : [];
  const revertedById = new Map(reverted.map((r) => [r.fieldId, r]));
  const droppedById = new Map((inputs.dropped ?? []).map((d) => [d.fieldId, d]));
  const observedById = new Map(observed.map((o) => [o.fieldId, o.value]));
  const intendedIds = new Set(intended.map((i) => i.fieldId));

  const failedFields: { label: string; category: string; reason: string }[] = [];
  const fieldOutcomes: FieldOutcomeRecord[] = [];
  let filled = 0;
  let failed = 0;

  // Every field with a verdict, plus every field the gate dropped, a dropped
  // field was never written, so it has no report of its own and would
  // otherwise vanish from the record entirely.
  const ids = new Set<string>([...finalOk.keys(), ...droppedById.keys()]);

  for (const id of ids) {
    const f = byId.get(id);
    const label = (f?.label ?? "").slice(0, 200);
    const category = f?.category ?? "unknown";
    const prov = inputs.provenance?.get(id);
    const drop = droppedById.get(id);
    const wroteOk = finalOk.get(id) ?? false;
    const revert = revertedById.get(id);

    let outcome: FieldOutcomeRecord["outcome"];
    let reason = "";
    if (drop && !wroteOk) {
      outcome = "dropped";
      reason = drop.reason;
    } else if (revert) {
      outcome = "reverted";
      reason = revert.cleared ? "value_cleared_after_write" : "value_changed_after_write";
    } else if (wroteOk) {
      outcome = "filled";
    } else if (!intendedIds.has(id) && !finalOk.has(id)) {
      outcome = "skipped";
    } else {
      outcome = "failed";
      reason = reasonById.get(id) ?? "";
    }

    // A revert is a failure of the fill even though the write reported success:
    // the page does not hold the answer. Counting it as filled is precisely the
    // lie this record exists to stop telling.
    if (outcome === "filled") filled++;
    else failed++;
    if (outcome !== "filled" && outcome !== "skipped") {
      failedFields.push({ label, category, reason: reason.slice(0, 200) });
    }

    fieldOutcomes.push({
      label,
      category,
      tier: prov?.tier ?? "",
      pass: prov?.pass ?? "",
      expectedValuePresent: intendedIds.has(id),
      observedValuePresent: (observedById.get(id) ?? "").trim() !== "",
      outcome,
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
    });
  }

  return {
    host: ctx.host,
    atsType: ctx.atsType,
    url: ctx.url,
    totalFields: ids.size,
    filled,
    failed,
    skipped: 0,
    failedFields: failedFields.slice(0, 50),
    fieldOutcomes: fieldOutcomes.slice(0, 100),
    reverted: reverted.length,
  };
}
