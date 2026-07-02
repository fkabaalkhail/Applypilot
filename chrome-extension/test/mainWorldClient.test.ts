import { describe, it, expect, vi, beforeEach } from "vitest";
import { driveField, __resetDriverInstall } from "../src/content/mainWorldClient";
import { MW_FILL_EVENT, MW_RESULT_EVENT, type MwFillDetail } from "../src/content/mainWorldBridge";

beforeEach(() => {
  __resetDriverInstall();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true }) },
  };
});

/** Echo driver: replies ok to the next fill request, after a tick. `{ once: true }`
 *  keeps this scoped to the single driveField() call under test — jsdom's `window`
 *  persists across `it()` blocks in the same file, so a non-self-removing listener
 *  here would also answer a later test's unrelated fill request. */
function installEcho(committed = "Canada"): void {
  window.addEventListener(
    MW_FILL_EVENT,
    (e) => {
      const d = (e as CustomEvent<MwFillDetail>).detail;
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(MW_RESULT_EVENT, { detail: { id: d.id, ok: true, committed } }));
      }, 0);
    },
    { once: true }
  );
}

describe("driveField", () => {
  it("requests install, sends a fill event, and resolves with the driver result", async () => {
    installEcho("Canada");
    const res = await driveField("f1", "Canada", "react-select");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "INSTALL_MAIN_WORLD_DRIVER" });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe("Canada");
  });

  it("soft-fails on timeout when no driver replies", async () => {
    // no echo installed
    const res = await driveField("f2", "Canada", "react-select", { timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/timeout/i);
  });

  it("fails fast (no timeout wait) when the driver can't be installed", async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
    const start = Date.now();
    const res = await driveField("f3", "Canada", "react-select", { timeoutMs: 5000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("driver-uninstalled");
    expect(Date.now() - start).toBeLessThan(1000); // did not wait out the 5s timeout
  });
});
