/**
 * The 0-based repeating-row index encoded in a field's name/id, or null.
 * Recognizes the common ATS shapes: `education[1][school]`, `emp_2_title`,
 * `job.0.company`, `edu-3-degree`. Returns the FIRST index found (the outermost
 * repeating group), preferring `name` over `id`. Indices >= 50 are treated as
 * spurious (not a real repeating row) and yield null.
 */
import type { FieldSignals } from "./domUtils";

const MAX_INDEX = 50;

function firstIndex(s: string): number | null {
  if (!s) return null;
  // `[N]` first (most specific), then `.N.` / `_N_` / `-N-` delimited.
  const bracket = s.match(/\[(\d{1,3})\]/);
  const delimited = s.match(/[._-](\d{1,3})(?=[._-])/);
  const raw = bracket?.[1] ?? delimited?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n < MAX_INDEX ? n : null;
}

export function detectGroupIndex(signals: FieldSignals): number | null {
  return firstIndex(signals.nameAttr) ?? firstIndex(signals.idAttr);
}
