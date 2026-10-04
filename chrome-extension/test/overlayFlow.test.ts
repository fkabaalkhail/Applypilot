import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  STYLES,
  buildHTML,
  formatFlowProgress,
  formatNextLabel,
  installRefs,
  showsAdvanceGate,
  showsPauseControl,
  updateFlowProgress,
} from "../src/content/overlay";
import type { FlowPhase, FlowProgress } from "../src/shared/types";

describe("formatFlowProgress", () => {
  it("describes each phase in user language", () => {
    expect(formatFlowProgress({ phase: "filling", step: 0, filledOk: 3, filledFail: 0 })).toBe("Step 1 · filling…");
    expect(formatFlowProgress({ phase: "advancing", step: 1, filledOk: 3, filledFail: 0 })).toBe("Step 2 · next page…");
    expect(
      formatFlowProgress({ phase: "paused", step: 1, filledOk: 3, filledFail: 0, pauseReason: "captcha" })
    ).toBe("Step 2 · paused: solve the captcha to continue");
    expect(
      formatFlowProgress({ phase: "ready", step: 1, filledOk: 3, filledFail: 0 })
    ).toBe("Step 2 filled. Review this page, then Next page");
    expect(
      formatFlowProgress({ phase: "ready", step: 1, filledOk: 3, filledFail: 0, autoAdvanceMs: 2000 })
    ).toBe("Step 2 filled. Next page in 2s");
    expect(
      formatFlowProgress({ phase: "done", step: 3, filledOk: 9, filledFail: 1 })
    ).toBe("Done. 4 steps filled (9 ok, 1 need attention). Review and submit.");
    expect(
      formatFlowProgress({ phase: "stopped", step: 2, filledOk: 0, filledFail: 0, detail: "Flow timed out" })
    ).toBe("Flow timed out");
  });

  it("uses singular step wording", () => {
    expect(formatFlowProgress({ phase: "done", step: 0, filledOk: 5, filledFail: 0 })).toBe(
      "Done. 1 step filled (5 ok). Review and submit."
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
    // Pressing Continue here registers an account, say so.
    expect(formatNextLabel(beat({ nextLabel: "Create Account" }))).toBe("Create Account ▶");
    expect(formatNextLabel(beat({ nextLabel: "Sign In" }))).toBe("Sign In ▶");
  });

  it("counts down in whole seconds while the page turns by itself", () => {
    const counting = beat({ autoAdvanceMs: 2000, nextLabel: "Save and Continue" });
    expect(formatNextLabel(counting, 2000)).toBe("Next page in 2s ▶");
    expect(formatNextLabel(counting, 1200)).toBe("Next page in 2s ▶");
    expect(formatNextLabel(counting, 900)).toBe("Next page in 1s ▶");
    // Never "in 0s" while the click is on its way: that reads as stuck.
    expect(formatNextLabel(counting, 0)).toBe("Next page in 1s ▶");
    expect(formatNextLabel(beat({ autoAdvanceMs: 2000, nextLabel: "Create Account" }), 1500)).toBe(
      "Create Account in 2s ▶"
    );
  });

  it("drops the countdown once the page is held (no autoAdvanceMs)", () => {
    expect(formatNextLabel(beat({ nextLabel: "Next" }), 1500)).toBe("Continue To The Next Page ▶");
  });
});

describe("the countdown in the panel", () => {
  let root: HTMLDivElement;
  const gate = () => ({
    wrap: root.querySelector<HTMLDivElement>(".ap-flow-next-wrap")!,
    next: root.querySelector<HTMLButtonElement>("#ap-flow-next")!,
    pause: root.querySelector<HTMLButtonElement>("#ap-flow-pause")!,
  });
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.className = "ap-root";
    root.innerHTML = buildHTML();
    document.body.append(root);
    installRefs(root);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the counting button with Pause beside it, and ticks down", () => {
    updateFlowProgress({ phase: "ready", step: 2, filledOk: 5, filledFail: 0, autoAdvanceMs: 2000 });
    expect(gate().wrap.style.display).toBe("flex");
    expect(gate().pause.style.display).toBe("");
    expect(gate().next.textContent).toBe("Next page in 2s ▶");
    vi.advanceTimersByTime(1100);
    expect(gate().next.textContent).toBe("Next page in 1s ▶");
  });

  it("a held page keeps the button as a plain Continue and hides Pause", () => {
    updateFlowProgress({ phase: "ready", step: 2, filledOk: 5, filledFail: 0, autoAdvanceMs: 2000 });
    updateFlowProgress({ phase: "ready", step: 2, filledOk: 5, filledFail: 0 });
    expect(gate().wrap.style.display).toBe("flex");
    expect(gate().pause.style.display).toBe("none");
    vi.advanceTimersByTime(3000); // the old countdown's ticker must be gone
    expect(gate().next.textContent).toBe("Continue To The Next Page ▶");
  });

  it("hides the whole gate while the next page loads", () => {
    updateFlowProgress({ phase: "ready", step: 2, filledOk: 5, filledFail: 0, autoAdvanceMs: 2000 });
    updateFlowProgress({ phase: "advancing", step: 3, filledOk: 5, filledFail: 0 });
    expect(gate().wrap.style.display).toBe("none");
  });

  it("offers Pause only while a page counts down", () => {
    expect(showsPauseControl({ phase: "ready", step: 0, filledOk: 0, filledFail: 0, autoAdvanceMs: 2000 })).toBe(true);
    expect(showsPauseControl({ phase: "ready", step: 0, filledOk: 0, filledFail: 0 })).toBe(false);
    expect(
      showsPauseControl({ phase: "paused", step: 0, filledOk: 0, filledFail: 0, pauseReason: "unfilled-required" })
    ).toBe(false);
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
   * gate, no summary and (before this) no message either. The only thing
   * left to try was clicking Autofill again.
   */
  it("offers the gate on an account wall the flow could not pass", () => {
    expect(showsAdvanceGate(beat({ pauseReason: "account" }))).toBe(true);
  });

  /**
   * A validation pause is something the USER fixes on the page, Workday's
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
