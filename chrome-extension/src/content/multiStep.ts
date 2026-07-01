/**
 * Multi-step form navigation (Workday et al.).
 *
 * Most of our engine fills the CURRENT page. Workday-style applications span many
 * pages, so page 1 fills and then stalls. This module drives the flow forward:
 * fill → click Next → confirm the page turned → re-fill, halting at the review /
 * submit step. It NEVER clicks submit — advancing an application past a page is
 * reversible; submitting it is not.
 *
 * The pure helpers (button classification, step reading, completion detection)
 * carry no timers or DOM side effects so they unit-test cleanly; the controller
 * takes injectable primitives for the same reason.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Text that marks a control as the FINAL submit — never auto-clicked. */
const SUBMIT_RE = /\b(submit|apply now|submit application|finish|send application|confirm and submit)\b/i;
/** Text that marks a control as "advance to the next page". Deliberately narrow:
 *  "review"/"proceed"/"confirm" are EXCLUDED because a single button labelled that
 *  way often submits — we would rather stop one page early than risk a submit. */
const NEXT_RE = /\b(next|continue|save and continue|save & continue|move on|next step|save and next)\b/i;
/** Workday's stable automation-ids for the footer nav buttons. */
const WD_NEXT_IDS = new Set(["pageFooterNextButton", "bottom-navigation-next-button"]);
const WD_SUBMIT_IDS = new Set(["pageFooterSubmitButton", "bottom-navigation-submit-button"]);

