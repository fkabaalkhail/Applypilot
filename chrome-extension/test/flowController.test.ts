import { describe, it, expect } from "vitest";
import {
  FlowController,
  fieldSignature,
  stepSignature,
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

/** Scriptable deps: `pages` is a queue of field sets; advancing shifts it.
 *  `entries` scripts each page's apply-entry button label (field-less pages).
 *  Field-less pages have no form scope, mirroring the real scanner. */
function makeDeps(
  pages: DetectedField[][],
  advances: (AdvanceButton | null)[],
  entries: (string | null)[] = []
): {
  deps: FlowDeps;
  log: string[];
  progress: FlowProgress[];
} {
  const log: string[] = [];
  const progress: FlowProgress[] = [];
  let clock = 0;
  let pageIx = 0;
  const snapshot = (): FlowSnapshot => {
    const fields = pages[Math.min(pageIx, pages.length - 1)];
    const label = entries.length ? entries[Math.min(pageIx, entries.length - 1)] : null;
    return {
      fields,
      scopeEl: fields.length > 0 ? document.body : null,
      url: `https://ats.example/page-${pageIx}`,
      entry: label ? { el: document.createElement("button"), label } : null,
    };
  };
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
    hasUnfilledRequired: () => false,
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
    // Clean pages now auto-advance; a manual gate only appears at a legacy
    // "ready" beat or an unfilled-required pause. Answer either.
    const gates = progress.filter(
      (p) => p.phase === "ready" || (p.phase === "paused" && p.pauseReason === "unfilled-required")
    ).length;
    if (gates > answered) {
      answered = gates;
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

describe("stepSignature", () => {
  const snap = (fields: DetectedField[], url: string, entryLabel: string | null): FlowSnapshot => ({
    fields,
    scopeEl: null,
    url,
    entry: entryLabel ? { el: document.createElement("button"), label: entryLabel } : null,
  });

  it("hashes fields when present, ignoring the URL", () => {
    const fields = [field("1", "First")];
    expect(stepSignature(snap(fields, "https://a/1", null))).toBe(stepSignature(snap(fields, "https://a/2", null)));
  });

  it("falls back to URL + entry label on field-less pages", () => {
    // SPA chooser: same URL, but "Apply" became "Apply Manually" — a new page.
    expect(stepSignature(snap([], "https://a/job", "Apply"))).not.toBe(
      stepSignature(snap([], "https://a/job", "Apply Manually"))
    );
    expect(stepSignature(snap([], "https://a/job", "Apply"))).not.toBe(
      stepSignature(snap([], "https://a/job/apply", "Apply"))
    );
    expect(stepSignature(snap([], "https://a/job", "Apply"))).toBe(
      stepSignature(snap([], "https://a/job", "Apply"))
    );
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

  it("auto-advances a clean page without a manual Next-page click", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    // hasUnfilledRequired defaults to false → the clean page advances on its own.
    await new FlowController(deps).run(freshState(), null);
    expect(log).toContain("click:0"); // advanced with no notifyAdvanceRequested
    expect(progress.some((p) => p.phase === "ready")).toBe(false);
    expect(progress.some((p) => p.pauseReason === "unfilled-required")).toBe(false);
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
    deps.snapshot = (): FlowSnapshot => ({
      fields: [field(String(n), `L${n}`)],
      scopeEl: document.body,
      url: "https://ats.example/loop",
      entry: null,
    });
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

  it("pauses on unfilled-required and only clicks advance after notifyAdvanceRequested", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    deps.hasUnfilledRequired = (): boolean => true; // page 1 has an empty required field
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    // Page 1 fills, then the flow pauses — no advance click yet.
    while (!progress.some((p) => p.pauseReason === "unfilled-required")) await Promise.resolve();
    expect(log).not.toContain("click:0");
    controller.notifyAdvanceRequested();
    await run;
    expect(log).toContain("click:0");
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("stop() while paused at unfilled-required ends the flow as stopped without clicking", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    deps.hasUnfilledRequired = (): boolean => true;
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.pauseReason === "unfilled-required")) await Promise.resolve();
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

  it("clicks apply-entry buttons through field-less pages into the form", async () => {
    // Job posting ("Apply") → chooser ("Apply Manually") → the real form.
    const pages: DetectedField[][] = [[], [], [field("1", "First name")]];
    const { deps, log, progress } = makeDeps(pages, [null, null, terminalBtn()], ["Apply", "Apply Manually", null]);
    await new FlowController(deps).run(freshState(), null);
    expect(log).toContain("click:0"); // Apply
    expect(log).toContain("click:1"); // Apply Manually
    expect(progress[progress.length - 1].phase).toBe("done");
    const opening = progress.filter((p) => p.phase === "advancing" && /opening/.test(p.detail ?? ""));
    expect(opening.map((p) => p.detail)).toEqual(['opening "Apply"…', 'opening "Apply Manually"…']);
  });

  it("stops with a clear message when a field-less page has no entry", async () => {
    const { deps, progress } = makeDeps([[]], [null]);
    await new FlowController(deps).run(freshState(), null);
    const last = progress[progress.length - 1];
    expect(last.phase).toBe("stopped");
    expect(last.detail).toMatch(/no application form/i);
  });

  it("stops when an entry click never changes the page", async () => {
    const { deps, progress } = makeDeps([[]], [null], ["Apply"]);
    deps.clickAdvance = (): void => {}; // click does nothing
    await new FlowController(deps).run(freshState(), null);
    const last = progress[progress.length - 1];
    expect(last.phase).toBe("stopped");
    expect(last.detail).toMatch(/couldn't open/i);
  });

  it("narrates account walls and labels the manual gate after the real button", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const create = document.createElement("button");
    create.textContent = "Create Account";
    const { deps, log, progress } = makeDeps(pages, [{ el: create, kind: "advance" }, terminalBtn()]);
    deps.accountStep = async () => ({ wall: "signup" as const });
    deps.hasUnfilledRequired = (snap): boolean => snap.fields[0]?.id === "1"; // page 1 only
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.pauseReason === "unfilled-required")) await Promise.resolve();
    const gate = progress.find((p) => p.pauseReason === "unfilled-required");
    expect(gate?.nextLabel).toBe("Create Account");
    controller.notifyAdvanceRequested();
    await run;
    expect(progress.some((p) => p.phase === "filling" && p.detail === "creating account…")).toBe(true);
    expect(progress.some((p) => p.phase === "advancing" && p.detail === "creating account…")).toBe(true);
    expect(log).toContain("click:0");
    expect(progress[progress.length - 1].phase).toBe("done");
  });
});
