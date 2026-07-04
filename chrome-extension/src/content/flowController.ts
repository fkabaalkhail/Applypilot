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
  /** Page URL at snapshot time — the change signal on field-less entry pages. */
  url: string;
  /** Apply-entry button (job posting / apply-method chooser), when one exists. */
  entry: { el: HTMLElement; label: string } | null;
  /** True while a signup/login account wall is on the page — lets the flow
   *  hand a stuck wall back to the user instead of stopping the whole flow. */
  accountWall: boolean;
}

export interface FlowDeps {
  /** One full fill pass (fillOnce). null ids → default selection this step. */
  fillStep(ids: string[] | null): Promise<StepTally>;
  snapshot(): FlowSnapshot;
  /** Force a fresh scan (updates what snapshot() returns). */
  rescan(): void;
  findAdvance(scope: HTMLElement, extraAdvance?: RegExp): AdvanceButton | null;
  clickAdvance(el: HTMLElement): void;
  /** The flow reached the terminal (submit) button — hand it over so the caller
   *  can bind submit tracking. NEVER clicked by the controller. */
  onTerminal?(el: HTMLElement): void;
  /** Account-wall handling (Phase 4); {} when no wall. `wall` reports the kind
   *  so progress beats can say "creating account…" / "signing in…". */
  accountStep(snap: FlowSnapshot): Promise<{ extraAdvance?: RegExp; wall?: "signup" | "login" }>;
  /** First blocking condition, or null when clear (captcha/validation/…). */
  pauseReason(snap: FlowSnapshot): Promise<FlowPauseReason | null>;
  /** True when a required résumé field needs a file. */
  needsResume(snap: FlowSnapshot): boolean;
  /** True when a required field on this page is still empty (pause on issues). */
  hasUnfilledRequired(snap: FlowSnapshot): boolean;
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

/**
 * The "did the page change?" signal for one step. Field-less pages (job
 * posting, apply-method chooser) all hash to the same fieldSignature, so there
 * the URL + entry-button label stand in — an SPA that swaps "Apply" for
 * "Apply Manually" without navigating still reads as a new page.
 */
export function stepSignature(snap: FlowSnapshot): string {
  if (snap.fields.length > 0) return fieldSignature(snap.fields);
  return `page:${snap.url}|${snap.entry?.label ?? ""}`;
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
    const state: FlowState = { ...initial, startedAt: this.startedAt };
    await this.deps.setState(state);
    let pending = firstTally;

    while (!this.stopRequested) {
      if (this.step >= MAX_STEPS) return this.finish("stopped", "Step limit reached — review the page");
      if (this.expired()) return this.finish("stopped", "Flow timed out");

      const account = await this.deps.accountStep(this.deps.snapshot());
      const wallDetail =
        account.wall === "signup" ? "creating account…" : account.wall === "login" ? "signing in…" : undefined;

      const tally = pending ?? (await this.deps.fillStep(null));
      pending = null;
      // Cumulative across steps — the final "done" beat reports the whole flow.
      this.lastTally = { ok: this.lastTally.ok + tally.ok, fail: this.lastTally.fail + tally.fail };
      this.emit("filling", { detail: wallDetail });

      if (this.deps.needsResume(this.deps.snapshot()) && !(await this.deps.attachResume())) {
        // attachResume failed (no résumé on file) — wait for a manual attach.
      }
      if (!(await this.waitWhileBlocked())) return this.finishStopped();

      const snap = this.deps.snapshot();
      const recognized = snap.fields.filter((f) => f.category !== "unknown").length;
      const adv = snap.scopeEl ? this.deps.findAdvance(snap.scopeEl, account.extraAdvance) : null;
      const advText = adv ? (adv.el.getAttribute("aria-label") || adv.el.textContent || "").trim().slice(0, 40) : "";
      console.log(`[Tailrd flow] step ${this.step}: ${snap.fields.length} fields, advance=${adv ? `${adv.kind} "${advText}"` : "NONE"}`);
      if (!adv) {
        // No advance inside a form scope. On a page with no recognized fields,
        // an apply-entry button (job posting "Apply", chooser "Apply Manually")
        // is the way forward — click it and treat the transition as a step.
        if (recognized === 0 && snap.entry) {
          console.log(`[Tailrd flow] clicking apply entry "${snap.entry.label}"…`);
          if (!(await this.advanceStep(snap, snap.entry.el, `opening "${snap.entry.label}"…`))) {
            if (this.stopRequested) return this.finishStopped();
            return this.finish("stopped", "Couldn't open the application from this page");
          }
          continue;
        }
        if (!snap.scopeEl && recognized === 0) {
          return this.finish("stopped", "No application form found on this page");
        }
        console.log("[Tailrd flow] no advance button — finishing done");
        return this.finish("done");
      }
      if (adv.kind === "terminal") {
        // Reached the real submit button — hand it to the caller for submit
        // tracking, then finish. The controller itself never clicks it.
        this.deps.onTerminal?.(adv.el);
        return this.finish("done", "Ready to review and submit");
      }

      // Auto-advance when the page is clean; pause for the user only on an issue.
      // Unfilled required fields would fail the site's own validation, so we stop
      // and let the user fill them (or force-advance via the Next page button).
      // A blocker (e.g. a captcha) may also have re-appeared while filling, so
      // re-check that below before clicking advance.
      if (this.deps.hasUnfilledRequired(snap)) {
        console.log("[Tailrd flow] paused — required field(s) still empty; press Next page to advance anyway");
        this.emit("paused", { pauseReason: "unfilled-required", nextLabel: advText || undefined });
        if (!(await this.waitForAdvanceRequest())) return this.finishStopped();
      }
      if (!(await this.waitWhileBlocked())) return this.finishStopped();

      console.log(`[Tailrd flow] clicking advance "${advText}"…`);
      if (!(await this.advanceStep(snap, adv.el, wallDetail))) {
        if (this.stopRequested) return this.finishStopped();
        // An account wall that didn't advance means auto-signup/sign-in
        // couldn't complete on its own — a password the site rejected, an
        // unmet requirement, an email-verification/2FA step, a captcha inside
        // the account form. Hand it to the user and resume when they clear it,
        // instead of killing the whole flow.
        if (account.wall) {
          console.log("[Tailrd flow] account wall didn't advance — pausing for the user to finish");
          this.emit("paused", { pauseReason: "account" });
          if (!(await this.waitForWallCleared())) return this.finishStopped();
          this.step -= 1; // re-attempt the step now that the wall is gone
          continue;
        }
        // Click rejected (validation) or this page genuinely can't advance.
        // NB: this pre-check consumes one pauseReason() poll, so emit the
        // pause beat here — waitWhileBlocked may find the reason already clear.
        const reason = await this.deps.pauseReason(this.deps.snapshot());
        console.log(`[Tailrd flow] couldn't advance; pauseReason=${reason ?? "none"}`);
        if (reason === "validation") {
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

  /**
   * One page transition: persist the NEXT step's state (before the click, so a
   * real navigation resumes there), emit the advancing beat, click, and wait
   * for the page to change. False → the page never changed (or we stopped).
   */
  private async advanceStep(snap: FlowSnapshot, el: HTMLElement, detail?: string): Promise<boolean> {
    const before = stepSignature(snap);
    const state: FlowState = { active: true, step: this.step + 1, startedAt: this.startedAt, lastSignature: before };
    this.step = state.step;
    await this.deps.setState(state); // BEFORE the click — survives navigation
    this.emit("advancing", { detail });
    this.deps.clickAdvance(el);
    const changed = await this.waitForChange(before);
    console.log(`[Tailrd flow] page changed after advance = ${changed}`);
    return changed;
  }

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

  /** Park while an account wall the flow couldn't auto-pass is still on screen.
   *  Resolves true when the user clears it (wall gone, or the page moved on);
   *  false on stop/expiry. Rescans each poll so a real navigation (or an SPA
   *  step change) is noticed. */
  private async waitForWallCleared(): Promise<boolean> {
    for (;;) {
      if (this.stopRequested) return false;
      if (this.expired()) {
        await this.finish("stopped", "Flow timed out");
        return false;
      }
      await this.deps.sleep(PAUSE_POLL_MS);
      this.deps.rescan();
      const snap = this.deps.snapshot();
      if (!snap.accountWall) return true;
    }
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

  /** After an advance click: rescan until the page (fields, or URL/entry on
   *  field-less pages) changes. */
  private async waitForChange(before: string): Promise<boolean> {
    for (let waited = 0; waited < ADVANCE_WAIT_MS; waited += ADVANCE_POLL_MS) {
      if (this.stopRequested) return false;
      await this.deps.sleep(ADVANCE_POLL_MS);
      this.deps.rescan();
      if (stepSignature(this.deps.snapshot()) !== before) return true;
    }
    return false;
  }
}
