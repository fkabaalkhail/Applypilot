import { describe, it, expect } from "vitest";
import { formatFlowProgress, formatNextLabel } from "../src/content/overlay";

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

  it("narrates account walls and entry clicks via the detail", () => {
    expect(
      formatFlowProgress({ phase: "filling", step: 0, filledOk: 0, filledFail: 0, detail: "creating account…" })
    ).toBe("Step 1 · creating account…");
    expect(
      formatFlowProgress({ phase: "advancing", step: 0, filledOk: 0, filledFail: 0, detail: 'opening "Apply"…' })
    ).toBe('Step 1 · opening "Apply"…');
    expect(
      formatFlowProgress({ phase: "advancing", step: 1, filledOk: 3, filledFail: 0, detail: "signing in…" })
    ).toBe("Step 2 · signing in…");
  });

  it("points the account pause at the Account creation section", () => {
    const line = formatFlowProgress({ phase: "paused", step: 0, filledOk: 0, filledFail: 0, pauseReason: "account" });
    expect(line).toContain("Account creation");
  });
});

describe("formatNextLabel", () => {
  it("mirrors the real button the flow will click, defaulting to Next page", () => {
    const beat = { phase: "paused" as const, step: 0, filledOk: 0, filledFail: 0 };
    expect(formatNextLabel(beat)).toBe("Next page →");
    expect(formatNextLabel({ ...beat, nextLabel: "Create Account" })).toBe("Create Account →");
    expect(formatNextLabel({ ...beat, nextLabel: "Sign In" })).toBe("Sign In →");
    expect(formatNextLabel({ ...beat, nextLabel: "  " })).toBe("Next page →");
  });
});
