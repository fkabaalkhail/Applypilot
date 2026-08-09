/**
 * Advance-button discovery for multi-page flows. The search is confined to the
 * form scope so a nav link can never be clicked. Terminal (submit-like)
 * buttons are detected but NEVER clicked — the flow stops for user review.
 */
import { cleanText, deepQueryAll, isVisible } from "./domUtils";
import { activateElement } from "./comboboxEngine";
import type { SiteAdapter } from "./adapters/types";

export type AdvanceKind = "advance" | "terminal";

export interface AdvanceButton {
  el: HTMLElement;
  kind: AdvanceKind;
}

const ADVANCE_RE =
  /\b(next( step)?|continue|save (and|&) continue|proceed|review|suivant|continuer|poursuivre|réviser)\b/i;
/** Verbs that send the application. Reaching one always ends the flow. */
const FINAL_SUBMIT_RE =
  /\b(submit|send application|complete application|finish|soumettre|envoyer|terminer)\b/i;
/** Entry verbs — the job posting's own "Apply". Terminal on their own, but they
 *  do not send an application, so they never disqualify a wall's advance. */
const APPLY_ENTRY_RE = /\b(apply now|apply|postuler)\b/i;
// Composed, not re-listed: the wall carve-out below keys off FINAL_SUBMIT_RE, so
// a terminal verb added to one flat list would silently escape it. Filing every
// verb under exactly one of the two makes that impossible.
const TERMINAL_RE = new RegExp(`${FINAL_SUBMIT_RE.source}|${APPLY_ENTRY_RE.source}`, "i");

const BUTTON_SELECTOR = 'button, input[type="submit"], [role="button"]';

export interface FindAdvanceOpts {
  /** Extra advance verbs (account walls: create account / sign in / …). */
  extraAdvance?: RegExp;
}

export function findAdvanceButton(
  scope: HTMLElement,
  adapter: SiteAdapter | null,
  opts: FindAdvanceOpts = {}
): AdvanceButton | null {
  const fromAdapter = adapter?.advanceButton?.(scope);
  if (fromAdapter && isClickable(fromAdapter)) {
    // Workday reuses one automation-id for Next AND the final Submit — the
    // terminal check must still gate adapter-supplied buttons. A hidden/disabled
    // adapter button falls through to the generic text search below.
    return { el: fromAdapter, kind: TERMINAL_RE.test(buttonText(fromAdapter)) ? "terminal" : "advance" };
  }
  let advance: HTMLElement | null = null;
  let terminal: HTMLElement | null = null;
  for (const el of deepQueryAll(scope, BUTTON_SELECTOR)) {
    if (!isClickable(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    // A wall's own verb wins outright. `extraAdvance` is set ONLY while an
    // account wall is on the page, and there the posting's "Apply" button —
    // still in the DOM behind the gate — matches TERMINAL_RE and ends the flow
    // on a page the user has not passed yet.
    //
    // FINAL_SUBMIT_RE is the guard, and it is load-bearing. Both regexes are
    // \b-anchored alternations, so ONE button can carry a wall verb AND a
    // submit verb — "Register and Submit" on a one-page form with an inline
    // password field.
    //
    // What the guard buys is the KIND, and the kind decides what happens to the
    // button. "terminal" ends the flow at "Ready to review and submit" and is
    // handed to onTerminal for submit tracking; "advance" is a page turn, so
    // the flow parks and the panel offers that very button behind a gate
    // labelled from the wall verb ("Create Account ▶"). Without the guard, the
    // one press the user is invited to make sends the application unreviewed,
    // with no submit beat and nothing tracked. (The click itself is always the
    // user's — flowController waits on waitForAdvanceRequest before every
    // advance click, walls included; the danger here is the label, not an
    // automatic click.) `apply` is deliberately NOT a disqualifier: it is the
    // entry verb this carve-out exists to beat, and a wall's "Sign in to apply"
    // must stay an advance.
    if (opts.extraAdvance?.test(text) && !FINAL_SUBMIT_RE.test(text)) return { el, kind: "advance" };
    if (!terminal && TERMINAL_RE.test(text)) terminal = el;
    if (!advance && ADVANCE_RE.test(text)) advance = el;
  }
  if (terminal) return { el: terminal, kind: "terminal" }; // terminal wins over a plain Next
  return advance ? { el: advance, kind: "advance" } : null;
}

/** Click an advance button the way a user would (pointer + mouse + click). */
export function clickAdvance(el: HTMLElement): void {
  el.scrollIntoView?.({ block: "center" });
  activateElement(el);
}

function buttonText(el: HTMLElement): string {
  return (
    cleanText(el.getAttribute("aria-label")) ||
    cleanText(el.textContent) ||
    cleanText((el as HTMLInputElement).value ?? "")
  );
}

function isClickable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return isVisible(el);
}
