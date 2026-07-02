/**
 * Decides what the AI fill pass does with each field: which fields are eligible,
 * how to map them to the backend's field shape, which backend answers fill
 * inline, and how to tally outcomes across passes.
 *
 * Pure functions only — no DOM, no network — so the orchestration in
 * contentScript stays thin and this logic is fully unit-tested.
 */
import type { AiFillField, DetectedField, FieldCategory } from "../shared/types";

/** Labels that read like a question worth answering even on a plain text input. */
const QUESTION_LABEL =
  /\?|\b(why|describe|tell us|explain|how many|years of|experience with|are you|do you|have you|salary|expected|notice period|available|authorized|sponsor|willing)\b/i;

/** Whether a field is eligible for AI fill at all (independent of its current value). */
export function isAiCandidate(field: DetectedField): boolean {
  if (!field.fillable || field.sensitive) return false;
  if (field.controlType === "file" || field.controlType === "customDropdown") return false;
  if (field.controlType === "textarea" || field.controlType === "contenteditable") return true;
  if (
    field.controlType === "select" ||
    field.controlType === "radioGroup" ||
    field.controlType === "checkbox" ||
    field.controlType === "checkboxGroup" ||
    // Custom ARIA dropdowns: the AI answers them like any choice field; the
    // answer is then driven into the widget by the listbox engine (see
    // contentScript), since writeControl can't script a combobox directly.
    field.controlType === "combobox"
  ) {
    return true;
  }
  // Plain text: only answer when the label reads like a question.
  return QUESTION_LABEL.test(field.label);
}

/** Eligible fields that are still empty (no profile value, nothing the user typed). */
export function aiFillCandidates(fields: DetectedField[]): DetectedField[] {
  return fields.filter(
    (f) => isAiCandidate(f) && f.proposedValue === null && !f.currentValue
  );
}

function mapType(controlType: DetectedField["controlType"]): AiFillField["type"] {
  switch (controlType) {
    case "textarea":
    case "contenteditable":
      return "textarea";
    case "select":
      return "select";
    case "radioGroup":
      return "radio";
    case "checkbox":
      return "checkbox";
    case "checkboxGroup":
      return "select";
    // Custom ARIA dropdown — a single-choice control; the backend snaps the
    // answer to one of `options` when present (see backend/routers/fill.py).
    case "combobox":
      return "select";
    default:
      return "text";
  }
}

export function toAiFillField(field: DetectedField): AiFillField {
  return {
    id: field.id,
    label: field.label,
    type: mapType(field.controlType),
    options: field.options ?? [],
    required: field.required,
  };
}

export interface AiFillPlan {
  simpleTargets: { fieldId: string; value: string }[];
}

/** The subset of a backend FieldAnswer the planner needs (see AiFillAnswer). */
export interface PlannedAnswer {
  id: string;
  answer: string;
  /** Backend's review verdict — retained for parity with the backend answer
   *  shape (and the answer cache); no longer consumed (every answer fills). */
  needsReview?: boolean;
  /** "memory" | "ai" | "rule" | "profile" — backend provenance (unused now). */
  source?: string;
  category?: string;
}

/**
 * Turn backend answers into inline (silent) fills: every non-empty answer for a
 * candidate field becomes a simple target. There is no review gate — the
 * backend's `needsReview` verdict is ignored (an AI answer fills like any other).
 */
export function planAiFill(
  candidates: DetectedField[],
  answers: PlannedAnswer[]
): AiFillPlan {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const simpleTargets: { fieldId: string; value: string }[] = [];
  for (const f of candidates) {
    const a = byId.get(f.id);
    if (!a || !a.answer || !a.answer.trim()) continue;
    simpleTargets.push({ fieldId: f.id, value: a.answer });
  }
  return { simpleTargets };
}

/** Count distinct filled fields across passes; later groups win for the same id. */
export function tallyOutcomes(
  ...groups: { fieldId: string; ok: boolean }[][]
): { ok: number; fail: number; total: number } {
  const status = new Map<string, boolean>();
  for (const group of groups) for (const o of group) status.set(o.fieldId, o.ok);
  const ok = [...status.values()].filter(Boolean).length;
  return { ok, fail: status.size - ok, total: status.size };
}

/** Profile-lookup categories answered locally when confident — instant, offline, free. */
export const LOCAL_FAST_PATH: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "firstName", "lastName", "fullName", "email", "phone",
  "linkedin", "github", "portfolio", "location", "currentCompany", "currentTitle",
]);

export interface FillRoute {
  /** Deterministic fields to fill immediately from proposedValue. */
  localTargets: { fieldId: string; value: string }[];
  /** Judgment fields to route to the backend (proposedValue is the fallback). */
  backendFields: DetectedField[];
}

/**
 * Split the user-selected (already `fillable` + `proposedValue!=null`) fields into
 * the deterministic local fast-path vs the backend-primary judgment fields. EEO/
 * sensitive fields are never AI-eligible, so they stay local (never transmitted).
 */
export function planFillRoute(selected: DetectedField[], threshold: number): FillRoute {
  const localTargets: { fieldId: string; value: string }[] = [];
  const backendFields: DetectedField[] = [];
  for (const f of selected) {
    const deterministic =
      LOCAL_FAST_PATH.has(f.category) && f.confidence >= threshold && f.proposedValue !== null;
    if (deterministic) {
      localTargets.push({ fieldId: f.id, value: f.proposedValue as string });
    } else if (isAiCandidate(f)) {
      backendFields.push(f);
    } else if (f.proposedValue !== null) {
      localTargets.push({ fieldId: f.id, value: f.proposedValue });
    }
  }
  return { localTargets, backendFields };
}

/** A choice control whose fill missed, plus the REAL options harvested from
 *  the live widget — input to the one-shot re-ask round. */
export interface ReaskCandidate {
  fieldId: string;
  options: string[];
}

/**
 * Build the backend fields for the re-ask round: same question, but now
 * carrying the widget's actual options so the backend snaps the answer to one
 * of them ("Canada" → "Canadian"). Sensitive fields never reach the backend.
 */
export function planReaskFields(
  fields: DetectedField[],
  candidates: ReaskCandidate[]
): AiFillField[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: AiFillField[] = [];
  for (const c of candidates) {
    const f = byId.get(c.fieldId);
    if (!f || f.sensitive || c.options.length === 0) continue;
    out.push({
      id: c.fieldId,
      label: f.label,
      type: "select",
      options: c.options.slice(0, 60),
      required: f.required,
    });
  }
  return out;
}
