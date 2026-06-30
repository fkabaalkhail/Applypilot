/**
 * Decides what the AI fill pass does with each field: which fields are eligible,
 * which are long-form (drafted for review) vs simple (filled inline), how to map
 * them to the backend's field shape, and how to tally outcomes across passes.
 *
 * Pure functions only — no DOM, no network — so the orchestration in
 * contentScript stays thin and this logic is fully unit-tested.
 */
import type { AiDraft, AiFillField, DetectedField } from "../shared/types";

/** Labels that signal a free-text answer we should draft rather than guess inline. */
const LONGFORM_LABEL =
  /\b(why|describe|tell us|tell me|explain|cover letter|in your own words|what makes you|motivat\w*)\b/i;

/** Labels that read like a question worth answering even on a plain text input. */
const QUESTION_LABEL =
  /\?|\b(why|describe|tell us|explain|how many|years of|experience with|are you|do you|have you|salary|expected|notice period|available|authorized|sponsor|willing)\b/i;

export function isLongform(field: DetectedField): boolean {
  if (field.controlType === "textarea" || field.controlType === "contenteditable") return true;
  return LONGFORM_LABEL.test(field.label);
}

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
  drafts: AiDraft[];
}

/** The subset of a backend FieldAnswer the planner needs (see AiFillAnswer). */
export interface PlannedAnswer {
  id: string;
  answer: string;
  /** Backend's verdict: AI suggestions + company-specific matches need review. */
  needsReview?: boolean;
  /** "memory" | "ai" | "rule" | "profile" — drives the review-card badge. */
  source?: string;
  category?: string;
}

/**
 * Split backend answers into inline (silent) fills and review drafts.
 *
 * The backend decides what needs review: rule/profile answers and generic memory
 * matches fill silently; AI suggestions and company-specific memory matches are
 * drafted for Accept/Edit/Skip — regardless of field length.
 */
export function planAiFill(
  candidates: DetectedField[],
  answers: PlannedAnswer[]
): AiFillPlan {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const simpleTargets: { fieldId: string; value: string }[] = [];
  const drafts: AiDraft[] = [];
  for (const f of candidates) {
    const a = byId.get(f.id);
    if (!a || !a.answer || !a.answer.trim()) continue;
    if (a.needsReview) {
      drafts.push({
        fieldId: f.id,
        label: f.label,
        value: a.answer,
        source: a.source,
        category: a.category,
      });
    } else {
      simpleTargets.push({ fieldId: f.id, value: a.answer });
    }
  }
  return { simpleTargets, drafts };
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
