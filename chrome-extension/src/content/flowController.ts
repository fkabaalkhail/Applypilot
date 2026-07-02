/**
 * Multi-page autofill flow: fill → advance → fill → … → done/paused/stopped.
 *
 * Pure orchestration over injected deps — no chrome.*, no direct DOM writes —
 * so the whole machine unit-tests with scripted fakes. contentScript provides
 * the real deps (fillOnce, scanner snapshots, advance discovery, background
 * state persistence) and the overlay renders the progress beats.
 *
 * Invariants:
 *  - NEVER clicks a terminal (submit-like) button — finishes "done" instead.
 *  - Persists FlowState BEFORE clicking advance, so a real navigation (content
 *    script death) resumes on the next page via the session flag.
 *  - Every pause auto-resumes when its condition clears (polled).
 *  - Runaway guards: MAX_STEPS, FLOW_TTL_MS, and a same-signature loop check.
 */
import type {
  DetectedField,
  FlowPauseReason,
  FlowPhase,
  FlowProgress,
  FlowState,
} from "../shared/types";
import type { AdvanceButton } from "./advance";

export const MAX_STEPS = 12;
export const FLOW_TTL_MS = 10 * 60 * 1000;
const PAUSE_POLL_MS = 2000;
const ADVANCE_POLL_MS = 500;
const ADVANCE_WAIT_MS = 8000;

export interface StepTally {
  ok: number;
  fail: number;
  total: number;
}

export interface FlowSnapshot {
  fields: DetectedField[];
  scopeEl: HTMLElement | null;
}

