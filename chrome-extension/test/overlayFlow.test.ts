import { describe, it, expect } from "vitest";
import { formatFlowProgress } from "../src/content/overlay";

describe("formatFlowProgress", () => {
  it("describes each phase in user language", () => {
    expect(formatFlowProgress({ phase: "filling", step: 0, filledOk: 3, filledFail: 0 })).toBe("Step 1 · filling…");
    expect(formatFlowProgress({ phase: "advancing", step: 1, filledOk: 3, filledFail: 0 })).toBe("Step 2 · next page…");
    expect(
      formatFlowProgress({ phase: "paused", step: 1, filledOk: 3, filledFail: 0, pauseReason: "captcha" })
    ).toBe("Step 2 · paused — solve the captcha to continue");
    expect(
      formatFlowProgress({ phase: "ready", step: 1, filledOk: 3, filledFail: 0 })
    ).toBe("Step 2 filled — review this page, then Next page");
    expect(
      formatFlowProgress({ phase: "done", step: 3, filledOk: 9, filledFail: 1 })
    ).toBe("Done — 4 steps filled (9 ok, 1 need attention). Review and submit.");
    expect(
      formatFlowProgress({ phase: "stopped", step: 2, filledOk: 0, filledFail: 0, detail: "Flow timed out" })
    ).toBe("Flow timed out");
  });

  it("uses singular step wording", () => {
    expect(formatFlowProgress({ phase: "done", step: 0, filledOk: 5, filledFail: 0 })).toBe(
      "Done — 1 step filled (5 ok). Review and submit."
    );
  });

  it("describes the unfilled-required pause", () => {
    const line = formatFlowProgress({ phase: "paused", step: 1, filledOk: 3, filledFail: 0, pauseReason: "unfilled-required" });
    expect(line.toLowerCase()).toContain("required");
  });
});
