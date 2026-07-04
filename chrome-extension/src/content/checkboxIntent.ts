// chrome-extension/src/content/checkboxIntent.ts
/**
 * Intent resolution for a *single* checkbox (native `checkbox`, not a
 * "select all that apply" group). A single checkbox is a boolean control, so it
 * must never be fed a text value: production telemetry showed boxes like
 * "I have a preferred name" (misclassified firstName → the person's name) and
 * "Hear more about career opportunities" (misclassified email → an address)
 * reaching the writer and failing as "Ambiguous checkbox value".
 *
 * Policy (mirrors Jobright's completion behavior, conservatively):
 *   - application consent / agreement / attestation → check it ("yes")
 *   - marketing / notification opt-in               → leave unchecked (null)
 *   - a genuine yes/no answer already resolved       → keep it verbatim
 *   - anything else (misclassified text, unknown)    → skip (null), never fail
 *
 * Returning null means "no proposed value", so the field is simply not selected
 * for autofill (see shared/selection.isDefaultSelected) — skipped, not failed.
 */

/** Opt-ins we must NOT enable on the user's behalf. Checked first so an
 *  "I agree to receive marketing emails" reads as marketing, not consent. */
const MARKETING_RE =
  /\b(marketing|newsletter|subscribe|promotional|opt[\s-]?in|hear (?:more|about)|updates? (?:about|on|regarding)|receive (?:news|emails|updates|communications|information)|notif(?:y|ication)|mailing list|stay (?:in touch|informed))\b/i;

/** Application-completion agreements we DO enable (the user launched autofill to
 *  apply). Deliberately narrow: explicit first-person agreement or a named legal
 *  document — never a bare "yes/no" question. */
const CONSENT_RE =
  /\bi (?:agree|consent|accept|acknowledge|certify|confirm|authoriz(?:e|ed)|declare)\b|\b(?:agree|consent) to\b|\bterms (?:and|&) conditions\b|\bprivacy (?:policy|notice|statement)\b|\bdata (?:processing|protection|privacy)\b|\bgdpr\b|\bi have read\b/i;

/** True when a string already expresses a clear boolean the writer accepts. */
function looksBoolean(v: string): boolean {
  return /^(yes|y|true|1|agree|checked|no|n|false|0|unchecked)$/i.test(v.trim());
}

/**
 * @param labelText  the checkbox's display label plus any nearby help text
 * @param rawValue   the value the generic category resolver proposed (may be a
 *                   misclassified text value, a genuine yes/no, or null)
 */
export function resolveCheckboxIntent(labelText: string, rawValue: string | null): string | null {
  const text = labelText ?? "";
  if (MARKETING_RE.test(text)) return null;
  if (CONSENT_RE.test(text)) return "yes";
  if (rawValue !== null && looksBoolean(rawValue)) return rawValue;
  return null;
}
