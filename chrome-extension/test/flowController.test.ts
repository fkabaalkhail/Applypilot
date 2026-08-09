import { describe, it, expect } from "vitest";
import {
  FlowController,
  fieldSignature,
  stepSignature,
  MAX_STEPS,
  USER_CLEARABLE_PAUSES,
  type FlowDeps,
  type FlowSnapshot,
  type StepTally,
} from "../src/content/flowController";
import { showsAdvanceGate } from "../src/content/overlay";
import type { DetectedField, FlowPauseReason, FlowProgress, FlowState } from "../src/shared/types";
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
      accountWall: false,
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
    auditPageState: async () => { log.push(`audit:${pageIx}`); },
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
    // Every filled page parks at a gate the user must clear: a "ready" beat on a
    // clean page, or an unfilled-required pause. Answer each as the panel button would.
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
    accountWall: false,
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

  it("parks at 'ready' on a clean page and only advances after notifyAdvanceRequested", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, log, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    // Clean page (no unfilled required) — the flow must NOT auto-advance; the
    // user decides each page turn via the panel's contextual bottom button.
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.phase === "ready")) await Promise.resolve();
    expect(log).not.toContain("click:0"); // parked, waiting for the user
    controller.notifyAdvanceRequested();
    await run;
    expect(log).toContain("click:0"); // advanced only after the user's click
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("labels the ready gate with the advance button's text", async () => {
    const next = document.createElement("button");
    next.textContent = "Create Account";
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, progress } = makeDeps(pages, [{ el: next, kind: "advance" }, terminalBtn()]);
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), null);
    while (!progress.some((p) => p.phase === "ready")) await Promise.resolve();
    expect(progress.find((p) => p.phase === "ready")?.nextLabel).toBe("Create Account");
    controller.notifyAdvanceRequested();
    await run;
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
      accountWall: false,
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

  it("auto-attaches a lazy-rendered résumé field without a manual attach", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const { deps, progress } = makeDeps(pages, [advanceBtn(), terminalBtn()]);
    let attached = false;
    deps.attachResume = async (): Promise<boolean> => { attached = true; return true; };
    // The résumé field lazy-renders: the page reports resume-upload until attached.
    deps.pauseReason = async (): Promise<"resume-upload" | null> => (attached ? null : "resume-upload");
    await drive(new FlowController(deps), progress);
    expect(attached).toBe(true); // attached on its own — no manual attach needed
    expect(progress[progress.length - 1].phase).toBe("done");
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

  it("pauses (not stops) when an account wall can't auto-advance, and resumes when the user clears it", async () => {
    // Signup wall whose "Create Account" click doesn't take (Workday rejected
    // the generated password / an unmet requirement). The flow must hand off to
    // the user, then resume once the wall is gone — never finish "stopped".
    const wallFields = [field("1", "Password")];
    const formFields = [field("2", "First name")];
    let cleared = false; // the user finishes the signup after a couple polls
    let polls = 0;
    const log: string[] = [];
    const progress: FlowProgress[] = [];
    let clock = 0;
    const snapshot = (): FlowSnapshot => ({
      fields: cleared ? formFields : wallFields,
      scopeEl: document.body,
      url: "https://ats.example/account",
      entry: null,
      accountWall: !cleared,
    });
    const deps: FlowDeps = {
      fillStep: async () => { log.push("fill"); return tally(); },
      snapshot,
      rescan: () => { if (progress.some((p) => p.pauseReason === "account") && ++polls >= 2) cleared = true; },
      findAdvance: () =>
        cleared ? terminalBtn() : ({ el: document.createElement("button"), kind: "advance" }),
      clickAdvance: () => { log.push("click"); }, // the wall click never changes the page
      accountStep: async () => ({ wall: "signup" as const }),
      pauseReason: async () => null,
      attachResume: async () => true,
      needsResume: () => false,
      hasUnfilledRequired: () => false,
      setState: async () => {},
      onProgress: (p) => progress.push(p),
      sleep: async () => { clock += 100; },
      now: () => clock,
    };
    await drive(new FlowController(deps), progress); // clear the "ready" gate as the user would
    expect(progress.some((p) => p.pauseReason === "account")).toBe(true);
    expect(log).toContain("click"); // it did attempt Create Account
    expect(progress[progress.length - 1].phase).toBe("done"); // resumed, not stopped
  });

  it("parks on an account wall too — the user turns every page, including signup", async () => {
    const pages = [[field("1", "A")], [field("2", "B")]];
    const create = document.createElement("button");
    create.textContent = "Create Account";
    const { deps, log, progress } = makeDeps(pages, [{ el: create, kind: "advance" }, terminalBtn()]);
    deps.accountStep = async () => ({ wall: "signup" as const });
    const controller = new FlowController(deps);
    // drive() clears each gate the way the panel's Continue button does.
    await drive(controller, progress);
    // The wall is gated like any other page: creating an account is not
    // something to do while the user is still reading the form.
    const gate = progress.find((p) => p.phase === "ready");
    expect(gate, "the wall parked at a ready gate").toBeTruthy();
    expect(gate!.nextLabel).toBe("Create Account");
    // Still narrated as an account step, and still clicked once released.
    expect(progress.some((p) => p.phase === "filling" && p.detail === "creating account…")).toBe(true);
    expect(log).toContain("click:0");
    expect(progress[progress.length - 1].phase).toBe("done");
  });

  it("lets the user release an account wall the flow could not pass", async () => {
    // A signup wall whose Create Account click never advances (the site
    // rejected it) AND which stays on screen, so the auto-clear poll can never
    // fire. Only the panel's Continue button can free the flow.
    const pages = [[field("1", "A")], [field("2", "B")]];
    const create = document.createElement("button");
    create.textContent = "Create Account";
    const { deps, progress } = makeDeps(pages, [{ el: create, kind: "advance" }, terminalBtn()]);
    deps.accountStep = async () => ({ wall: "signup" as const });
    deps.clickAdvance = () => {}; // the click is rejected: the page never moves
    const base = deps.snapshot;
    deps.snapshot = (): FlowSnapshot => ({ ...base(), accountWall: true }); // wall never clears
    const controller = new FlowController(deps);

    let releases = 0;
    const seen = new Set<string>();
    deps.onProgress = (p): void => {
      progress.push(p);
      // Clear BOTH gates as the panel would: the ready gate the wall now parks
      // at, and the account pause after its click is rejected.
      const key = `${p.phase}:${p.pauseReason ?? ""}`;
      if ((p.phase === "ready" || p.pauseReason === "account") && !seen.has(key)) {
        seen.add(key);
        releases++;
        controller.notifyAdvanceRequested();
      }
    };

    const run = controller.run(freshState(), null);
    for (let i = 0; i < 2000; i++) await Promise.resolve();
    controller.stop();
    await run;

    expect(progress.some((p) => p.pauseReason === "account")).toBe(true);
    expect(releases).toBe(2);
    // Released → the flow re-attempted the step. Parked forever → only one.
    expect(progress.filter((p) => p.phase === "filling").length).toBeGreaterThan(1);
  });
});

