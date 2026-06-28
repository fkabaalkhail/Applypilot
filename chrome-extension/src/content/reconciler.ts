/**
 * Layer C — Stability & Reconciliation. The autofill *core engine*.
 *
 * The DOM is unstable by default. This engine treats filling as continuous
 * reconciliation until the live DOM matches the canonical user data model, not
 * a one-shot write. Each field runs a small state machine:
 *
 *   discovered → mapped → filled → verified → stable
 *                            ↘ drifted ↗ (reapply)
 *
 * - Write + immediate read-back (Layer B), retried up to `maxWriteAttempts`.
 * - A field is only *complete* (`stable`) once it still verifies after the
 *   render/mutation settle window (300–800ms) — timing backs up the observer,
 *   it is never the sole correctness mechanism.
 * - Up to `maxCycles` reconciliation cycles; stop early when everything is
 *   settled. A single field that drifts is reapplied on its own, not via a
 *   full pipeline rerun.
 * - A MutationObserver gives drift *priority*: structural changes trigger an
 *   immediate reconcile pass that reverts affected fields to `mapped` and
 *   refills them.
 * - CAPTCHA is never bypassed and never blocks the form: the captcha widget is
 *   excluded at discovery (see captcha.ts / formScanner), and the engine fills
 *   every other field normally around it.
 * - Idempotent: verify-before-write means re-running never corrupts a field.
 */
import type { RuntimeControl } from "./formScanner";
import { verifyControl, writeControl } from "./writeEngine";

export type FieldStatus =
  | "discovered"
  | "mapped"
  | "filled"
  | "verified"
  | "stable"
  | "drifted";

export interface ReconcileTarget {
  fieldId: string;
  value: string;
}

export interface FieldReport {
  fieldId: string;
  status: FieldStatus;
  /** A field is only "ok" / complete once it is stable post-settle-window. */
  ok: boolean;
  reason?: string;
  attempts: number;
}

export interface ReconcilerOptions {
  /** Settle-window sleep. Injectable so tests run without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Fixed settle window in ms; defaults to a random value in [300, 800]. */
  settleWindowMs?: number;
  /** Max fill→verify cycles before reporting remaining drift. Default 3. */
  maxCycles?: number;
  /** Max write attempts per field within one cycle. Default 2. */
  maxWriteAttempts?: number;
  /** Whether to run a background MutationObserver. Default true. */
  observe?: boolean;
  /** Debounce for observer-triggered reconcile passes (ms). Default 120. */
  observerDebounceMs?: number;
  /** Scope for the background observer. Default: document. */
  root?: Document | ShadowRoot;
}

interface FieldState {
  fieldId: string;
  value: string;
  status: FieldStatus;
  attempts: number;
  reason?: string;
  /** Permanently unfillable this session (no matching option, stale, etc.). */
  terminal: boolean;
}

const PERMANENT_REASONS = [/cannot be scripted/i, /no option matches/i];

function isPermanent(reason: string | undefined): boolean {
  return Boolean(reason) && PERMANENT_REASONS.some((re) => re.test(reason as string));
}

export class AutofillReconciler {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly settleWindowMs?: number;
  private readonly maxCycles: number;
  private readonly maxWriteAttempts: number;
  private readonly observe: boolean;
  private readonly observerDebounceMs: number;
  private readonly root: Document | ShadowRoot;

  private states = new Map<string, FieldState>();
  private registry = new Map<string, RuntimeControl>();
  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling = false;
  private pending = false;

  constructor(options: ReconcilerOptions = {}) {
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.settleWindowMs = options.settleWindowMs;
    this.maxCycles = options.maxCycles ?? 3;
    this.maxWriteAttempts = options.maxWriteAttempts ?? 2;
    this.observe = options.observe ?? true;
    this.observerDebounceMs = options.observerDebounceMs ?? 120;
    this.root = options.root ?? document;
  }

  /**
   * Fill a set of mapped targets and reconcile until stable. Resolves after the
   * initial fill + stability confirmation so callers get honest per-field
   * outcomes; if `observe` is on, background reconciliation continues until
   * dispose().
   */
  async run(
    targets: ReconcileTarget[],
    registry: Map<string, RuntimeControl>
  ): Promise<FieldReport[]> {
    this.registry = registry;
    this.states = new Map(
      targets.map((t) => [
        t.fieldId,
        { fieldId: t.fieldId, value: t.value, status: "mapped" as FieldStatus, attempts: 0, terminal: false },
      ])
    );

    try {
      for (let cycle = 0; cycle < this.maxCycles; cycle++) {
        for (const s of this.active()) this.fillOnce(s);
        await this.sleep(this.window());
        this.confirmStability();
        if (this.allSettled()) break;
      }
      return this.reports();
    } finally {
      // Start background drift correction only after the initial pass, so the
      // observer never races the deterministic cycle logic above.
      if (this.observe) this.startObserver();
    }
  }

