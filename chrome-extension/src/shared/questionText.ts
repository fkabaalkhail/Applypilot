// chrome-extension/src/shared/questionText.ts
/**
 * What counts as a QUESTION — as opposed to a widget's own boilerplate or an
 * opaque machine id.
 *
 * A field's label is not just what the panel prints. It is the key an answer is
 * remembered under (Question Memory recalls semantically by that text), so a
 * label that names no question is worse than none at all: it banks an answer
 * under a key no future question can match, and offers it up for recall against
 * questions it has nothing to do with.
 *
 * Production, 2026-08-09, `bmo.wd3.myworkdayjobs.com` — three answers banked
 * under keys that are not questions:
 *
 *   saved_answers #38  "Select One Required"  → "Yes"
 *   saved_answers #39  "Yes Required"         → "Yes"
 *   saved_answers #40  "b0531cc2ff371001d8a97c876e680000-b0531cc2…" → "Person of Mixed Origin"
 *
 * Shared (not in domUtils) so the pure, DOM-free answer-gap layer can apply the
 * same test without pulling the DOM helpers in.
 */

/** What `bestDisplayLabel` returns when no signal names the field. */
export const UNLABELED_FIELD = "Unlabeled field";

/**
 * An opaque machine identifier — Workday's `<32 hex>-<32 hex>` widget id, a
 * UUID, or a bare hex blob. Deliberately narrow: it must reject
 * `56370316e58a1001d8aa4cd7b1d70000-b0531cc2ff371001d8a9b9c2eef00002` while
 * keeping ordinary attribute names like `candidate_country`, which are poor
 * labels but still say what the field is. Anything with whitespace is prose and
 * is never an id.
 */
const HEX_BLOB = /^[0-9a-f]{12,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMachineId(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (UUID.test(t)) return true;
  // Every dash/underscore-separated part is a long hex run ⇒ an id, not a name.
  const parts = t.split(/[-_:.]/);
  return parts.length > 0 && parts.every((p) => HEX_BLOB.test(p));
}

/**
 * Does this text name a question we can honestly remember an answer under?
 *
 * False for the unlabeled sentinel and for machine ids. Not a quality judgement
 * on the wording — a terse "Ethnicity" is a fine key; a widget id is not.
 */
export function isNamedQuestion(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t !== UNLABELED_FIELD && !isMachineId(t);
}
