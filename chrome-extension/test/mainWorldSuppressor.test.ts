import { afterEach, describe, expect, it, vi } from "vitest";
import { installDialogSuppressor, __test } from "../src/content/mainWorldSuppressor";
import { MW_SUPPRESS_EVENT } from "../src/content/mainWorldBridge";

const W = window as Window & typeof globalThis;

function suppress(on: boolean): void {
  window.dispatchEvent(new CustomEvent(MW_SUPPRESS_EVENT, { detail: { on } }));
}
function fireBeforeUnload(): Event {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e;
}

afterEach(() => {
  __test.uninstall(W);
  vi.useRealTimers();
});

describe("mainWorldSuppressor, blocking-dialog suppression", () => {
  it("no-ops window.alert while active, restores it after", () => {
    const original = vi.fn();
    window.alert = original as unknown as typeof window.alert;
    installDialogSuppressor(W);

    suppress(true);
    window.alert("hi");
    expect(original).not.toHaveBeenCalled();

    suppress(false);
    window.alert("hi");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("neutralizes beforeunload while active, and stops after", () => {
    // In a real browser our handler sets the beforeunload string returnValue to
    // "" (→ no "leave site?" prompt). jsdom models returnValue as the legacy
    // boolean canceled-flag, so setting "" cancels the event there, observable
    // as defaultPrevented. Either way: while active our handler processes the
    // event; while inactive it is detached and does nothing.
    installDialogSuppressor(W);

    suppress(true);
    const e1 = fireBeforeUnload();
    expect(e1.defaultPrevented).toBe(true); // handler ran and neutralized it

    suppress(false);
    const e2 = fireBeforeUnload();
    expect(e2.defaultPrevented).toBe(false); // listener removed, no-op
  });

  it("nulls the onbeforeunload property while active and restores it", () => {
    const handler = () => "leave?";
    (window as unknown as { onbeforeunload: unknown }).onbeforeunload = handler;
    installDialogSuppressor(W);

    suppress(true);
    expect((window as unknown as { onbeforeunload: unknown }).onbeforeunload).toBeNull();

    suppress(false);
    expect((window as unknown as { onbeforeunload: unknown }).onbeforeunload).toBe(handler);
    (window as unknown as { onbeforeunload: unknown }).onbeforeunload = null;
  });

  it("never touches confirm()", () => {
    const confirmFn = vi.fn(() => true);
    window.confirm = confirmFn as unknown as typeof window.confirm;
    installDialogSuppressor(W);
    suppress(true);
    expect(window.confirm("x")).toBe(true);
    expect(confirmFn).toHaveBeenCalled();
  });

  it("auto-restores after the safety timeout", () => {
    vi.useFakeTimers();
    const original = vi.fn();
    window.alert = original as unknown as typeof window.alert;
    installDialogSuppressor(W);

    suppress(true);
    window.alert("a");
    expect(original).not.toHaveBeenCalled();

    vi.advanceTimersByTime(91_000); // > SAFETY_MS
    window.alert("b");
    expect(original).toHaveBeenCalledTimes(1); // restored by the safety timer
  });
});