  /**
   * Add more targets and reconcile them WITHOUT discarding fields already being
   * tracked. Unlike run(), this merges into the existing `states` map, so a
   * second fill pass (e.g. AI answers after the local profile pass) does not
   * wipe drift-tracking of the first pass. Returns reports for the new targets.
   */
  async addTargets(
    targets: ReconcileTarget[],
    registry: Map<string, RuntimeControl>
  ): Promise<FieldReport[]> {
    this.registry = registry;
    const newIds = new Set(targets.map((t) => t.fieldId));
    for (const t of targets) {
      this.states.set(t.fieldId, {
        fieldId: t.fieldId,
        value: t.value,
        status: "mapped",
        attempts: 0,
        terminal: false,
      });
    }
    try {
      for (let cycle = 0; cycle < this.maxCycles; cycle++) {
        for (const s of this.active()) this.fillOnce(s);
        await this.sleep(this.window());
        this.confirmStability();
        if (this.allSettled()) break;
      }
      return this.reports().filter((r) => newIds.has(r.fieldId));
    } finally {
      if (this.observe) this.startObserver();
    }
  }

  /**
   * Point the engine at a freshly-scanned registry (ids are stable across
   * rescans). Lets background reconciliation keep tracking surviving controls
   * after the page re-renders, without restarting the fill.
   */
  updateRegistry(registry: Map<string, RuntimeControl>): void {
    this.registry = registry;
  }

  /**
   * One reconcile pass over the current targets: revert any field that no
   * longer verifies to `mapped`, refill the active ones, confirm stability.
   * Used for background drift correction and observer-triggered restarts.
   */
  async reconcileNow(): Promise<FieldReport[]> {
    if (this.states.size === 0) return [];
    for (const s of this.states.values()) {
      if (s.terminal) continue;
      const control = this.registry.get(s.fieldId);
      if (s.status === "stable" && (!control || !verifyControl(control, s.value))) {
        s.status = "mapped"; // drift detected — restart this field's reconciliation
      }
    }
    for (const s of this.active()) this.fillOnce(s);
    await this.sleep(this.window());
    this.confirmStability();
    return this.reports();
  }

  dispose(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // -- internals -------------------------------------------------------------

  /** Single write+verify attempt for one field, advancing its state machine. */
  private fillOnce(s: FieldState): void {
    const control = this.registry.get(s.fieldId);
    if (!control) {
      s.status = "drifted";
      s.reason = "Field no longer found — rescan the page";
      s.terminal = true;
      return;
    }
    if (verifyControl(control, s.value)) {
      s.status = "verified"; // already satisfied — idempotent no-op
      s.reason = undefined;
      return;
    }
    for (let attempt = 0; attempt < this.maxWriteAttempts; attempt++) {
      s.attempts++;
      s.status = "filled";
      const res = writeControl(control, s.value);
      if (!res.written) {
        s.status = "drifted";
        s.reason = res.reason;
        s.terminal = isPermanent(res.reason);
        return;
      }
      if (verifyControl(control, s.value)) {
        s.status = "verified";
        s.reason = undefined;
        return;
      }
    }
    s.status = "drifted";
    s.reason = "Value did not stick — fill manually";
  }

  /** Promote fields that survived the settle window; demote those that drifted. */
  private confirmStability(): void {
    for (const s of this.states.values()) {
      if (s.status !== "verified") continue;
      const control = this.registry.get(s.fieldId);
      s.status = control && verifyControl(control, s.value) ? "stable" : "drifted";
    }
  }

  private active(): FieldState[] {
    return [...this.states.values()].filter(
      (s) => !s.terminal && s.status !== "stable"
    );
  }

  private allSettled(): boolean {
    return [...this.states.values()].every((s) => s.status === "stable" || s.terminal);
  }

  private window(): number {
    return this.settleWindowMs ?? 300 + Math.floor(Math.random() * 500);
  }

  private reports(): FieldReport[] {
    return [...this.states.values()].map((s) => ({
      fieldId: s.fieldId,
      status: s.status,
      ok: s.status === "stable",
      reason: s.reason,
      attempts: s.attempts,
    }));
  }

  // -- observer --------------------------------------------------------------

  private startObserver(): void {
    if (this.observer) return;
    const target =
      this.root instanceof Document ? this.root.documentElement : this.root;
    this.observer = new MutationObserver(() => this.onMutations());
    this.observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  /** Mutations take priority: schedule a debounced reconcile pass. */
  private onMutations(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.reconcilePass();
    }, this.observerDebounceMs);
  }

  private async reconcilePass(): Promise<void> {
    if (this.reconciling) {
      this.pending = true;
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcileNow();
    } finally {
      this.reconciling = false;
      if (this.pending) {
        this.pending = false;
        void this.reconcilePass();
      }
    }
  }
}
