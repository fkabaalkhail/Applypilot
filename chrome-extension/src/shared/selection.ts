/**
 * Default autofill selection rules, shared by the popup and the in-page overlay.
 *
 * A field is pre-selected for autofill only when it is safe and useful to fill:
 * we can write it, we have a value, it is not a sensitive (EEO) field, the
 * category match is confident enough, and the control is still empty (so we
 * never silently overwrite something the user already typed).
 */
import { AUTOFILL_CONFIDENCE_THRESHOLD } from "./constants";
import type { DetectedField } from "./types";

export function isDefaultSelected(field: DetectedField): boolean {
  return (
    field.fillable &&
    field.proposedValue !== null &&
    !field.sensitive &&
    field.confidence >= AUTOFILL_CONFIDENCE_THRESHOLD &&
    !field.currentValue
  );
}

export function defaultSelectedIds(fields: DetectedField[]): Set<string> {
  return new Set(fields.filter(isDefaultSelected).map((f) => f.id));
}
