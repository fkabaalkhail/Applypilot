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
const TERMINAL_RE =
  /\b(submit|send application|apply now|apply|finish|complete application|soumettre|envoyer|postuler|terminer)\b/i;

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
    // on a page the user has not passed yet. A create-account submit is never
    // the application's final submit, so this cannot submit an application.
    if (opts.extraAdvance?.test(text)) return { el, kind: "advance" };
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
