/**
 * MAIN-world blocking-dialog suppressor (Jobright `installMainWorldAlertSuppressor`
 * parity). Runs in the PAGE's JS world so it can neutralize dialogs the page's own
 * code triggers, which the isolated content script cannot reach.
 *
 * While an autofill/flow is active it suppresses ONLY the two dialogs that stall
 * the filler, and restores them the instant the fill ends:
 *   - window.alert(): a blocking, information-only modal — made a no-op.
 *   - beforeunload "leave site?": prevented, so multi-page auto-advance
 *     navigations don't hang on a native prompt.
 *
 * It deliberately NEVER touches confirm()/prompt() — those return values we must
 * not guess on the user's behalf. A safety timer auto-restores everything in case
 * the toggle-off is ever missed (e.g. the page navigates away mid-flow).
 */
import { MW_SUPPRESS_EVENT, type MwSuppressDetail } from "./mainWorldBridge";

const SAFETY_MS = 90_000;

export function installDialogSuppressor(win: Window & typeof globalThis): void {
  const w = win as unknown as Record<string, unknown>;
  if (w.__tailrdMWSuppressInstalled) return;
  w.__tailrdMWSuppressInstalled = true;

  const originalAlert = win.alert;
  let active = false;
  let savedOnBeforeUnload: unknown = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  const onBeforeUnload = (e: Event): void => {
    if (!active) return;
    // The page's own handlers register at load, before we inject at fill time, so
    // we run AFTER them and clear whatever they set — the browser shows no
    // "leave site?" prompt when returnValue is empty. We deliberately do NOT call
    // preventDefault (that itself triggers the dialog in some engines). Combined
    // with nulling the onbeforeunload property below, this covers the common
    // cases; a page that calls preventDefault() in a pre-registered listener is
    // the one case this can't fully suppress.
    try {
      (e as unknown as { returnValue: unknown }).returnValue = "";
    } catch {
      /* returnValue read-only in some engines — the nulled property still helps */
    }
  };

  const armSafety = (): void => {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => setActive(false), SAFETY_MS);
  };

  function setActive(on: boolean): void {
    if (on === active) {
      if (on) armSafety(); // extend the safety window on a repeat "on"
      return;
    }
    active = on;
    if (on) {
      win.alert = () => {};
      savedOnBeforeUnload = (win as unknown as { onbeforeunload: unknown }).onbeforeunload;
      (win as unknown as { onbeforeunload: unknown }).onbeforeunload = null;
      win.addEventListener("beforeunload", onBeforeUnload, false);
      armSafety();
    } else {
      win.alert = originalAlert;
      (win as unknown as { onbeforeunload: unknown }).onbeforeunload = savedOnBeforeUnload;
      win.removeEventListener("beforeunload", onBeforeUnload, false);
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    }
  }

  const onSuppressEvent = (e: Event): void => {
    const d = (e as CustomEvent<MwSuppressDetail>).detail;
    if (d && typeof d.on === "boolean") setActive(d.on);
  };
  win.addEventListener(MW_SUPPRESS_EVENT, onSuppressEvent);

  // Full teardown (restores everything + removes listeners); used by tests.
  w.__tailrdMWSuppressTeardown = (): void => {
    setActive(false);
    win.removeEventListener(MW_SUPPRESS_EVENT, onSuppressEvent);
    delete w.__tailrdMWSuppressInstalled;
    delete w.__tailrdMWSuppressTeardown;
  };
}

// Exported for tests only.
export const __test = {
  uninstall(win: Window & typeof globalThis): void {
    const w = win as unknown as Record<string, unknown>;
    (w.__tailrdMWSuppressTeardown as (() => void) | undefined)?.();
  },
};