function labelOf(el: HTMLElement): string {
  return `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("value") ?? ""}`
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify a candidate button as the page-advance ("next") or the final
 * ("submit") control, or neither. Submit ALWAYS wins over next when a control
 * looks like both, so we never mistake Submit for Next.
 */
export function classifyNavButton(el: HTMLElement): "next" | "submit" | null {
  if ((el as HTMLButtonElement).disabled) return null;
  const autoId = (el.getAttribute("data-automation-id") ?? "").trim();
  if (WD_SUBMIT_IDS.has(autoId)) return "submit";
  if (WD_NEXT_IDS.has(autoId)) return "next";
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const isButton = el.tagName === "BUTTON" || role === "button" || (el as HTMLInputElement).type === "submit";
  if (!isButton) return null;
  const label = labelOf(el);
  if (!label) return null;
  if (SUBMIT_RE.test(label)) return "submit"; // submit beats next
  if (NEXT_RE.test(label)) return "next";
  return null;
}

/** The advance button and the submit button currently on the page, if any. */
export function findNavButtons(root: ParentNode): {
  next: HTMLElement | null;
  submit: HTMLElement | null;
} {
  let next: HTMLElement | null = null;
  let submit: HTMLElement | null = null;
  const candidates = root.querySelectorAll<HTMLElement>(
    'button, [role="button"], input[type="submit"]'
  );
  for (const el of candidates) {
    const kind = classifyNavButton(el);
    if (kind === "submit" && !submit) submit = el;
    else if (kind === "next" && !next) next = el;
  }
  return { next, submit };
}

export interface StepInfo {
  index: number;
  total: number;
  title: string;
}

/** Read Workday's progress bar: active step index / total / lowercased title. */
export function readWorkdayStep(root: ParentNode): StepInfo | null {
  const bar = root.querySelector('[data-automation-id="progressBar"]');
  if (!bar) return null;
  const steps = Array.from(bar.querySelectorAll('[data-automation-id="progressBarStepIcon"]'));
  const active = bar.querySelector('[data-automation-id="progressBarActiveStep"]');
  const total = steps.length;
  let index = -1;
  if (active) {
    // Prefer explicit index, else position among step icons.
    const attr = active.getAttribute("data-automation-id-index") ?? active.getAttribute("aria-posinset");
    index = attr ? Number(attr) - 1 : steps.indexOf(active as Element);
  }
  const title = (active?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (total === 0 && !active) return null;
  return { index, total, title };
}

/** The review/summary step, where auto-continue must stop (submit is next). */
export function isReviewStep(title: string): boolean {
  return /\breview\b|\bsummary\b|self\s*identif/i.test(title);
}

/**
 * Generic review/terminal-step detection for non-Workday forms (no progress bar):
 * a visible heading or step marker naming review/summary, OR a submit button on
 * the page. Either means "do not auto-advance" — the next click could submit.
 */
export function looksLikeTerminalStep(root: ParentNode): boolean {
  const wdStep = readWorkdayStep(root);
  if (wdStep && isReviewStep(wdStep.title)) return true;
  const headings = root.querySelectorAll(
    'h1, h2, h3, [aria-current="step"], [class*="step" i][class*="active" i], [class*="active" i][class*="step" i]'
  );
  for (const h of headings) {
    if (isReviewStep((h.textContent ?? "").toLowerCase())) return true;
  }
  // A submit button present on THIS page is a strong terminal-step signal.
  return !!findNavButtons(root).submit;
}

/** Has the application been submitted / completed? Then there is nothing to do. */
export function isApplicationComplete(loc: { pathname?: string }, root: ParentNode): boolean {
  if (loc.pathname && /jobtasks\/completed|application\/(complete|submitted)|thank[-_]?you/i.test(loc.pathname)) {
    return true;
  }
  const h = root.querySelector("h1, h2");
  return !!h && /congratulations|application (submitted|received|complete)|thank you for applying/i.test(h.textContent ?? "");
}

/** A stable signature of the current step, to detect that the page actually turned. */
export function stepSignature(root: ParentNode, loc: { pathname?: string; href?: string }): string {
  const step = readWorkdayStep(root);
  if (step) return `wd:${step.index}:${step.title}`;
  // Generic fallback: path + a coarse field fingerprint (count + first labels).
  const fields = Array.from(root.querySelectorAll("input, select, textarea")).slice(0, 40);
  const names = fields.map((f) => f.getAttribute("name") || f.getAttribute("id") || "").join(",");
  return `url:${loc.pathname ?? loc.href ?? ""}|n:${fields.length}|${names}`.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface MultiStepDeps {
  /** Re-scan + fill the current page; resolves when the fill has settled. */
  fillCurrentPage: () => Promise<void>;
  /** Current step signature (to detect a page turn). */
  signature: () => string;
  /** The advance/submit buttons currently present. */
  navButtons: () => { next: HTMLElement | null; submit: HTMLElement | null };
  /** True at the review/summary step (stop — do not advance into submit). */
  atReviewStep: () => boolean;
  /** True once the application is complete. */
  isComplete: () => boolean;
  /** Click a button (its own handler advances the SPA). */
  click: (el: HTMLElement) => void;
  /** Sleep (injectable for tests). */
  sleep: (ms: number) => Promise<void>;
  /** Optional progress log. */
  log?: (msg: string) => void;
}

export interface MultiStepOptions {
  /** Max pages to advance through (safety bound). */
  maxPages?: number;
  /** How long to wait for the page to turn after clicking Next. */
  advanceWaitMs?: number;
  /** Poll interval while waiting for the turn. */
  pollMs?: number;
}

export interface MultiStepResult {
  pagesFilled: number;
  stoppedReason: "review" | "complete" | "no-next" | "no-advance" | "max-pages";
}

const MS_DEFAULTS = { maxPages: 15, advanceWaitMs: 8000, pollMs: 300 };

/**
 * Fill the current page, then repeatedly advance and re-fill until the review
 * step, completion, or a bound is hit. Returns why it stopped. Never submits.
 */
export async function runMultiStep(
  deps: MultiStepDeps,
  opts: MultiStepOptions = {}
): Promise<MultiStepResult> {
  const maxPages = opts.maxPages ?? MS_DEFAULTS.maxPages;
  const advanceWaitMs = opts.advanceWaitMs ?? MS_DEFAULTS.advanceWaitMs;
  const pollMs = opts.pollMs ?? MS_DEFAULTS.pollMs;
  const log = deps.log ?? (() => {});

  let pagesFilled = 0;
  for (let page = 0; page < maxPages; page++) {
    if (deps.isComplete()) return { pagesFilled, stoppedReason: "complete" };

    await deps.fillCurrentPage();
    pagesFilled++;

    if (deps.atReviewStep()) {
      log("Reached the review step — stopping before submit.");
      return { pagesFilled, stoppedReason: "review" };
    }

    const { next, submit } = deps.navButtons();
    // A submit button on this page means it is the terminal step — never advance
    // past it (this is the primary guard on non-Workday forms with no progress bar).
    if (submit) {
      log("Submit button present — stopping before the final step.");
      return { pagesFilled, stoppedReason: "review" };
    }
    if (!next) {
      log("No Next button — stopping (review, or a single-page form).");
      return { pagesFilled, stoppedReason: "no-next" };
    }

    const before = deps.signature();
    deps.click(next);

    // Confirm the page actually turned before filling again — otherwise a
    // validation error kept us in place and re-filling would loop.
    const turned = await waitForChange(() => deps.signature() !== before, deps.sleep, advanceWaitMs, pollMs);
    if (!turned) {
      log("Page did not advance (likely a validation error) — stopping.");
      return { pagesFilled, stoppedReason: "no-advance" };
    }
  }
  return { pagesFilled, stoppedReason: "max-pages" };
}

async function waitForChange(
  probe: () => boolean,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
  pollMs: number
): Promise<boolean> {
  let elapsed = 0;
  for (;;) {
    if (probe()) return true;
    if (elapsed >= budgetMs) return false;
    await sleep(pollMs);
    elapsed += pollMs;
  }
}
