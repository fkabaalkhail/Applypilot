/**
 * Apply-entry discovery: the button/link on a job POSTING (or an apply-method
 * chooser) that leads INTO the application, "Apply", "Apply Manually",
 * "Continue Application". The flow clicks these to enter multi-page ATSs
 * (Workday: job page → Apply → Apply Manually → sign-in/create-account → form).
 *
 * Deliberately separate from advance.ts: advance buttons live INSIDE a detected
 * form scope; entry buttons only matter when the page has NO recognized fields
 * yet, so the two can never fight. On a filled form, "Apply"/"Submit" is a
 * terminal button (advance.ts) and is never clicked.
 *
 * Tier order mirrors the Jobright reference: an explicit "Apply Manually"
 * always beats "Autofill with Resume" / "Use My Last Application" on Workday's
 * chooser, our filler drives the manual form.
 */
import { cleanText, deepQueryAll, isVisible } from "./domUtils";
import type { SiteAdapter } from "./adapters/types";

export interface EntryButton {
  el: HTMLElement;
  label: string;
  /** True when a site adapter supplied it (known ATS, safe to auto-surface). */
  fromAdapter: boolean;
}

const ENTRY_SELECTOR = 'a[href], button, [role="button"], input[type="submit"], input[type="button"]';

/** Chooser option we always prefer (Workday's manual-application path). */
const ENTRY_MANUAL_RE = /^(apply manually|postuler manuellement)$/i;
/** The posting's own Apply button. Anchored, never a sentence containing "apply". */
const ENTRY_APPLY_RE =
  /^(apply( now)?!?|apply (for|to) (this )?(job|position|role|opening)|easy apply|postuler( maintenant)?)$/i;
/** Resume-an-application verbs (Workday shows these when a draft exists). */
const ENTRY_CONTINUE_RE = /^(continue application|continue your application|start( your)? application)$/i;
/** Chooser options that bypass the manual form, never click these. */
const ENTRY_EXCLUDE_RE = /autofill with resume|use my last application|apply with (linkedin|indeed|seek)/i;

function isClickable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return isVisible(el);
}

function entryText(el: HTMLElement): string {
  return (
    cleanText(el.getAttribute("aria-label")) ||
    cleanText(el.textContent) ||
    cleanText((el as HTMLInputElement).value ?? "")
  );
}

/**
 * The best apply-entry control on the page, or null.
 *
 * "Apply Manually" is checked FIRST (ahead of even the adapter hook) because
 * Workday's chooser opens as an in-page overlay: the URL never changes and the
 * posting's own `adventureButton` ("Apply") stays in the DOM, visible, behind
 * it. An adapter-first order therefore keeps answering "Apply" forever, which
 * (a) re-clicks the button that opened the chooser instead of picking a path
 * and (b) leaves stepSignature() identical across the transition, so the flow
 * concludes the page never changed and gives up. The manual path is also simply
 * the right answer whenever it is on screen, our filler drives that form.
 *
 * After that the adapter hook wins (reliable automation-ids), then the generic
 * tiers, which match anchored button text so body copy like "apply by June 1"
 * can never produce a click target.
 */
export function findApplyEntry(doc: Document, adapter: SiteAdapter | null): EntryButton | null {
  let apply: HTMLElement | null = null;
  let cont: HTMLElement | null = null;
  for (const el of deepQueryAll(doc, ENTRY_SELECTOR)) {
    if (!isClickable(el)) continue;
    const text = entryText(el);
    if (!text || text.length > 40 || ENTRY_EXCLUDE_RE.test(text)) continue;
    if (ENTRY_MANUAL_RE.test(text)) return { el, label: text, fromAdapter: false }; // best, stop
    if (!apply && ENTRY_APPLY_RE.test(text)) apply = el;
    if (!cont && ENTRY_CONTINUE_RE.test(text)) cont = el;
  }
  try {
    const fromAdapter = adapter?.entryButton?.(doc);
    if (fromAdapter && isClickable(fromAdapter)) {
      return { el: fromAdapter, label: entryText(fromAdapter) || "Apply", fromAdapter: true };
    }
  } catch {
    // Adapter hooks refine, never break, fall through to the generic tiers.
  }
  const el = apply ?? cont;
  return el ? { el, label: entryText(el), fromAdapter: false } : null;
}
