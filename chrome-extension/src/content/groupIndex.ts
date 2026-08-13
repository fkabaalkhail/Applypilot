/**
 * The 0-based repeating-row index encoded in a field's name/id, or null.
 * Recognizes the common ATS shapes: `education[1][school]`, `emp_2_title`,
 * `job.0.company`, `edu-3-degree`. Returns the bracketed `[N]` index if present,
 * otherwise the first `[._-]N[._-]` delimited index; prefers the `name`
 * attribute over `id`. Indices >= 50 are treated as spurious and yield null.
 */
import type { FieldSignals } from "./domUtils";

const MAX_INDEX = 50;

function firstIndex(s: string): number | null {
  if (!s) return null;
  // `[N]` first (most specific), then `.N.` / `_N_` / `-N-` delimited.
  const bracket = s.match(/\[(\d{1,3})\]/);
  const delimited = s.match(/[._-](\d{1,3})(?=[._-])/);
  // Greenhouse ends the id with the row index and nothing after it
  // ("company-name-0", "start-date-month-1", "school--0"), so a trailing index
  // needs its own anchored match: the `(?=[._-])` lookahead above can never
  // fire at end-of-string, and every such field read as groupIndex null
  // (noticed on the real Lyft form, autofill_reports #167, 2026-08-12).
  //
  // Row 0 mostly survived that by accident, since the resolvers fall back to
  // the first profile row. The rows that did NOT survive are 1 and up: a second
  // job's dates and employer all silently resolved from the FIRST job.
  //
  // Still bounded to 3 digits AND preceded by a delimiter, so an id whose tail
  // is one long opaque number ("question_37728581002") is not read as a row:
  // its last three digits are preceded by a digit, not by `[._-]`.
  const trailing = s.match(/[._-](\d{1,3})$/);
  const raw = bracket?.[1] ?? delimited?.[1] ?? trailing?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n < MAX_INDEX ? n : null;
}

export function detectGroupIndex(signals: FieldSignals): number | null {
  return firstIndex(signals.nameAttr) ?? firstIndex(signals.idAttr);
}