describe("manual override of a pause", () => {
  /** Deps parked on one pause reason forever, so only a press can move them. */
  function stuckDeps(reason: FlowPauseReason): { deps: FlowDeps; progress: FlowProgress[] } {
    const { deps, progress } = makeDeps([[field("a", "Name")]], [advanceBtn()]);
    deps.pauseReason = async () => reason;
    return { deps, progress };
  }

  /** Let the controller's awaits drain. Its sleep() resolves immediately, so a
   *  microtask spin is the whole clock. */
  const spin = async (n = 200): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it("lets the user release a validation pause", async () => {
    const { deps, progress } = stuckDeps("validation");
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), tally());
    // Let the controller reach the pause, then press Continue.
    await spin();
    expect(progress.some((p) => p.phase === "paused" && p.pauseReason === "validation")).toBe(true);
    controller.notifyAdvanceRequested();
    await spin();
    // Released: the flow left the pause and parked at the next gate. pauseReason
    // never clears here, so only the press could have moved it — without the
    // override the flow polls "validation" forever and never reaches "ready".
    expect(progress.some((p) => p.phase === "ready")).toBe(true);
    controller.stop();
    await run;
  });

  it("ignores a press on a captcha pause — a click cannot solve it", async () => {
    const { deps, progress } = stuckDeps("captcha");
    let polls = 0;
    deps.pauseReason = async () => { polls++; return "captcha"; };
    const controller = new FlowController(deps);
    const run = controller.run(freshState(), tally());
    await spin();
    controller.notifyAdvanceRequested();
    const before = polls;
    await spin();
    expect(polls).toBeGreaterThan(before); // still polling — the press did not release it
    expect(progress.some((p) => p.phase === "ready")).toBe(false);
    controller.stop();
    await run;
  });

  it("only releases pauses a press can actually clear", () => {
    // Pinned membership: adding captcha/verification/resume-upload here would
    // let a press skip a blocker the user has not dealt with.
    expect([...USER_CLEARABLE_PAUSES].sort()).toEqual(["account", "unfilled-required", "validation"]);
  });

  it("agrees with the panel about which pauses show a gate", () => {
    // The two halves of the fix must match exactly: a gate the flow ignores
    // strands the user just as badly as no gate, and honouring a press with no
    // button to press is dead code.
    const all: FlowPauseReason[] = [
      "captcha", "resume-upload", "validation", "account", "verification", "unfilled-required",
    ];
    for (const pauseReason of all) {
      const beat = { phase: "paused", step: 1, filledOk: 0, filledFail: 0, pauseReason } as FlowProgress;
      expect(showsAdvanceGate(beat), pauseReason).toBe(USER_CLEARABLE_PAUSES.has(pauseReason));
    }
  });
});