export interface FlowDeps {
  /** One full fill pass (fillOnce). null ids → default selection this step. */
  fillStep(ids: string[] | null): Promise<StepTally>;
  snapshot(): FlowSnapshot;
  /** Force a fresh scan (updates what snapshot() returns). */
  rescan(): void;
  findAdvance(scope: HTMLElement, extraAdvance?: RegExp): AdvanceButton | null;
  clickAdvance(el: HTMLElement): void;
  /** Account-wall handling (Phase 4); {} when no wall. */
  accountStep(snap: FlowSnapshot): Promise<{ extraAdvance?: RegExp }>;
  /** First blocking condition, or null when clear (captcha/validation/…). */
  pauseReason(snap: FlowSnapshot): Promise<FlowPauseReason | null>;
  /** True when a required résumé field needs a file. */
  needsResume(snap: FlowSnapshot): boolean;
  /** Try to attach the user's résumé; false → pause until the user does. */
  attachResume(): Promise<boolean>;
  setState(state: FlowState | null): Promise<void>;
  onProgress(p: FlowProgress): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Order-independent hash of the scanned field set — step-change detection. */
export function fieldSignature(fields: DetectedField[]): string {
  const s = fields
    .map((f) => `${f.category}|${f.label}|${f.controlType}`)
    .sort()
    .join("\n");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${fields.length}:${(h >>> 0).toString(16)}`;
}

export class FlowController {
  private stopRequested = false;
  private step = 0;
  private startedAt = 0;
  private lastTally = { ok: 0, fail: 0 };
  /** Resolver for the "ready" gate while the flow awaits the user's Next page. */
  private advanceResolver: ((advance: boolean) => void) | null = null;

  constructor(private deps: FlowDeps) {}

  /** User pressed Stop (or a new flow replaces this one). Idempotent. */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    // Release a pending ready-gate so run() can unwind as stopped.
    const resolve = this.advanceResolver;
    this.advanceResolver = null;
    resolve?.(false);
    void this.deps.setState(null);
  }

  /**
   * User pressed "Next page" — release the ready gate so the flow advances to
   * the next page. No-op when the flow is not currently parked at a gate.
   */
  notifyAdvanceRequested(): void {
    const resolve = this.advanceResolver;
    this.advanceResolver = null;
    resolve?.(true);
  }

  /**
   * Run from `initial` (fresh click: step 0; navigation resume: persisted
   * state). `firstTally` carries the fill the panel already awaited, so the
   * first step is not filled twice.
   */
  async run(initial: FlowState, firstTally: StepTally | null): Promise<void> {
    this.step = initial.step;
    this.startedAt = initial.startedAt || this.deps.now();
    let state: FlowState = { ...initial, startedAt: this.startedAt };
    await this.deps.setState(state);
    let pending = firstTally;

    while (!this.stopRequested) {
      if (this.step >= MAX_STEPS) return this.finish("stopped", "Step limit reached — review the page");
      if (this.expired()) return this.finish("stopped", "Flow timed out");

      const account = await this.deps.accountStep(this.deps.snapshot());

      const tally = pending ?? (await this.deps.fillStep(null));
      pending = null;
      // Cumulative across steps — the final "done" beat reports the whole flow.
      this.lastTally = { ok: this.lastTally.ok + tally.ok, fail: this.lastTally.fail + tally.fail };
      this.emit("filling");

      if (this.deps.needsResume(this.deps.snapshot()) && !(await this.deps.attachResume())) {
        // attachResume failed (no résumé on file) — wait for a manual attach.
      }
      if (!(await this.waitWhileBlocked())) return this.finishStopped();

      const snap = this.deps.snapshot();
      if (!snap.scopeEl) return this.finish("done");
      const adv = this.deps.findAdvance(snap.scopeEl, account.extraAdvance);
      if (!adv) return this.finish("done");
      if (adv.kind === "terminal") return this.finish("done", "Ready to review and submit");

      // Page filled — hand control back to the user. The flow parks here until
      // the panel's "Next page" button calls notifyAdvanceRequested() (or Stop).
      // A blocking condition (e.g. a captcha) may have re-appeared while the
      // user reviewed, so re-check it once before clicking advance.
      this.emit("ready");
      if (!(await this.waitForAdvanceRequest())) return this.finishStopped();
      if (!(await this.waitWhileBlocked())) return this.finishStopped();

      const before = fieldSignature(snap.fields);
      state = { active: true, step: this.step + 1, startedAt: this.startedAt, lastSignature: before };
      this.step = state.step;
      await this.deps.setState(state); // BEFORE the click — survives navigation
      this.emit("advancing");
      this.deps.clickAdvance(adv.el);

      if (!(await this.waitForChange(before))) {
        // Click rejected (validation) or this page genuinely can't advance.
        // NB: this pre-check consumes one pauseReason() poll, so emit the
        // pause beat here — waitWhileBlocked may find the reason already clear.
        if ((await this.deps.pauseReason(this.deps.snapshot())) === "validation") {
          this.emit("paused", { pauseReason: "validation" });
          if (!(await this.waitWhileBlocked())) return this.finishStopped();
          this.step -= 1; // retry the same page without burning a step
          continue;
        }
        return this.finish("stopped", "Couldn't advance past this page");
      }
    }
    return this.finishStopped();
  }

  // -------------------------------------------------------------------------

  private expired(): boolean {
    return this.deps.now() - this.startedAt > FLOW_TTL_MS;
  }

  private emit(phase: FlowPhase, extra: Partial<FlowProgress> = {}): void {
    this.deps.onProgress({
      phase,
      step: this.step,
      filledOk: this.lastTally.ok,
      filledFail: this.lastTally.fail,
      ...extra,
    });
  }

  private async finish(phase: "done" | "stopped", detail?: string): Promise<void> {
    await this.deps.setState(null);
    this.emit(phase, { detail });
  }

  private finishStopped(): Promise<void> {
    return this.finish("stopped", "Autofill flow stopped");
  }

  /** Park at the ready gate until notifyAdvanceRequested() (true) or stop() (false). */
  private waitForAdvanceRequest(): Promise<boolean> {
    if (this.stopRequested) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.advanceResolver = resolve;
    });
  }

  /** Poll pauseReason until clear. False → stopped/expired. */
  private async waitWhileBlocked(): Promise<boolean> {
    let current: FlowPauseReason | null = null;
    for (;;) {
      if (this.stopRequested) return false;
      if (this.expired()) {
        await this.finish("stopped", "Flow timed out");
        return false;
      }
      const reason = await this.deps.pauseReason(this.deps.snapshot());
      if (!reason) return true;
      if (reason !== current) {
        current = reason;
        this.emit("paused", { pauseReason: reason });
      }
      await this.deps.sleep(PAUSE_POLL_MS);
    }
  }

  /** After an advance click: rescan until the field set changes. */
  private async waitForChange(before: string): Promise<boolean> {
    for (let waited = 0; waited < ADVANCE_WAIT_MS; waited += ADVANCE_POLL_MS) {
      if (this.stopRequested) return false;
      await this.deps.sleep(ADVANCE_POLL_MS);
      this.deps.rescan();
      if (fieldSignature(this.deps.snapshot().fields) !== before) return true;
    }
    return false;
  }
}
