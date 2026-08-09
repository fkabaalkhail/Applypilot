/**
 * Pause-condition probes for the multi-page flow. Each is a cheap, read-only
 * DOM check the controller polls while paused — every reason auto-resumes the
 * moment its condition clears (the user solved the captcha, fixed the error,
 * attached the file…).
 */
import { cleanText, deepQueryAll, isVisible } from "./domUtils";
import type { DetectedField } from "../shared/types";
import type { RuntimeControl } from "./formScanner";

const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, [data-sitekey]';

/** A visible captcha widget whose response token is still empty. */
export function hasUnsolvedCaptcha(doc: Document): boolean {
  const widgets = deepQueryAll(doc, CAPTCHA_SELECTOR).filter((el) => isVisible(el));
  if (widgets.length === 0) return false;
  const tokens = deepQueryAll(
    doc,
    'textarea[name="g-recaptcha-response"], [name="h-captcha-response"]'
  ) as (HTMLTextAreaElement | HTMLInputElement)[];
  return !tokens.some((t) => Boolean(t.value));
}

/** Populated alert texts inside the scope (the page is telling the user off). */
export function validationMessages(scope: HTMLElement): string[] {
  const msgs: string[] = [];
  for (const el of deepQueryAll(scope, '[role="alert"], [aria-live="assertive"]')) {
    const t = cleanText(el.textContent);
    if (t) msgs.push(t);
  }
  return msgs.slice(0, 5);
}

/** Visible aria-invalid fields. Only meaningful AFTER a rejected advance click —
 *  many ATS pre-mark untouched required fields invalid on load. */
export function invalidFieldCount(scope: HTMLElement): number {
  return deepQueryAll(scope, '[aria-invalid="true"]').filter((el) => isVisible(el)).length;
}

function firstEmptyResumeField(
  fields: DetectedField[],
  getControl: (id: string) => RuntimeControl | undefined,
  requiredOnly: boolean
): DetectedField | null {
  for (const f of fields) {
    if (f.category !== "resumeUpload" || f.controlType !== "file") continue;
    if (requiredOnly && !f.required) continue;
    const el = getControl(f.id)?.el as HTMLInputElement | undefined;
    if (el && (el.files?.length ?? 0) === 0) return f;
  }
  return null;
}

/**
 * The résumé file field to ATTACH to — empty, required or not.
 *
 * Attaching and blocking are different questions and must not share a
 * predicate. Workday's drop zone carries no `required` attribute, no
 * `aria-required` and no trailing "*", so gating attach on `required` meant
 * every entry point read null and the résumé was silently never attached —
 * which is the whole defect this helper exists to close.
 */
export function resumeFieldForAttach(
  fields: DetectedField[],
  getControl: (id: string) => RuntimeControl | undefined
): DetectedField | null {
  return firstEmptyResumeField(fields, getControl, false);
}

/**
 * The REQUIRED résumé file field that still has no file, if any — the only kind
 * that may PARK the flow.
 *
 * Deliberately narrower than `resumeFieldForAttach`: pausing on any empty
 * upload would leave a user with no résumé on file stuck behind "attach your
 * résumé to continue" on every optional file input on every ATS, with nothing
 * they can do to clear it. An optional upload attaches silently and, failing
 * that, is simply skipped.
 */
export function resumeFieldNeedingFile(
  fields: DetectedField[],
  getControl: (id: string) => RuntimeControl | undefined
): DetectedField | null {
  return firstEmptyResumeField(fields, getControl, true);
}

const VERIFICATION_RE =
  /verification code|verify your email|enter the code|check your (email|inbox)|code de v[ée]rification|v[ée]rifiez votre (courriel|adresse)/i;

/** An email-verification / OTP wall — always human-only, the flow pauses. */
export function isVerificationWall(scope: HTMLElement): boolean {
  return VERIFICATION_RE.test(cleanText(scope.textContent).slice(0, 4000));
}
