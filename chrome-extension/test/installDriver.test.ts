import { describe, it, expect, vi, beforeEach } from "vitest";

// serviceWorker.ts touches chrome at module top level, so chrome must exist
// before the import. vi.hoisted runs before imports.
const { executeScript } = vi.hoisted(() => {
  const executeScript = vi.fn();
  const noop = { addListener: () => {} };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { onInstalled: noop, onStartup: noop, onMessage: noop },
    alarms: { create: () => {}, onAlarm: noop },
    action: { onClicked: noop },
    scripting: { executeScript },
  };
  return { executeScript };
});
import { injectMainWorldDriver } from "../src/background/serviceWorker";

beforeEach(() => {
  executeScript.mockReset().mockResolvedValue([{ result: null }]);
});

describe("injectMainWorldDriver", () => {
  it("injects mainWorld.js into the given frame in the MAIN world", async () => {
    const res = await injectMainWorldDriver(7, 3);
    expect(res.ok).toBe(true);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [3] },
        world: "MAIN",
        files: ["mainWorld.js"],
      })
    );
  });

  it("returns ok:false with a reason when injection throws", async () => {
    executeScript.mockRejectedValueOnce(new Error("frame gone"));
    const res = await injectMainWorldDriver(7, 3);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/frame gone/);
  });
});
