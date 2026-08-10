// chrome-extension/src/shared/questionText.ts
/**
 * What counts as a NAME for a field, as opposed to an opaque machine id.
 *
 * A field's label is what the panel prints, what the gap modal asks the user,
 * and what the backend fill pipeline reads as the question. Workday in
 * particular will hand out `b0531cc2ff371001d8a97c876e680000-b0531cc2…` as the
 * only "label" a field has; showing that to a user, or sending it as a
 * question, is worse than admitting we could not name the field.
 *
 * Shared (not in domUtils) so a pure, DOM-free layer can apply the same test
 * without pulling the DOM helpers in.
 */

/** What `bestDisplayLabel` returns when no signal names the field. */
export const UNLABELED_FIELD = "Unlabeled field";

/**
 * An opaque machine identifier: Workday's `<32 hex>-<32 hex>` widget id, a
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
