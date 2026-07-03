/**
 * Submit tracking — Jobright `bindSubmitButton` / `saveSubmitStatus` parity.
 *
 * The autofill flow deliberately stops at the terminal (submit) button and hands
 * control back to the user; FlowController NEVER clicks it. When the user then
 * clicks that button themselves, that is the application submission. We bind a
 * one-shot listener to record the application — never to submit it.
 *
 * Two ATS shapes are handled:
 *  - SPA / AJAX submit (Greenhouse, Lever, Ashby, Workday): the page stays,
 *    shows an in-page confirmation. We wait briefly and record if no blocking
 *    validation appeared.
 *  - Full-navigation POST (older ATS): the page unloads. We record on `pagehide`
 *    right away (a navigation after a submit click means the submit went
 *    through), before this content script is torn down.
 *
 * Guarded against false positives: a disabled button, an HTML5-invalid form, or
 * a blocking validation message after the click all skip recording, so the user
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
  /** How long to wait after the click before deciding (SPA path). Default 1200ms. */
  delayMs?: number;
}

export function bindSubmitTracking(
  button: HTMLElement,
  onSubmitted: () => void,
  options: SubmitTrackerOptions = {}
): SubmitTrackerHandle {
  const delayMs = options.delayMs ?? 1200;
  const form = button.closest("form");
  let fired = false;
  let disposed = false;
  let armed = false; // a submit click is pending confirmation

  const cleanup = (): void => {
    disposed = true;
    button.removeEventListener("click", onActivate, true);
    form?.removeEventListener("submit", onActivate, true);
    window.removeEventListener("pagehide", onPageHide, true);
  };

  const record = (): void => {
    if (fired || disposed) return;
    fired = true;
    cleanup();
    onSubmitted();
  };

  // Navigation after a submit click = a full-page POST that went through.
  // Record now, before the content script dies with the old document.
  function onPageHide(): void {
    if (armed) record();
  }

  function onActivate(): void {
    if (fired || disposed || armed) return;
    // A disabled button can still receive a click event but won't submit.
    if (button instanceof HTMLButtonElement && button.disabled) return;
    // Cheap synchronous reject: an HTML5-invalid form will not submit.
    if (form && typeof form.checkValidity === "function" && !form.checkValidity()) return;

    armed = true;
    window.addEventListener("pagehide", onPageHide, true);
    setTimeout(() => {
      if (fired || disposed) return;
      // Submit rejected by (custom) validation — not an application.
      if (options.hasBlockingValidation?.()) {
        armed = false;
        window.removeEventListener("pagehide", onPageHide, true);
        return;
      }
      record();
    }, delayMs);
  }

  button.addEventListener("click", onActivate, true);
  form?.addEventListener("submit", onActivate, true);
  return { dispose: cleanup };
}
