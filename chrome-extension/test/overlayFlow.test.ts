import { describe, it, expect } from "vitest";
import { STYLES, formatFlowProgress, formatNextLabel, showsAdvanceGate } from "../src/content/overlay";
import type { FlowPhase, FlowProgress } from "../src/shared/types";

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
  const beat = (extra: Record<string, unknown> = {}) =>
    ({ phase: "ready", step: 1, filledOk: 0, filledFail: 0, ...extra }) as never;

  it("uses one plain label for ordinary page turns", () => {
    expect(formatNextLabel(beat())).toBe("Continue To The Next Page ▶");
    // Echoing the site's own "Next" / "Save and Continue" adds nothing.
    expect(formatNextLabel(beat({ nextLabel: "Next" }))).toBe("Continue To The Next Page ▶");
    expect(formatNextLabel(beat({ nextLabel: "Save and Continue" }))).toBe("Continue To The Next Page ▶");
  });

  it("names an advance that creates or enters an account", () => {
    // Pressing Continue here registers an account — say so.
    expect(formatNextLabel(beat({ nextLabel: "Create Account" }))).toBe("Create Account ▶");
    expect(formatNextLabel(beat({ nextLabel: "Sign In" }))).toBe("Sign In ▶");
  });
});

describe("showsAdvanceGate", () => {
  const beat = (extra: Partial<FlowProgress> = {}): FlowProgress => ({
    phase: "paused",
    step: 1,
    filledOk: 0,
    filledFail: 0,
    ...extra,
  });

  it("offers the gate on a filled page waiting to be turned", () => {
    expect(showsAdvanceGate({ phase: "ready", step: 0, filledOk: 3, filledFail: 0 })).toBe(true);
    expect(showsAdvanceGate(beat({ pauseReason: "unfilled-required" }))).toBe(true);
  });

  /**
   * REGRESSION: an account wall the flow could not pass (site rejected the
   * password) left the user staring at a filled create-account form with no
   * gate, no summary and — before this — no message either. The only thing
   * left to try was clicking Autofill again.
   */
  it("offers the gate on an account wall the flow could not pass", () => {
    expect(showsAdvanceGate(beat({ pauseReason: "account" }))).toBe(true);
  });

  /**
   * A validation pause is something the USER fixes on the page — Workday's
   * create-account form shows live password-rule alerts. Parking there with no
   * button stranded the user on the account page with nothing to press.
   */
  it("offers the gate on a validation pause the user can clear", () => {
    expect(showsAdvanceGate(beat({ pauseReason: "validation" }))).toBe(true);
  });

  it("hides the gate on pauses a press could not clear", () => {
    for (const pauseReason of ["captcha", "verification", "resume-upload"] as const) {
      expect(showsAdvanceGate(beat({ pauseReason })), pauseReason).toBe(false);
    }
  });

  it("hides the gate while working and once the flow is over", () => {
    for (const phase of ["filling", "advancing", "done", "stopped"] as FlowPhase[]) {
      expect(showsAdvanceGate({ phase, step: 0, filledOk: 0, filledFail: 0 }), phase).toBe(false);
    }
  });
});

describe("advance gate styling", () => {
  it("uses the app primary, not the old green", () => {
    const rule = STYLES.slice(
      STYLES.indexOf(".ap-flow-next {"),
      STYLES.indexOf(".ap-flow-next:hover")
    );
    expect(rule).toContain("var(--stripe-primary)");
    for (const green of ["#10cf7f", "#0bb96f", "#0aa563"]) {
      expect(STYLES, green).not.toContain(green);
    }
  });
});
