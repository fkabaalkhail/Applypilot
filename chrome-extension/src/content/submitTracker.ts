/**
 * Submit tracking — Jobright `bindSubmitButton` / `saveSubmitStatus` parity.
 *
 * The autofill flow deliberately stops at the terminal (submit) button and hands
 * control back to the user; FlowController NEVER clicks it. When the user then
 * clicks that button themselves, that is the application submission. We bind a
 * one-shot listener to record the application — never to submit it.
 *
 * Guarded against false positives: after the click we wait briefly and only
 * record if the submission looks like it proceeded (no new blocking validation
 * appeared). A rejected submit (validation error) is not recorded, so the user
 * gets no phantom application entries.
 *
 * Pure DOM + timers, no chrome.* — unit-testable with jsdom + fake timers.
 */

export interface SubmitTrackerHandle {
  dispose(): void;
}

export interface SubmitTrackerOptions {
  /** True when the page currently shows a blocking validation error — a submit
   *  that leaves such an error on screen did not go through, so we skip it. */
  hasBlockingValidation?: () => boolean;
  /** How long to wait after the click before deciding (default 1200ms). */
  delayMs?: number;
}

/**
 * Watch `button` (and its enclosing <form>) for a user submit. Calls
 * `onSubmitted` at most once, after `delayMs`, unless blocking validation is
 * showing. Returns a handle to detach the listeners.
 */
export function bindSubmitTracking(
  button: HTMLElement,
  onSubmitted: () => void,
  options: SubmitTrackerOptions = {}
): SubmitTrackerHandle {
  const delayMs = options.delayMs ?? 1200;
  const form = button.closest("form");
  let fired = false;
  let disposed = false;

  const cleanup = (): void => {
    disposed = true;
    button.removeEventListener("click", onActivate, true);
    form?.removeEventListener("submit", onActivate, true);
  };

  function onActivate(): void {
    if (fired || disposed) return;
    // A disabled button can still receive a click event but won't submit.
    if (button instanceof HTMLButtonElement && button.disabled) return;
    setTimeout(() => {
      if (fired || disposed) return;
      // Submit rejected by validation — not an application.
      if (options.hasBlockingValidation?.()) return;
      fired = true;
      cleanup();
      onSubmitted();
    }, delayMs);
  }

  button.addEventListener("click", onActivate, true);
  form?.addEventListener("submit", onActivate, true);
  return { dispose: cleanup };
}