describe("terminal re-scan before a page turn", () => {
  it("audits every page just before it is replaced", async () => {
    // A page turn is the last moment this page can be observed at all. A value
    // a framework reverted after the fill verified is invisible from the next
    // page — and per-write verification never sees it either, because it
    // happened after the write was checked.
    const { deps, log, progress } = makeDeps(
      [[field("a", "One")], [field("b", "Two")], []],
      [advanceBtn(), advanceBtn(), null]
    );
    const controller = new FlowController(deps);
    await drive(controller, progress);
    expect(log.filter((l) => l.startsWith("audit:"))).toEqual(["audit:0", "audit:1", "audit:2"]);
  });

  it("audits the final page, which never gets an advance click", async () => {
    const { deps, log, progress } = makeDeps([[field("a", "One")]], [terminalBtn()]);
    const controller = new FlowController(deps);
    await drive(controller, progress);
    // The submit page is the one the user is about to send.
    expect(log).toContain("audit:0");
  });

  it("audits before the click, not after — the page is gone afterwards", async () => {
    const { deps, log, progress } = makeDeps(
      [[field("a", "One")], []],
      [advanceBtn(), null]
    );
    const controller = new FlowController(deps);
    await drive(controller, progress);
    expect(log.indexOf("audit:0")).toBeLessThan(log.indexOf("click:0"));
  });

  it("an audit that throws never stops the flow", async () => {
    const { deps, progress } = makeDeps(
      [[field("a", "One")], [field("b", "Two")]],
      [advanceBtn(), terminalBtn()]
    );
    deps.auditPageState = async () => { throw new Error("scan blew up"); };
    const controller = new FlowController(deps);
    await drive(controller, progress);
    expect(progress.at(-1)?.phase).toBe("done");
  });

  it("still never clicks a terminal button", async () => {
    const { deps, log, progress } = makeDeps([[field("a", "One")]], [terminalBtn()]);
    const controller = new FlowController(deps);
    await drive(controller, progress);
    expect(log.some((l) => l.startsWith("click:"))).toBe(false);
  });
});
