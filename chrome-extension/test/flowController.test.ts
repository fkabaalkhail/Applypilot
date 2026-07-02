import { describe, it, expect } from "vitest";
import {
  FlowController,
  fieldSignature,
  MAX_STEPS,
  type FlowDeps,
  type FlowSnapshot,
  type StepTally,
} from "../src/content/flowController";
import type { DetectedField, FlowProgress, FlowState } from "../src/shared/types";
import type { AdvanceButton } from "../src/content/advance";

function field(id: string, label: string): DetectedField {
  return {
    id, category: "unknown", confidence: 0.5, label, controlType: "text",
    required: false, proposedValue: null, fillable: true, sensitive: false,
  };
}

const tally = (ok = 3): StepTally => ({ ok, fail: 0, total: ok });
const freshState = (): FlowState => ({ active: true, step: 0, startedAt: 0, lastSignature: "" });

/** Scriptable deps: `pages` is a queue of field sets; advancing shifts it. */
function makeDeps(pages: DetectedField[][], advances: (AdvanceButton | null)[]): {
  deps: FlowDeps;
  log: string[];
  progress: FlowProgress[];
} {
  const log: string[] = [];
  const progress: FlowProgress[] = [];
  let clock = 0;
  let pageIx = 0;
  const snapshot = (): FlowSnapshot => ({
    fields: pages[Math.min(pageIx, pages.length - 1)],
    scopeEl: document.body,
  });
  const deps: FlowDeps = {
    fillStep: async (ids) => { log.push(`fill:${pageIx}:${ids ? "sel" : "auto"}`); return tally(); },
    snapshot,
    rescan: () => { log.push("rescan"); },
    findAdvance: () => advances[Math.min(pageIx, advances.length - 1)],
    clickAdvance: () => { log.push(`click:${pageIx}`); pageIx++; },
    accountStep: async () => ({}),
    pauseReason: async () => null,
    attachResume: async () => true,
    needsResume: () => false,
    setState: async (s) => { log.push(`state:${s ? s.step : "null"}`); },
    onProgress: (p) => progress.push(p),
    sleep: async () => { clock += 100; },
    now: () => clock,
  };
  return { deps, log, progress };
}

const advanceBtn = (): AdvanceButton => ({ el: document.createElement("button"), kind: "advance" });
const terminalBtn = (): AdvanceButton => ({ el: document.createElement("button"), kind: "terminal" });

/**
 * Run a controller to completion, answering every "ready" gate (Task B) as it
 * appears — standing in for the panel's "Next page" button. Mirrors the
 * microtask-spin the old drafts tests used to clear the review gate.
 */
async function drive(
  controller: FlowController,
  progress: FlowProgress[],
  firstTally: StepTally | null = null,
  state: FlowState = freshState()
): Promise<void> {
  const run = controller.run(state, firstTally);
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  let answered = 0;
  for (let guard = 0; guard < 100000 && !settled; guard++) {
    await Promise.resolve();
    const ready = progress.filter((p) => p.phase === "ready").length;
    if (ready > answered) {
      answered = ready;
      controller.notifyAdvanceRequested();
    }
  }
  await run;
}

describe("fieldSignature", () => {
  it("is order-independent and changes with content", () => {
    const a = [field("1", "First"), field("2", "Last")];
    const b = [field("2", "Last"), field("1", "First")];
    expect(fieldSignature(a)).toBe(fieldSignature(b));
    expect(fieldSignature(a)).not.toBe(fieldSignature([field("1", "First")]));
  });
});

