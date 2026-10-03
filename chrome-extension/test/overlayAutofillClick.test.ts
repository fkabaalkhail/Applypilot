/**
 * REGRESSION (live BambooHR, 2026-10-03): the Autofill button is live whenever
 * a profile is loaded, but a click with no field picked and no "Apply" entry on
 * the page returned silently. A user who opened a BambooHR form and pressed
 * Autofill while the site still held the form hidden (2.5-5 s) got a button
 * that did nothing. The click must always reach the fill, which waits for the
 * hidden form (hiddenForm.ts) or lets the flow say no form was found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OverlayCallbacks } from "../src/content/overlay";

function stubChrome(): void {
  const sendMessage = vi.fn(async (msg: { type: string }) => {
    if (msg.type === "GET_STATUS") return { mode: "connected" };
    if (msg.type === "GET_PROFILE") return { ok: true, profile: { firstName: "Maya", lastName: "Tremblay", email: "maya@example.com" } };
    return { ok: true };
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: "test", sendMessage, getURL: (p: string) => p },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

/** Every callback a stub; onAutofill is the one under test. */
function callbacks(onAutofill: OverlayCallbacks["onAutofill"]): OverlayCallbacks {
  const named: Partial<OverlayCallbacks> = {
    onAutofill,
    onListResumes: async () => [],
    onProfileResolved: () => {},
  };
  return new Proxy(named, {
    get: (t, k: string) => (k in t ? t[k as keyof OverlayCallbacks] : async () => ({ ok: true })),
  }) as OverlayCallbacks;
}

beforeEach(() => {
  document.body.innerHTML = "";
  stubChrome();
});
afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("Autofill click with nothing picked", () => {
  it("still runs the fill (no silent no-op) when the page shows no field and no Apply entry", async () => {
    const { showOverlay } = await import("../src/content/overlay");
    const onAutofill = vi.fn(async () => ({ ok: 0, fail: 0, total: 0 }));
    showOverlay(
      { fields: [], tabUrl: "https://nexthopai.bamboohr.com/careers/64", applyEntry: null, siteLabel: "BambooHR" },
      callbacks(onAutofill as unknown as OverlayCallbacks["onAutofill"])
    );
    const host = document.getElementById("applypilot-overlay-host")!;
    const btn = host.shadowRoot!.querySelector<HTMLButtonElement>("#ap-btn-autofill")!;
    await vi.waitFor(() => expect(btn.disabled).toBe(false)); // profile loaded

    btn.click();

    await vi.waitFor(() => expect(onAutofill).toHaveBeenCalledTimes(1));
    expect(onAutofill).toHaveBeenCalledWith([], null);
  });
});
