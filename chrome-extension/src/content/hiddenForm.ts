/**
 * A form opened by an entry click ("Apply for This Job") can sit fully mounted
 * inside a display:none container while the site finishes loading. No node is
 * added at the reveal, so the DOM-quiet wait passes at once and a scan right
 * after the click sees every control hidden: nothing to fill, and the flow
 * parked on an empty page. BambooHR holds its form hidden 2.5-5 s after the
 * click (live 2026-10-03). These helpers recognise that state and wait it out,
 * bounded.
 */
import { deepQueryAll, isVisible } from "./domUtils";

/** Inputs a user types into. Checkboxes, radios, file inputs and buttons are
 *  hidden by design (custom-styled) on too many sites to say anything. */
const TEXTLIKE = /^(?:|text|email|tel|url|number|search|date|password|month|week|time|datetime-local)$/i;

export interface ControlVisibility {
  shown: number;
  hidden: number;
}

/** The page's typeable controls (inputs, textareas, selects), rendered or not. */
export function controlVisibility(root: ParentNode = document): ControlVisibility {
  let shown = 0;
  let hidden = 0;
  for (const el of deepQueryAll(root, "input, textarea, select")) {
    if (el instanceof HTMLInputElement && !TEXTLIKE.test((el.getAttribute("type") ?? "").trim())) continue;
    if (isVisible(el)) shown++;
    else hidden++;
  }
  return { shown, hidden };
}

/** Most of the page's controls are mounted but not rendered. */
export function formLooksHidden(v: ControlVisibility): boolean {
  return v.hidden >= 3 && v.hidden > v.shown;
}

export interface RevealDeps {
  measure: () => ControlVisibility;
  /** Settle and rescan; true once the scan has something to fill. */
  rescan: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * While the page's form looks hidden, poll until more controls render, then
 * rescan; stop once a rescan has work, or after `capMs`. Returns at once (false)
 * when the form does not look hidden, so a page that is simply done costs
 * nothing. Returns whether a rescan found work.
 */
export async function waitForFormReveal(
  deps: RevealDeps,
  signal?: AbortSignal,
  capMs = 10000,
  pollMs = 300
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let last = deps.measure();
  if (!formLooksHidden(last)) return false;
  const deadline = now() + capMs;
  while (now() < deadline && !signal?.aborted) {
    await sleep(pollMs);
    if (signal?.aborted) break;
    const v = deps.measure();
    if (v.shown <= last.shown) continue;
    last = v;
    if (await deps.rescan()) return true;
  }
  return false;
}