describe("FlowController", () => {
  it("fills, advances through two pages, and finishes done at the terminal", async () => {
    const pages = [
      [field("1", "First name"), field("2", "Email")],
      [field("3", "Years of experience")],
    ];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    await drive(new FlowController(deps), progress);
    expect(log.filter((l) => l.startsWith("fill:"))).toEqual(["fill:0:auto", "fill:1:auto"]);
    expect(log).toContain("click:0");
    expect(log[log.length - 1]).toBe("state:null"); // state cleared at the end
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("uses the provided first tally instead of re-filling step 0", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), null]);
    await drive(new FlowController(deps), progress, tally(5));
    expect(log.filter((l) => l.startsWith("fill:"))).toEqual(["fill:1:auto"]);
  });

  it("finishes done when no advance button exists (single-page form) with no ready beat", async () => {
    const { deps, progress } = makeDeps([[field("1", "A")]], [null]);
    await new FlowController(deps).run(freshState(), null);
    expect(progress[progress.length - 1].phase).toBe("done");
    expect(progress.some((p) => p.phase === "ready")).toBe(false);
  });

  it("stops when the page never changes after an advance click (loop guard)", async () => {
    const samePage = [field("1", "A"), field("2", "B")];
    const pages = [samePage];
    const { deps, progress } = makeDeps(pages, [advanceBtn()]);
    deps.clickAdvance = (): void => {}; // click does nothing — page never changes
    await drive(new FlowController(deps), progress);
    const last = progress[progress.length - 1];
    expect(last.phase).toBe("stopped");
    expect(last.detail).toMatch(/advance/i);
  });

  it("stop() during a blocking pause ends the flow as stopped", async () => {
    // The review gate is gone; the remaining pauses poll a blocking condition.
    // A never-clearing captcha parks the flow — stop() must end it as stopped.
    const { deps, progress } = makeDeps([[field("1", "A")]], [advanceBtn()]);
    deps.pauseReason = async (): Promise<"captcha"> => "captcha"; // never clears
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.pauseReason === "captcha")) await Promise.resolve();
    controller.stop();
    await run;
    expect(progress[progress.length - 1].phase).toBe("stopped");
  });

  it("respects MAX_STEPS", async () => {
    // Endless pages: every page advances and yields a fresh field set.
    let n = 0;
    const { deps, progress } = makeDeps([[field("0", "L0")]], [advanceBtn()]);
    deps.snapshot = (): FlowSnapshot => ({ fields: [field(String(n), `L${n}`)], scopeEl: document.body });
    deps.clickAdvance = (): void => { n++; };
    await drive(new FlowController(deps), progress);
    expect(progress[progress.length - 1].phase).toBe("stopped");
    expect(progress[progress.length - 1].detail).toMatch(/step limit/i);
    expect(n).toBeLessThanOrEqual(MAX_STEPS);
  });

  it("pauses on validation after a rejected click, then retries the same step", async () => {
    const samePage = [field("1", "A")];
    const { deps, progress } = makeDeps([samePage, [field("2", "B")]], [advanceBtn(), terminalBtn()]);
    let clicks = 0;
    let errorShown = false;
    const origClick = deps.clickAdvance;
    deps.clickAdvance = (el): void => {
      clicks++;
      if (clicks === 1) { errorShown = true; return; } // first click rejected
      origClick(el);
    };
    deps.pauseReason = async (): Promise<"validation" | null> => {
      if (errorShown) { errorShown = false; return "validation"; } // clears on next poll
      return null;
    };
    await drive(new FlowController(deps), progress);
    expect(clicks).toBe(2);
    expect(progress.some((p) => p.pauseReason === "validation")).toBe(true);
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("parks at the ready gate and only clicks advance after notifyAdvanceRequested", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    // Page 1 fills, then the flow waits at "ready" — no advance click yet.
    while (!progress.some((p) => p.phase === "ready")) await Promise.resolve();
    expect(log).not.toContain("click:0");
    controller.notifyAdvanceRequested();
    await run;
    expect(log).toContain("click:0");
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("stop() while waiting at the ready gate ends the flow as stopped without clicking", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.phase === "ready")) await Promise.resolve();
    controller.stop();
    await run;
    expect(progress[progress.length - 1].phase).toBe("stopped");
    expect(log).not.toContain("click:0");
  });

  it("finishes done at a terminal button with no ready beat and no click", async () => {
    const { deps, log, progress } = makeDeps([[field("1", "A")]], [terminalBtn()]);
    await new FlowController(deps).run(freshState(), null);
    expect(progress[progress.length - 1].phase).toBe("done");
    expect(progress.some((p) => p.phase === "ready")).toBe(false);
    expect(log.some((l) => l.startsWith("click:"))).toBe(false);
  });
});
