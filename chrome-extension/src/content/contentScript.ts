/**
 * Content script entry point.
 *
 * Runs in every frame of supported ATS pages (declared in the manifest) and
 * is injected on demand into any other page via the popup's Scan button.
 *
 * Two ways it is used:
 *  1. Autonomously — on the top frame it scans for an application form and,
 *     when fields are found, mounts the in-page overlay (FAB + full popup UI).
 *  2. On demand — the toolbar popup sends SCAN_PAGE / FILL_FIELDS messages.
 *
 * Frame coordination: chrome.tabs.sendMessage broadcasts to all frames but
 * resolves with the FIRST response. We exploit that deliberately:
 *  - SCAN: frames that found fields answer immediately; empty frames answer
 *    after a delay, so a form living inside an iframe (embedded Greenhouse)
 *    wins the race over an empty top frame.
 *  - FILL: field ids are prefixed with a per-frame token, so only the frame
 *    that owns the fields responds.
 */
import type {
  AiFillResponse,
  ApplicationLog,
  BackgroundRequest,
  ContentRequest,
  CoverLetterGenOpts,
  DetectedField,
  FieldsUpdatedEvent,
  FillResponse,
  FlowProgress,
  FlowState,
  FlowStateResponse,
  FormOpName,
  FormOpResult,
  JobContext,
  OverridesResponse,
  GenerateCoverLetterResponse,
  PingResponse,
  RecordApplicationResponse,
  AccessTokenResponse,
  RenderCoverLetterResponse,
  RenderResumeResponse,
  ResumeDoc,
  ResumeFileResponse,
  ResumeSummary,
  ResumesResponse,
  ScanResponse,
  SimpleResponse,
  TailorResumeOpts,
  TailorResumeResponse,
  UserApplicationProfile,
} from "../shared/types";
import { deepQueryAll, isVisible, cleanText } from "./domUtils";
import { base64ToFile, downloadBase64File, injectResumeFile, type UploadResult } from "./fileUpload";
import { openAiModal } from "./aiModalBridge";
import { getLastJobContext, saveLastJobContext } from "../shared/storage";

const MIN_CACHEABLE_DESC = 200;
import { FRAME_TOKEN, observePage, scanPage, selectOptions, type RuntimeControl } from "./formScanner";
import { LONG_TEXT, normalize } from "./fieldMatcher";
import { getLocalAnswers } from "./localAnswers";
import { customFieldAnswers, getExtras } from "./autofillExtras";
import { AutofillReconciler, type FieldReport } from "./reconciler";
import { defaultSelectedIds } from "../shared/selection";
import { extractJobContext, extractJobIdentity } from "./jobContext";
import { aiFillCandidates, isBoolish, needsOptionHarvest, planAiFill, planFillRoute, planReaskFields, tallyOutcomes, toAiFillField, type PlannedAnswer, type ReaskCandidate } from "./aiFillPlanner";
import { closestDemographicOption } from "./demographicMatch";
import { toApplicantProfile } from "./applicantProfile";
import { splitByCache, cacheAnswers } from "./answerCache";
import { AUTOFILL_CONFIDENCE_THRESHOLD } from "../shared/constants";
import { activateElement, fillAriaCombobox, harvestComboboxOptions, readComboboxValue } from "./comboboxEngine";
import { SECTION_KINDS, MAX_ROWS, rowsPresent, rowsNeeded, findAddButton } from "./repeatingSections";
import { driveField, setDialogSuppression } from "./mainWorldClient";
import { dispatchFormOp, makeProxyCallbacks, shouldAdoptRemoteHost } from "./crossFrame";
import { verifyControl, writeControl } from "./writeEngine";
import {
  showOverlay,
  updateOverlay,
  toggleOverlay,
  updateFlowProgress,
  type OverlayCallbacks,
} from "./overlay";
import { runAdapterOperations, type SiteAdapter } from "./adapters";
import { detectSite } from "./siteRegistry";
import { FlowController, FLOW_TTL_MS, type FlowDeps, type FlowSnapshot, type StepTally } from "./flowController";
import { clickAdvance, findAdvanceButton } from "./advance";
import { findApplyEntry } from "./applyEntry";
import { hasUnsolvedCaptcha, isVerificationWall, resumeFieldNeedingFile, validationMessages } from "./flowChecks";
import { detectWall, findSignupToggle, runAccountWall } from "./accountFlow";
import { getCredential } from "./credentialStore";
import { bindSubmitTracking, type SubmitTrackerHandle } from "./submitTracker";
import { buildAutofillTelemetry } from "./telemetry";
import { setOverrideRules } from "./overrides";
import { onExtensionContextInvalidated, postToRuntime, sendToRuntime } from "./runtimeMessaging";

// Guard against double injection (manifest match + programmatic inject).
declare global {
  interface Window {
    __apContentScriptLoaded?: boolean;
  }
}

/** Show the overlay after detecting at least this many recognizable fields. */
const MIN_FIELDS_FOR_OVERLAY = 1;

/**
 * Attach a downloaded résumé/cover file to `el`. When the site's upload can't be
 * scripted at all (a custom button that opens a native picker with no persistent
 * <input type=file> — SAP SuccessFactors), download the file so the user can pick
 * it in the site's own dialog, and say so.
 */
async function attachOrGuide(el: HTMLElement, dataBase64: string, name: string, contentType: string): Promise<UploadResult> {
  const result = await injectResumeFile(el, base64ToFile(dataBase64, name, contentType));
  if (!result.manual) return result;
  downloadBase64File(dataBase64, name, contentType);
  return {
    ok: false,
    reason: `This site opens its own file picker — I downloaded "${name}" to your Downloads. Click the page's upload button and choose it.`,
  };
}

if (!window.__apContentScriptLoaded) {
  window.__apContentScriptLoaded = true;
  initialize();
}

function sendToBackground<T>(message: BackgroundRequest): Promise<T> {
  // Routed through the context-safe sender: after an extension reload this
  // content script is orphaned and a raw sendMessage throws synchronously.
  return sendToRuntime<T>(message) as Promise<T>;
}

// --- TEMP diagnostics (remove before shipping) ------------------------------
// Logs, per frame, what the scanner actually sees so we can tell whether the
// form is missed entirely, partially detected, or living in a cross-origin
// iframe the panel can't reach. Deduped so dynamic pages don't spam.
let lastScanSig = "";
function logScanDiagnostics(
  isTopFrame: boolean,
  fields: DetectedField[],
  profileLoaded: boolean
): void {
  try {
    const rawControls = deepQueryAll(document, "input, textarea, select").length;
    const iframes = Array.from(document.querySelectorAll("iframe"));
    let crossOrigin = 0;
    for (const f of iframes) {
      try {
        if (!f.contentDocument) crossOrigin++;
      } catch {
        crossOrigin++;
      }
    }
    const withValue = fields.filter((f) => f.proposedValue !== null).length;
    const wouldAutoSelect = defaultSelectedIds(fields).size;
    const sig = `${rawControls}|${fields.length}|${withValue}|${wouldAutoSelect}|${profileLoaded}|${crossOrigin}`;
    if (sig === lastScanSig) return; // only log when the picture changes
    lastScanSig = sig;
    console.log(
      `[Tailrd scan] frame=${isTopFrame ? "TOP" : "child"} url=${location.href.slice(0, 90)}`,
      {
        rawControlsSeen: rawControls,
        detectedFields: fields.length,
        profileLoaded, // did a profile reach the scanner?
        withProposedValue: withValue, // fields the profile produced a value for
        wouldAutoSelect, // fields the Autofill button would act on (drives enable/count)
        iframesOnPage: iframes.length,
        crossOriginIframes: crossOrigin,
      }
    );
  } catch {
    // diagnostics must never break scanning
  }
}

/** Turn a reconciliation report into the popup's per-field outcome shape. */
function reportToOutcome(r: FieldReport): { fieldId: string; ok: boolean; reason?: string } {
  if (r.ok) return { fieldId: r.fieldId, ok: true };
  return { fieldId: r.fieldId, ok: false, reason: r.reason ?? "Could not fill — please check manually" };
}

/**
 * Resolve once the page DOM has been structurally quiet for `quietMs`, or after
 * `capMs` regardless. React ATS (Workday) mount a loading skeleton and re-render
 * the form section repeatedly as they hydrate — scanning/filling during that
 * churn captures throwaway controls that detach mid-write ("Field no longer
 * found" — the #1 live Workday failure) or get their values wiped by the next
 * render. Waiting for quiescence lets us scan and fill the real, settled form.
 * Bounded, so a page that never fully settles (animations, polling widgets)
 * still proceeds. Aborts immediately when the fill is cancelled.
 */
function waitForDomSettle(signal?: AbortSignal, quietMs = 400, capMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let quiet: ReturnType<typeof setTimeout>;
    let cap: ReturnType<typeof setTimeout>;
    let obs: MutationObserver;
    const done = (): void => {
      obs.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const bump = (): void => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    };
    obs = new MutationObserver(bump);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    quiet = setTimeout(done, quietMs);
    cap = setTimeout(done, capMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Log why an advance click left the page put — the real blocker on live ATS
 * (Workday et al.): a visible validation error, or a required field the fill
 * couldn't complete, is what makes a page refuse to advance (for the extension
 * AND a manual click). Best-effort; never throws. deepQueryAll already skips the
 * extension's own UI.
 */
function logStuckDiagnostics(): void {
  try {
    const errors = deepQueryAll(
      document.body,
      '[role="alert"], [aria-live="assertive"], [aria-invalid="true"], [class*="error" i], [data-automation-id*="error" i]'
    )
      .filter((el) => isVisible(el))
      .map((el) => cleanText(el.textContent))
      .filter((t) => t.length > 0 && t.length < 200);

    const emptyRequired = deepQueryAll(
      document.body,
      'input[required], select[required], textarea[required], [aria-required="true"]'
    )
      .filter((el) => isVisible(el))
      .filter((el) => {
        const input = el as HTMLInputElement;
        if (input.type === "checkbox" || input.type === "radio") return !input.checked;
        return !(input.value && input.value.trim());
      })
      .map(
        (el) =>
          cleanText(el.getAttribute("aria-label")) ||
          cleanText(el.closest("label")?.textContent) ||
          (el as HTMLInputElement).name ||
          el.getAttribute("data-automation-id") ||
          "(unlabeled)"
      );

    console.log(
      "[Tailrd stuck] page did not advance —",
      "visible errors:", JSON.stringify([...new Set(errors)].slice(0, 6)),
      "| empty required fields:", JSON.stringify([...new Set(emptyRequired)].slice(0, 10))
    );
  } catch (err) {
    console.log("[Tailrd stuck] diagnostic failed:", err instanceof Error ? err.message : err);
  }
}

function initialize(): void {
  let registry: Map<string, RuntimeControl> = new Map();
  let lastAdapter: SiteAdapter | null = null;
  let lastFields: DetectedField[] = [];
  let lastScope: HTMLElement | null = null;
  let flowController: FlowController | null = null;
  /** Bumped on every Stop so an in-flight initial fill can detect it lost the
   *  race and must not start a controller. See onAutofill / onFlowStop. */
  let flowGeneration = 0;
  /** The panel's picked upload résumé for this flow (auto-attach preference). */
  let flowResumeId: number | null = null;
  // A login wall we have no credentials for — pauses the flow until it clears.
  let accountBlocked = false;
  // Submit tracking: bound to the terminal (submit) button once the flow reaches
  // it, so the application is recorded when the USER submits. Never auto-clicked.
  let submitTracker: SubmitTrackerHandle | null = null;
  let trackedButton: HTMLElement | null = null;
  let lastRecordedUrl: string | null = null;
  // Aborts an in-flight fill the instant the user hits Stop (or a new flow
  // supersedes this one), so a running fillOnce stops writing promptly instead
  // of running to completion — Jobright's CANCEL_AUTO_FILL parity.
  let flowAbort: AbortController | null = null;
  // Remembered so MutationObserver rescans can recompute proposed values.
  let lastProfile: UserApplicationProfile | null = null;
  let lastFillEEO = false;
  let observer: MutationObserver | null = null;
  // Guards maybeResumeFlow against re-entrancy: the observer can fire several
  // rescans before FLOW_STATE_GET resolves, which would otherwise start two
  // controllers from the same persisted state.
  let resumeInFlight = false;
  let overlayShown = false;
  // The top frame has adopted a form that lives in a child frame; its own local
  // scans must then never overwrite the panel with the (formless) top-frame DOM.
  let adoptedRemote = false;
  // The adopted child frame's fields + proxy callbacks (top frame only), kept
  // separate from this frame's own scan so local scans never clobber the panel.
  let remoteFields: DetectedField[] = [];
  let remoteCallbacks: OverlayCallbacks | null = null;
  // When this frame is a child that owns the form, it has no panel of its own —
  // it pushes field changes up to the top frame's panel instead of mounting one.
  let actingAsRemoteHost = false;

  /** Push current fields to wherever the panel lives (local overlay, or — when
   *  this frame is a child form-host — the top frame's panel). */
  function reportFields(): void {
    if (actingAsRemoteHost) {
      postToRuntime({ type: "RELAY_TO_TOP", payload: { type: "REMOTE_FIELDS_UPDATED", fields: lastFields } });
      return;
    }
    maybeShowOrUpdateOverlay();
  }

  // One reconciliation engine per frame, created on first fill. It keeps a
  // MutationObserver alive afterwards to correct post-fill drift.
  let engine: AutofillReconciler | null = null;
  const getEngine = (): AutofillReconciler => {
    if (!engine) engine = new AutofillReconciler({ root: document });
    return engine;
  };

  // After the extension is reloaded/updated this content script is orphaned:
  // every runtime message throws "Extension context invalidated". The messaging
  // helpers detect that and run this once so we stop the observers that would
  // otherwise re-fire — and re-throw — on every subsequent page mutation.
  onExtensionContextInvalidated(() => {
    try {
      observer?.disconnect();
    } catch {
      // observer already gone
    }
    observer = null;
    try {
      engine?.dispose();
    } catch {
      // reconciler already disposed
    }
    try {
      submitTracker?.dispose();
    } catch {
      // tracker already disposed
    }
  });

  const isTopFrame = ((): boolean => {
    try {
      return window.self === window.top;
    } catch {
      return false; // cross-origin parent → we are in an iframe
    }
  })();

  function runScan(): ScanResponse {
    const result = scanPage(lastProfile, lastFillEEO);
    registry = result.registry;
    lastAdapter = result.adapter;
    lastFields = result.fields;
    lastScope = result.scopeEl;
    logScanDiagnostics(isTopFrame, result.fields, lastProfile !== null);
    return {
      ok: true,
      url: location.href,
      frameToken: FRAME_TOKEN,
      fields: result.fields,
    };
  }

  // ---- In-page overlay -------------------------------------------------------

  function recognizedCount(fields: DetectedField[]): number {
    return fields.filter((f) => f.category !== "unknown").length;
  }

  /** One field's result from a non-reconciler pass (combobox / driver / adapter
   *  op), carrying the failure reason so telemetry records WHY it failed. */
  type PassOutcome = { fieldId: string; ok: boolean; reason?: string };

  /**
   * Fill custom ARIA dropdowns one at a time by opening the listbox and clicking
   * the matching option (comboboxEngine). Sequential so two menus never fight,
   * and deliberately NOT handed to the reconciler — re-driving a dropdown on
   * every mutation is the churn we avoid. Returns popup-style outcomes.
   */
  async function fillComboboxTargets(
    targets: { fieldId: string; value: string }[],
    signal?: AbortSignal
  ): Promise<{ outcomes: PassOutcome[]; reask: ReaskCandidate[] }> {
    const outcomes: PassOutcome[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      if (signal?.aborted) break; // Stop pressed — don't open more menus
      const control = registry.get(t.fieldId);
      const el = control?.el;
      if (!el) {
        outcomes.push({ fieldId: t.fieldId, ok: false, reason: "Field no longer found — rescan the page" });
        continue;
      }
      const res = await fillAriaCombobox(el, t.value, { multi: control?.multi });
      // Carry the specific reason (couldn't-open / no-match / didn't-commit) into
      // telemetry — otherwise a dropdown failure is logged with an empty reason.
      outcomes.push({ fieldId: t.fieldId, ok: res.filled, reason: res.reason });
      if (!res.filled && res.options) reask.push({ fieldId: t.fieldId, options: res.options });
    }
    return { outcomes, reask };
  }

  /** Fill react-select / Workday fields via the MAIN-world driver. */
  async function fillDriverTargets(
    targets: { fieldId: string; value: string }[],
    signal?: AbortSignal
  ): Promise<{ outcomes: PassOutcome[]; reask: ReaskCandidate[] }> {
    const outcomes: PassOutcome[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      if (signal?.aborted) break; // Stop pressed — don't drive more fields
      const control = registry.get(t.fieldId);
      if (!control?.driver) { outcomes.push({ fieldId: t.fieldId, ok: false }); continue; }
      // A multi-value widget (skills) takes one chip per item — the driver sets
      // a single value, so route it to the combobox engine's chip loop instead.
      if (control.multi && control.el) {
        const res = await fillAriaCombobox(control.el, t.value, { multi: true });
        outcomes.push({ fieldId: t.fieldId, ok: res.filled, reason: res.reason });
        if (!res.filled && res.options) reask.push({ fieldId: t.fieldId, options: res.options });
        continue;
      }
      const res = await driveField(t.fieldId, t.value, control.driver);
      if (res.ok || !control.el) {
        outcomes.push({ fieldId: t.fieldId, ok: res.ok, reason: res.ok ? undefined : res.reason });
        continue;
      }
      // Driver miss — best-effort ARIA fallback: may fill, or harvest options.
      const fb = await fillAriaCombobox(control.el, t.value, { multi: control.multi });
      outcomes.push({ fieldId: t.fieldId, ok: fb.filled, reason: fb.reason });
      if (!fb.filled && fb.options) reask.push({ fieldId: t.fieldId, options: fb.options });
    }
    return { outcomes, reask };
  }

  /** Whether a tracked field is a custom ARIA dropdown (filled by comboboxEngine). */
  function isComboboxField(fieldId: string): boolean {
    return registry.get(fieldId)?.controlType === "combobox";
  }

  /** Whether a tracked field is filled via the MAIN-world driver (react-select/Workday). */
  const isDriverField = (fieldId: string): boolean => Boolean(registry.get(fieldId)?.driver);

  /** Dedupe DetectedFields by id (first wins). */
  function dedupeById(fields: DetectedField[]): DetectedField[] {
    const seen = new Set<string>();
    const out: DetectedField[] = [];
    for (const f of fields) {
      if (!seen.has(f.id)) { seen.add(f.id); out.push(f); }
    }
    return out;
  }

  /**
   * Fill a list of {fieldId,value} through the same path as onAutofill: the site
   * adapter gets first refusal, then react-select/Workday drivers, custom ARIA
   * dropdowns, and the reconciler for the rest. `merge` adds to the running
   * reconciler state (a later pass); otherwise it starts a fresh run.
   */
  async function fillItems(
    items: { fieldId: string; value: string }[],
    merge: boolean,
    signal?: AbortSignal
  ): Promise<{ reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    if (items.length === 0 && merge) return { reports: [], outcomes: [], reask: [] };
    const { opOutcomes, remaining } = await runAdapterOperations(lastAdapter, items, (id) => registry.get(id));
    const driverTargets = remaining.filter((it) => isDriverField(it.fieldId));
    const comboTargets = remaining.filter((it) => !isDriverField(it.fieldId) && isComboboxField(it.fieldId));
    const reconTargets = remaining.filter((it) => !isDriverField(it.fieldId) && !isComboboxField(it.fieldId));
    const reports = merge
      ? reconTargets.length
        ? await getEngine().addTargets(reconTargets, registry, signal)
        : []
      : await getEngine().run(reconTargets, registry, signal);
    const combo = comboTargets.length
      ? await fillComboboxTargets(comboTargets, signal)
      : { outcomes: [], reask: [] };
    const driver = driverTargets.length
      ? await fillDriverTargets(driverTargets, signal)
      : { outcomes: [], reask: [] };
    // A <select> that failed on "No option matches" re-reads its options fresh
    // (dependent dropdowns — Country → State — repopulate after earlier fills).
    const reask: ReaskCandidate[] = [...combo.reask, ...driver.reask];
    for (const r of reports) {
      if (r.ok || !r.reason?.startsWith("No option matches")) continue;
      const control = registry.get(r.fieldId);
      if (control?.controlType === "select" && control.el?.isConnected) {
        const options = selectOptions(control.el as HTMLSelectElement);
        if (options.length > 0) reask.push({ fieldId: r.fieldId, options });
      }
    }
    return { reports, outcomes: [...combo.outcomes, ...driver.outcomes, ...opOutcomes], reask };
  }

  /**
   * One full fill pass over the current step. `ids === null` fills the default
   * selection (used by the flow for steps 2+ where there is no panel click).
   * Preserves the Task-7 single re-ask round. Every backend answer fills
   * silently (no review gate). Returns the step tally.
   */
  /** True when the control for `id` currently holds no user-visible value. */
  function controlIsEmpty(id: string): boolean {
    const control = registry.get(id);
    const el = control?.el;
    if (!el) return true;
    // A committed combobox keeps its INPUT empty — the selection lives in the
    // widget's value display (react-select single-value div, trigger text) — so
    // judge by the widget's displayed value, not the input.
    if (control.controlType === "combobox" || control.controlType === "customDropdown") {
      return !readComboboxValue(el);
    }
    if (control.controlType === "select") {
      const opt = (el as HTMLSelectElement).selectedOptions[0];
      return !opt || !opt.value;
    }
    if (control.controlType === "radioGroup") {
      return !control.radios?.some((r) => r.checked);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return !el.value.trim();
    }
    return !(el.textContent ?? "").trim();
  }

  /**
   * Silently refill device-local sensitive answers (gender/orientation/veteran/…
   * — the sensitive questions with no profile slot, saved on an earlier
   * application). They never reach any backend, so we refill them here with NO UI.
   * The old interactive "missing information" modal was removed: unknown fields
   * are left for the user to fill, and the flow's advance gate surfaces any empty
   * required ones. Returns the fills so the caller can fold them into its tally.
   */
  async function refillLocalAnswers(signal?: AbortSignal): Promise<{
    reports: FieldReport[];
    outcomes: { fieldId: string; ok: boolean }[];
  }> {
    const empty = { reports: [], outcomes: [] };

    // Device-local sensitive answers + the user's own custom autofill fields,
    // refilled silently before we hand off (both matched by exact-normalized
    // label — custom fields are just user-authored local answers).
    let localFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[] } = empty;
    try {
      const stored = await getLocalAnswers();
      for (const [k, v] of customFieldAnswers(await getExtras())) stored.set(k, v);
      if (stored.size > 0) {
        const storedTargets = lastFields
          .filter((f) => f.fillable && f.proposedValue === null && controlIsEmpty(f.id))
          .map((f) => ({ fieldId: f.id, value: stored.get(normalize(f.label)) ?? "" }))
          .filter((t) => t.value);
        if (storedTargets.length > 0) {
          const r = await fillItems(storedTargets, true, signal);
          localFill = { reports: r.reports, outcomes: r.outcomes };
        }
      }
    } catch {
      // Storage unavailable — nothing to refill.
    }

    return localFill;
  }

  /**
   * Click "Add another" to create the work-experience / education rows the
   * profile needs (the resolver already fills row N from experience[N]). Re-finds
   * the button and re-counts after each click so it survives the row re-render,
   * caps rows, and stops the moment a click adds nothing (wrong button / limit).
   */
  async function expandRepeatingSections(signal?: AbortSignal): Promise<void> {
    if (!lastProfile) return;
    for (const kind of SECTION_KINDS) {
      const needed = Math.min(rowsNeeded(lastProfile, kind), MAX_ROWS);
      if (needed === 0) continue; // nothing to add for this section
      // Drive by needed rows, not "≥1 present" — some ATS show an empty section
      // with just an "Add Work Experience" button. findAddButton falls back to a
      // section-specific button (unambiguous text) when there are no fields to
      // scope a generic "Add", so it can't mis-click a neighbouring section.
      for (let guard = 0; guard <= MAX_ROWS; guard++) {
        if (signal?.aborted) return;
        const present = rowsPresent(lastFields, kind);
        if (present >= needed) break;
        const btn = findAddButton(lastFields, kind, (id) => registry.get(id)?.el);
        if (!btn) break;
        activateElement(btn);
        await waitForDomSettle(signal);
        runScan();
        if (rowsPresent(lastFields, kind) <= present) break; // click added no row — stop
      }
    }
  }

  /** True when the page has a location cascade (Country + State/City), the case
   *  where a child dropdown only offers valid options once its parent is set. */
  function hasLocationCascade(): boolean {
    return (
      lastFields.some((f) => f.category === "country") &&
      lastFields.some((f) => f.category === "addressState" || f.category === "addressCity")
    );
  }

  /**
   * Cascading dropdowns (Country → State → City): a child only lists valid
   * options after its parent is filled, so its first attempt found nothing and
   * left proposedValue null. Now that parents are set, settle → rescan (which
   * re-reads the repopulated options and re-resolves proposedValue against them)
   * → re-fill the still-empty children. Two rounds cover the country→state→city
   * chain; stops as soon as a round fills nothing.
   */
  async function retryDependentDropdowns(
    signal?: AbortSignal
  ): Promise<{ reports: FieldReport[]; outcomes: PassOutcome[] }> {
    const reports: FieldReport[] = [];
    const outcomes: PassOutcome[] = [];
    if (!hasLocationCascade()) return { reports, outcomes };
    for (let round = 0; round < 2; round++) {
      if (signal?.aborted) break;
      await waitForDomSettle(signal);
      runScan();
      engine?.updateRegistry(registry);
      const retry = lastFields
        .filter(
          (f) =>
            (f.controlType === "select" || f.controlType === "combobox") &&
            f.fillable &&
            f.proposedValue !== null &&
            controlIsEmpty(f.id)
        )
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      if (retry.length === 0) break;
      const r = await fillItems(retry, true, signal);
      reports.push(...r.reports);
      outcomes.push(...r.outcomes);
      if (!r.reports.some((rep) => rep.ok) && !r.outcomes.some((o) => o.ok)) break;
    }
    return { reports, outcomes };
  }

  async function fillOnce(ids: string[] | null, signal?: AbortSignal): Promise<StepTally> {
      if (signal?.aborted) return { ok: 0, fail: 0, total: 0 };
      // Let a React ATS finish hydrating before we scan+fill: filling a form
      // that is still swapping in its real fields captures throwaway controls
      // that detach mid-write. Wait for the DOM to go quiet, then rescan so we
      // operate on the settled form. A stable page clears the quiet window
      // immediately; the flow path (ids === null) re-derives its selection from
      // this fresh scan, so newly-mounted real fields are the ones filled.
      await waitForDomSettle(signal);
      if (signal?.aborted) return { ok: 0, fail: 0, total: 0 };
      runScan();
      // Create the extra work-experience / education rows the profile needs before
      // filling, so a candidate with several jobs doesn't get only the first row.
      await expandRepeatingSections(signal);
      engine?.updateRegistry(registry);
      const wanted = ids ? new Set(ids) : defaultSelectedIds(lastFields);
      const selected = lastFields.filter(
        (f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null
      );

      // Phase A — deterministic profile fields fill instantly (local fast-path).
      const route = planFillRoute(selected, AUTOFILL_CONFIDENCE_THRESHOLD);
      const localFill = await fillItems(route.localTargets, false, signal);

      // Phase B — judgment fields answered by the backend (primary), deduped by the
      // session cache; also the eligible EMPTY fields (today's AI candidates). The
      // local proposedValue is the fallback so a judgment field never regresses when
      // the backend is unavailable.
      const backendFields = dedupeById([...route.backendFields, ...aiFillCandidates(lastFields)]);
      let aiFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      let fallbackFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      if (backendFields.length > 0 && !signal?.aborted) {
        const { hits, misses } = splitByCache(backendFields);
        // Harvest real options for lazy dropdowns BEFORE asking the AI, so its
        // first answer is constrained to what the widget actually offers
        // (react-select / Workday mount their option list only when opened).
        for (const f of misses) {
          if (signal?.aborted) break;
          const control = registry.get(f.id);
          if (!needsOptionHarvest(f, Boolean(control?.driver)) || !control?.el) continue;
          const harvested = await harvestComboboxOptions(control.el).catch(() => undefined);
          if (harvested && harvested.length > 0) f.options = harvested;
        }
        let answers: PlannedAnswer[] = hits;
        try {
          if (misses.length > 0) {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: misses.map(toAiFillField),
              jobContext: extractJobContext(),
              profile: lastProfile ? toApplicantProfile(lastProfile) : undefined,
            });
            if (resp?.ok) {
              cacheAnswers(misses, resp.answers);
              answers = [...hits, ...resp.answers];
            }
          }
        } catch {
          // Backend unavailable — the local fallback below still fills judgment fields.
        }
        const plan = planAiFill(backendFields, answers);
        aiFill = await fillItems(plan.simpleTargets, true, signal);

        // Local fallback: judgment fields that had a local value but weren't answered
        // by the backend still fill from proposedValue — no regression. A single
        // checkbox with a non-boolean value is excluded: it was routed to the AI
        // precisely because that value can only fail as "Ambiguous checkbox value".
        const answered = new Set<string>(plan.simpleTargets.map((t) => t.fieldId));
        const fallbackTargets = route.backendFields
          .filter((f) => !answered.has(f.id) && f.proposedValue !== null)
          .filter((f) => f.controlType !== "checkbox" || isBoolish(f.proposedValue as string))
          .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
        fallbackFill = await fillItems(fallbackTargets, true, signal);
      }

      // One re-ask round: choice controls whose fill missed now carry the
      // widget's REAL options — a single batched AI_FILL snaps the answers
      // ("Canada" → "Canadian"), then a merge pass drives them in.
      let reaskFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      let demoFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      const reaskCandidates = [...localFill.reask, ...aiFill.reask, ...fallbackFill.reask];
      // Sensitive (EEO) fields NEVER reach the backend — pick their closest
      // option ON-DEVICE from the harvested list. Everything else re-asks the AI.
      const sensitiveReask = reaskCandidates.filter((c) => lastFields.find((f) => f.id === c.fieldId)?.sensitive);
      const openReask = reaskCandidates.filter((c) => !lastFields.find((f) => f.id === c.fieldId)?.sensitive);
      if (sensitiveReask.length > 0 && !signal?.aborted) {
        const demoTargets: { fieldId: string; value: string }[] = [];
        for (const c of sensitiveReask) {
          const f = lastFields.find((x) => x.id === c.fieldId);
          if (!f) continue;
          f.options = c.options; // panel shows the real choices
          const choice = closestDemographicOption(f.category, f.proposedValue ?? "", c.options);
          if (choice) demoTargets.push({ fieldId: c.fieldId, value: choice });
        }
        if (demoTargets.length > 0) demoFill = await fillItems(demoTargets, true, signal);
      }
      if (openReask.length > 0 && !signal?.aborted) {
        for (const c of openReask) {
          const f = lastFields.find((x) => x.id === c.fieldId);
          if (f) f.options = c.options; // panel now shows the real choices
        }
        const reaskFields = planReaskFields(lastFields, openReask);
        if (reaskFields.length > 0) {
          try {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: reaskFields,
              jobContext: extractJobContext(),
              profile: lastProfile ? toApplicantProfile(lastProfile) : undefined,
            });
            if (resp?.ok) {
              const affected = lastFields.filter((f) => reaskFields.some((r) => r.id === f.id));
              cacheAnswers(affected, resp.answers); // overwrite the unconstrained answers
              const plan = planAiFill(affected, resp.answers);
              reaskFill = await fillItems(plan.simpleTargets, true, signal);
            }
          } catch {
            // Backend unreachable — the manual-select outcomes stand.
          }
        }
      }

      // Silently refill any device-local sensitive answers we saved before.
      // Skipped once cancelled.
      const missingFill = signal?.aborted ? { reports: [], outcomes: [] } : await refillLocalAnswers(signal);

      // Cascading location dropdowns (Country → State → City) now that parents
      // are set — a no-op unless the page actually has a location cascade.
      const cascadeFill = signal?.aborted
        ? { reports: [], outcomes: [] as PassOutcome[] }
        : await retryDependentDropdowns(signal);

      const { ok, fail, total } = tallyOutcomes(
        localFill.reports,
        aiFill.reports,
        fallbackFill.reports,
        reaskFill.reports,
        demoFill.reports,
        missingFill.reports,
        cascadeFill.reports,
        localFill.outcomes,
        aiFill.outcomes,
        fallbackFill.outcomes,
        reaskFill.outcomes,
        demoFill.outcomes,
        missingFill.outcomes,
        cascadeFill.outcomes
      );

      // Fire-and-forget telemetry (field labels + outcomes only, never values) so
      // we can see which sites/fields the filler struggles with. Skipped on cancel.
      if (!signal?.aborted && total > 0) {
        const allReports = [
          ...localFill.reports, ...aiFill.reports, ...fallbackFill.reports,
          ...reaskFill.reports, ...demoFill.reports, ...missingFill.reports, ...cascadeFill.reports,
        ];
        const allOutcomes = [
          ...localFill.outcomes, ...aiFill.outcomes, ...fallbackFill.outcomes,
          ...reaskFill.outcomes, ...demoFill.outcomes, ...missingFill.outcomes, ...cascadeFill.outcomes,
        ];
        const telemetry = buildAutofillTelemetry(
          lastFields,
          { host: location.host, url: location.href, atsType: lastAdapter?.id ?? "" },
          allReports,
          allOutcomes
        );
        if (telemetry.totalFields > 0) {
          void sendToBackground<SimpleResponse>({ type: "RECORD_TELEMETRY", telemetry }).catch(() => {});
        }
      }

      return { ok, fail, total };
  }

  /** Route a flow progress beat to wherever the panel lives (mirrors reportFields). */
  function emitFlowProgress(p: FlowProgress): void {
    // The fill/flow is over — restore the page's dialogs.
    if (p.phase === "done" || p.phase === "stopped") void setDialogSuppression(false);
    if (actingAsRemoteHost) {
      void chrome.runtime
        .sendMessage({ type: "RELAY_TO_TOP", payload: { type: "REMOTE_FLOW_PROGRESS", progress: p } })
        .catch(() => {});
    } else {
      updateFlowProgress(p);
    }
  }

  /** Attach the flow's picked résumé (or the best default) to the pending file field. */
  async function attachPickedResume(): Promise<boolean> {
    const field = resumeFieldNeedingFile(lastFields, (id) => registry.get(id));
    if (!field) return true;
    const control = registry.get(field.id);
    if (!control?.el) return false;
    try {
      let resumeId = flowResumeId;
      if (resumeId == null) {
        // Spec: fall back to the primary résumé, else the most recent with a file.
        const rs = await sendToBackground<ResumesResponse>({ type: "GET_RESUMES" });
        const withFile: ResumeSummary[] = rs?.ok ? rs.resumes.filter((r) => r.hasFile) : [];
        const pick =
          withFile.find((r) => r.isPrimary) ??
          [...withFile].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
        resumeId = pick?.id ?? null;
      }
      if (resumeId == null) return false;
      const file = await sendToBackground<ResumeFileResponse>({ type: "DOWNLOAD_RESUME", resumeId });
      if (!file?.ok || !file.dataBase64) return false;
      const res = await injectResumeFile(control.el, base64ToFile(file.dataBase64, file.name, file.contentType));
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Record the application on the user's Tailrd account (Applications page) when
   * they submit. Best-effort: a signed-out user or offline backend is ignored.
   * Deduped per URL locally so a double-click doesn't send twice; the backend
   * dedupes across sessions too.
   */
  async function recordCurrentApplication(): Promise<void> {
    const url = location.href;
    if (lastRecordedUrl === url) return;
    const ctx = extractJobContext();
    const application: ApplicationLog = {
      company: ctx.company,
      role: ctx.jobTitle,
      url,
      atsType: lastAdapter?.id ?? "",
      resumeVersion: flowResumeId != null ? "uploaded" : "original",
    };
    if (!application.company && !application.role && !application.url) return;
    lastRecordedUrl = url;
    try {
      const resp = await sendToBackground<RecordApplicationResponse>({
        type: "RECORD_APPLICATION",
        application,
      });
      if (resp?.ok) {
        emitFlowProgress({
          phase: "done",
          step: 0,
          filledOk: 0,
          filledFail: 0,
          detail: "Application tracked in your Tailrd dashboard",
        });
      } else if (resp?.needsLogin) {
        lastRecordedUrl = null; // let a later attempt retry once connected
      }
    } catch {
      lastRecordedUrl = null; // transient failure — allow a retry
    }
  }

  /** Bind submit tracking to the flow's terminal button (idempotent per button). */
  function bindSubmitOnce(button: HTMLElement): void {
    if (trackedButton === button && submitTracker) return;
    submitTracker?.dispose();
    trackedButton = button;
    submitTracker = bindSubmitTracking(button, () => void recordCurrentApplication(), {
      hasBlockingValidation: () => validationMessages(lastScope ?? document.body).length > 0,
    });
  }

  function makeFlowDeps(): FlowDeps {
    return {
      fillStep: (ids) => fillOnce(ids, flowAbort?.signal),
      snapshot: (): FlowSnapshot => ({
        fields: lastFields,
        scopeEl: lastScope,
        url: location.href,
        entry: findApplyEntry(document, lastAdapter),
        accountWall: detectWall(lastScope ?? document.body) !== null,
      }),
      rescan: () => {
        runScan();
        engine?.updateRegistry(registry);
      },
      findAdvance: (scope, extraAdvance) => findAdvanceButton(scope, lastAdapter, { extraAdvance }),
      clickAdvance,
      onTerminal: (button) => bindSubmitOnce(button),
      accountStep: async (snap) => {
        const scope = snap.scopeEl ?? document.body;
        let wall = detectWall(scope);
        if (!wall) {
          accountBlocked = false;
          return {};
        }
        // A sign-in wall with no credential saved for this origin: we never
        // created an account here, so when the page offers a create-account
        // toggle (Workday's createAccountLink), flip to registration — the
        // default intent, matching the reference flow. A user who already has
        // an account still signs in manually during the resulting pause.
        if (wall.kind === "login" && !(await getCredential(location.origin))) {
          const toggle = findSignupToggle(scope);
          if (toggle) {
            console.log("[Tailrd flow] login wall with no saved credential — switching to create-account");
            clickAdvance(toggle);
            await new Promise((resolve) => setTimeout(resolve, 800));
            runScan();
            engine?.updateRegistry(registry);
            wall = detectWall(lastScope ?? document.body) ?? wall;
          }
        }
        const out = await runAccountWall(
          wall,
          location.origin,
          lastProfile?.email ?? "",
          (el, value) =>
            writeControl(
              { id: el.getAttribute("data-ap-field") ?? "", controlType: el.type === "password" ? "password" : "text", el },
              value
            )
        );
        // The wall owns its email field: drop the generic proposal so the
        // fill pass that follows can't overwrite the registration email with
        // the profile email — the saved pair must match what the site got.
        if (wall.emailEl?.value) {
          for (const f of lastFields) {
            if (registry.get(f.id)?.el === wall.emailEl) f.proposedValue = null;
          }
        }
        // Give the form a beat to react to the password + ticked consent before
        // the controller looks for (and clicks) Create Account — Workday enables
        // that button only once its own validation has re-run.
        if (out.filled > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        accountBlocked = out.pause === "account";
        return { extraAdvance: out.extraAdvance, wall: wall.kind };
      },
      pauseReason: async (snap) => {
        if (accountBlocked && detectWall(snap.scopeEl ?? document.body)) return "account";
        accountBlocked = accountBlocked && detectWall(snap.scopeEl ?? document.body) !== null;
        if (hasUnsolvedCaptcha(document)) return "captcha";
        const scope = snap.scopeEl ?? document.body;
        if (isVerificationWall(scope)) return "verification";
        if (validationMessages(scope).length > 0) return "validation";
        if (resumeFieldNeedingFile(snap.fields, (id) => registry.get(id))) return "resume-upload";
        return null;
      },
      needsResume: (snap) => resumeFieldNeedingFile(snap.fields, (id) => registry.get(id)) !== null,
      hasUnfilledRequired: (snap) =>
        snap.fields.some(
          (f) => f.required && f.fillable && f.controlType !== "file" && controlIsEmpty(f.id)
        ),
      attachResume: attachPickedResume,
      setState: async (state: FlowState | null) => {
        try {
          await sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state });
        } catch {
          // Background asleep — the flow still runs, it just won't survive navigation.
        }
      },
      onProgress: emitFlowProgress,
      diagnoseStuck: logStuckDiagnostics,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
  }

  /** Resume a persisted flow after a real navigation (form-owning frame only,
   *  or the top frame of an entry page — job posting / apply-method chooser). */
  async function maybeResumeFlow(): Promise<void> {
    if (flowController || resumeInFlight) return;
    if (
      recognizedCount(lastFields) === 0 &&
      !(isTopFrame && findApplyEntry(document, lastAdapter))
    ) {
      return; // not the form-owning frame (yet), and nothing to click into
    }
    resumeInFlight = true;
    try {
      const resp = await sendToBackground<FlowStateResponse>({ type: "FLOW_STATE_GET" });
      const st = resp?.state;
      if (!st?.active) return;
      if (Date.now() - st.startedAt > FLOW_TTL_MS) {
        void sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state: null }).catch(() => {});
        return;
      }
      if (flowController) return; // an autofill click set it while we awaited FLOW_STATE_GET
      flowAbort = new AbortController(); // a resumed flow is cancellable too
      void setDialogSuppression(true); // a resumed flow may auto-advance (beforeunload)
      flowController = new FlowController(makeFlowDeps());
      void flowController.run(st, null);
    } catch {
      // Background asleep — the flow simply doesn't resume.
    } finally {
      resumeInFlight = false;
    }
  }

  const overlayCallbacks: OverlayCallbacks = {
    onAutofill: async (ids: string[], uploadResumeId?: number | null) => {
      flowResumeId = uploadResumeId ?? null;
      // Suppress blocking page dialogs (alert / beforeunload) for the fill+flow.
      void setDialogSuppression(true);
      // One click = one flow. Replace any prior flow, fill this step now (the
      // panel awaits this first tally), then let the controller advance.
      // Invariant: a Stop during this initial fill wins (skip the controller);
      // a fresh click supersedes a background resume that started mid-fill.
      const gen = flowGeneration;
      flowController?.stop();
      flowAbort?.abort(); // supersede any fill still running from a prior click
      flowAbort = new AbortController();
      const signal = flowAbort.signal;
      const tally = await fillOnce(ids, signal);
      if (gen === flowGeneration && !signal.aborted) {
        flowController?.stop(); // a maybeResumeFlow may have set one mid-fill; this click wins
        flowController = new FlowController(makeFlowDeps());
        void flowController.run(
          { active: true, step: 0, startedAt: Date.now(), lastSignature: "" },
          tally
        );
      }
      return tally;
    },
    onFlowStop: () => {
      flowGeneration++; // a Stop during an in-flight initial fill must win the race
      flowAbort?.abort(); // interrupt a fill currently writing fields (cancel mid-fill)
      void setDialogSuppression(false); // restore the page's dialogs
      flowController?.stop();
      flowController = null;
      // Stop always clears the persisted state — even when no controller is
      // live yet (a resume mid-await), so the pending resume cannot proceed.
      void sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state: null }).catch(() => {});
    },
    onFlowAdvance: () => {
      // User pressed "Next page" — release the flow's ready gate so it advances
      // and auto-fills the next page (Task B). No-op when no flow is parked.
      flowController?.notifyAdvanceRequested();
    },
    onRescan: () => {
      runScan();
      reportFields();
    },
    onListResumes: async () => {
      const resp = await sendToBackground<ResumesResponse>({ type: "GET_RESUMES" });
      return resp?.ok ? resp.resumes : [];
    },
    onProfileResolved: (profile) => {
      // The overlay resolved the account profile. Remember it and re-scan so
      // every field gets a proposed value; then push the enriched fields back so
      // the overlay can pre-select them and enable the Autofill button. Without
      // this the scanner only ever ran with a null profile (the legacy popup was
      // the only thing that sent SCAN_PAGE), so nothing was ever fillable.
      lastProfile = profile;
      runScan();
      reportFields();
      void maybeResumeFlow();
    },
    onOpenAiModal: (kind: "resume" | "cover") => {
      void (async () => {
        const auth = await sendToBackground<AccessTokenResponse>({ type: "GET_ACCESS_TOKEN" });
        if (!auth?.ok || !auth.token) {
          void sendToBackground<SimpleResponse>({ type: "OPEN_DASHBOARD" }).catch(() => {});
          return;
        }
        let appOrigin: string;
        try {
          appOrigin = new URL(auth.apiBaseUrl ?? "").origin;
        } catch {
          return;
        }
        const jc = await resolveJobContext();
        openAiModal({
          kind,
          appOrigin,
          job: {
            title: jc.jobTitle,
            company: jc.company,
            description: jc.jobDescription,
            url: location.href,
          },
          getToken: async () => auth.token,
          refreshToken: async () => {
            const r = await sendToBackground<AccessTokenResponse>({ type: "GET_ACCESS_TOKEN" });
            return r?.token ?? auth.token;
          },
          onAttach: async (attachKind, file) => {
            const category = attachKind === "resume" ? "resumeUpload" : "coverLetter";
            const field = lastFields.find(
              (f) => f.category === category && f.controlType === "file"
            );
            const control = field ? registry.get(field.id) : undefined;
            if (!control?.el) return;
            await attachOrGuide(control.el, file.dataBase64, file.filename, file.contentType);
          },
          mount: document.body,
        });
      })();
    },
    onUploadResume: async (resumeId: number) => {
      const field = lastFields.find(
        (f) => f.category === "resumeUpload" && f.controlType === "file"
      );
      const control = field ? registry.get(field.id) : undefined;
      if (!control?.el) {
        return { ok: false, reason: "No résumé upload field found on this page." };
      }
      const file = await sendToBackground<ResumeFileResponse>({
        type: "DOWNLOAD_RESUME",
        resumeId,
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not download your résumé." };
      }
      return attachOrGuide(control.el, file.dataBase64, file.name, file.contentType);
    },
    onTailorResume: async (opts: TailorResumeOpts) => {
      const resp = await sendToBackground<TailorResumeResponse>({
        type: "TAILOR_RESUME",
        resumeId: opts.resumeId,
        jobContext: extractJobContext(),
        sections: opts.sections,
        addKeywords: opts.addKeywords,
      });
      if (!resp?.ok || !resp.result) {
        return {
          ok: false,
          needsLogin: resp?.needsLogin,
          reason: resp?.error ?? "Could not tailor your résumé.",
        };
      }
      return { ok: true, result: resp.result };
    },
    onAttachTailored: async (document: ResumeDoc) => {
      const field = lastFields.find(
        (f) => f.category === "resumeUpload" && f.controlType === "file"
      );
      const control = field ? registry.get(field.id) : undefined;
      if (!control?.el) {
        return { ok: false, reason: "No résumé upload field found on this page." };
      }
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderResumeResponse>({
        type: "RENDER_RESUME",
        document,
        filename: company ? `resume-${company}` : "resume",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your résumé." };
      }
      return attachOrGuide(control.el, file.dataBase64, file.name, file.contentType);
    },
    onDownloadTailored: async (document: ResumeDoc) => {
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderResumeResponse>({
        type: "RENDER_RESUME",
        document,
        filename: company ? `resume-${company}` : "resume",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your résumé." };
      }
      downloadBase64File(file.dataBase64, file.name, file.contentType);
      return { ok: true };
    },
    onGenerateCoverLetter: async (opts: CoverLetterGenOpts) => {
      const resp = await sendToBackground<GenerateCoverLetterResponse>({
        type: "GENERATE_COVER_LETTER",
        resumeId: opts.resumeId,
        jobContext: extractJobContext(),
        tone: opts.tone,
        baseText: opts.baseText,
      });
      if (!resp?.ok || typeof resp.text !== "string") {
        return {
          ok: false,
          needsLogin: resp?.needsLogin,
          reason: resp?.error ?? "Could not generate a cover letter.",
        };
      }
      return { ok: true, text: resp.text };
    },
    onInsertCoverLetter: async (text: string) => {
      // Prefer a cover-letter textarea; fall back to a cover-letter file field.
      const textField = lastFields.find(
        (f) => f.category === "coverLetter" && LONG_TEXT.includes(f.controlType)
      );
      if (textField) {
        const control = registry.get(textField.id);
        if (!control) return { ok: false, reason: "Cover-letter field is no longer on the page — rescan." };
        const res = writeControl(control, text);
        if (!res.written) return { ok: false, reason: res.reason };
        return verifyControl(control, text)
          ? { ok: true }
          : { ok: false, reason: "Text did not stick — please check the field." };
      }
      const fileField = lastFields.find(
        (f) => f.category === "coverLetter" && f.controlType === "file"
      );
      const fileControl = fileField ? registry.get(fileField.id) : undefined;
      if (fileControl?.el) {
        const company = extractJobContext().company;
        const file = await sendToBackground<RenderCoverLetterResponse>({
          type: "RENDER_COVER_LETTER",
          text,
          filename: company ? `cover-letter-${company}` : "cover-letter",
        });
        if (!file?.ok || !file.dataBase64) {
          return { ok: false, reason: file?.error ?? "Could not render your cover letter." };
        }
        return attachOrGuide(fileControl.el, file.dataBase64, file.name, file.contentType);
      }
      return { ok: false, reason: "No cover-letter field found on this page." };
    },
    onDownloadCoverLetter: async (text: string) => {
      const company = extractJobContext().company;
      const file = await sendToBackground<RenderCoverLetterResponse>({
        type: "RENDER_COVER_LETTER",
        text,
        filename: company ? `cover-letter-${company}` : "cover-letter",
      });
      if (!file?.ok || !file.dataBase64) {
        return { ok: false, reason: file?.error ?? "Could not render your cover letter." };
      }
      downloadBase64File(file.dataBase64, file.name, file.contentType);
      return { ok: true };
    },
    onCopyCoverLetter: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, reason: "Clipboard blocked — select the text and copy manually." };
      }
    },
  };

  function maybeShowOrUpdateOverlay(): void {
    if (!isTopFrame || adoptedRemote) return;
    const entry = findApplyEntry(document, lastAdapter);
    const ident = extractJobIdentity();
    // Which ATS are we on? The matched adapter's label is the most reliable
    // signal (broad host match); fall back to the path-gated registry for the
    // company portals that have no fill adapter. Either may be null.
    const siteLabel =
      lastAdapter?.label ??
      detectSite(location.hostname, location.href, { inIframe: self !== top })?.label ??
      null;
    const state = {
      fields: lastFields,
      tabUrl: location.href,
      applyEntry: entry?.label ?? null,
      company: ident.company,
      jobTitle: ident.jobTitle,
      siteLabel,
    };
    // Mount on recognized fields, on a known ATS's apply-entry page (Workday job
    // posting), or on any known-ATS host (lastAdapter matched by host) — so the
    // always-on "Account Creation & Autofill" button is available to start the
    // flow even before the posting exposes an apply-entry we recognise. Arbitrary
    // pages still never auto-mount; the toolbar icon opens the panel on demand.
    const shouldMount =
      recognizedCount(lastFields) >= MIN_FIELDS_FOR_OVERLAY ||
      Boolean(entry?.fromAdapter) ||
      Boolean(lastAdapter);
    if (!overlayShown && shouldMount) {
      overlayShown = true;
      console.log(`[Tailrd overlay] mounting panel (recognized=${recognizedCount(lastFields)} of ${lastFields.length} fields, entry=${entry?.label ?? "none"})`);
      showOverlay(state, overlayCallbacks);
    } else if (overlayShown) {
      updateOverlay(state);
    } else {
      console.log(`[Tailrd overlay] NOT mounting — only ${recognizedCount(lastFields)} recognized fields in TOP frame`);
    }
  }

  // ---- Observer ---------------------------------------------------------------

  /** Start watching for SPA re-renders after the first scan request. */
  function ensureObserver(): void {
    if (observer) return;
    observer = observePage(() => {
      const before = lastFields.length;
      const recognizedBefore = recognizedCount(lastFields);
      runScan();
      // Keep the reconciler pointed at the freshly-scanned controls so its
      // background drift correction tracks surviving fields after re-renders.
      engine?.updateRegistry(registry);
      if (lastFields.length !== before) {
        // Let the toolbar popup know (it refreshes if open).
        const event: FieldsUpdatedEvent = {
          type: "FIELDS_UPDATED",
          url: location.href,
          fieldCount: lastFields.length,
        };
        // Context-safe: after a reload this send would otherwise throw
        // "Extension context invalidated" synchronously on every mutation.
        postToRuntime(event);
      }
      reportFields();
      if (!isTopFrame) announceIfFormHost();
      // A mid-flow navigation can land on an SPA page (Workday) that lazy-renders
      // its fields AFTER the initial profile-resolve resume already ran and bailed
      // on the still-empty page. Retry the resume the instant recognized fields
      // appear, so the next page auto-fills without a manual Autofill click. Gated
      // on the profile being loaded (a fill needs proposed values) and on a real
      // 0→N transition; maybeResumeFlow's own guards handle the no-active-flow case.
      if (lastProfile !== null && recognizedBefore === 0 && recognizedCount(lastFields) > 0) {
        void maybeResumeFlow();
      }
    });
  }

  /**
   * Load the server-side hot-fix classification rules for this host, then
   * re-scan so they take effect. Best-effort — no rules / background asleep just
   * leaves the generic pipeline running.
   */
  async function loadOverrides(): Promise<void> {
    try {
      const resp = await sendToBackground<OverridesResponse>({ type: "GET_OVERRIDES" });
      if (!resp?.ok || resp.rules.length === 0) return;
      setOverrideRules(resp.rules, location.host);
      runScan(); // re-classify with the overrides applied
      engine?.updateRegistry(registry);
      reportFields();
      if (!isTopFrame) announceIfFormHost();
    } catch {
      // No rules or background asleep — generic classification stands.
    }
  }

  /**
   * If this page is a real job posting (has a substantial description), remember
   * it so the application form page — which almost never repeats the description
   * — can still give the AI real context for the résumé rewrite / cover letter.
   */
  function captureJobDescription(): void {
    try {
      const ctx = extractJobContext();
      if (ctx.jobDescription && ctx.jobDescription.length >= MIN_CACHEABLE_DESC) {
        void saveLastJobContext({
          jobDescription: ctx.jobDescription,
          jobTitle: ctx.jobTitle,
          company: ctx.company,
          url: location.href,
        });
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Job context for the AI modals: this page's context, but falling back to the
   * last posting we saw for the description (application forms rarely have it).
   */
  async function resolveJobContext(): Promise<JobContext> {
    const ctx = extractJobContext();
    if (ctx.jobDescription && ctx.jobDescription.length >= MIN_CACHEABLE_DESC) return ctx;
    const cached = await getLastJobContext();
    if (!cached) return ctx;
    return {
      jobTitle: ctx.jobTitle || cached.jobTitle,
      company: ctx.company || cached.company,
      jobDescription: cached.jobDescription,
    };
  }

  function autoInit(): void {
    runScan();
    captureJobDescription();
    ensureObserver();
    void loadOverrides();
    if (isTopFrame) {
      maybeShowOrUpdateOverlay();
      // A mid-flow REAL navigation can land on a field-less entry page (the
      // apply-method chooser). No fields → no panel → no profile resolve, so
      // the usual profile-driven resume never fires; resume here instead.
      // Entry clicks need no profile, and form pages keep the profile-first
      // resume path (fills would run empty without it).
      if (recognizedCount(lastFields) === 0 && findApplyEntry(document, lastAdapter)) {
        void maybeResumeFlow();
      }
    } else {
      announceIfFormHost();
    }
  }

  /**
   * A child frame that owns a real form tells the top frame about it (the panel
   * lives in the top frame; this frame can't reach it directly). Re-announcing
   * on later scans is the retry if the top frame wasn't listening yet.
   */
  function announceIfFormHost(): void {
    if (isTopFrame) return;
    const recognized = recognizedCount(lastFields);
    if (recognized < MIN_FIELDS_FOR_OVERLAY) return;
    actingAsRemoteHost = true;
    void chrome.runtime
      .sendMessage({ type: "FORM_HOST_ANNOUNCE", recognized, fields: lastFields })
      .catch(() => {});
  }

  // Career sites (Databricks/Greenhouse, Workday…) lazily mount the real form
  // after the page settles, the consent banner, or on scroll. When the panel is
  // opened and nothing fillable is visible yet, briefly re-scan so a form that
  // mounts a moment later is still detected. Bounded + stops as soon as a
  // recognized field appears, so it never polls indefinitely.
  let lateMountTimer: ReturnType<typeof setTimeout> | null = null;
  function watchForLateMount(attemptsLeft = 12): void {
    if (lateMountTimer) clearTimeout(lateMountTimer);
    if (attemptsLeft <= 0) {
      lateMountTimer = null;
      return;
    }
    lateMountTimer = setTimeout(() => {
      lateMountTimer = null;
      runScan();
      engine?.updateRegistry(registry);
      reportFields();
      if (!isTopFrame) announceIfFormHost();
      if (recognizedCount(lastFields) === 0) watchForLateMount(attemptsLeft - 1);
    }, 1000);
  }

  // ---- Popup-driven messaging ------------------------------------------------

  chrome.runtime.onMessage.addListener(
    (message: ContentRequest, _sender, sendResponse): boolean => {
      switch (message.type) {
        case "PING": {
          const response: PingResponse = { ok: true, frameToken: FRAME_TOKEN };
          sendResponse(response);
          return false;
        }

        case "TOGGLE_PANEL": {
          if (isTopFrame && adoptedRemote && remoteCallbacks) {
            // The form lives in a child frame — toggle the adopted panel as-is,
            // never a local re-scan that would show the empty top-frame DOM.
            toggleOverlay({ fields: remoteFields, tabUrl: location.href }, remoteCallbacks);
          } else if (isTopFrame) {
            // Re-scan on open so a lazily-/late-mounted form (common on SPA
            // career sites, where the real form mounts after the consent
            // banner) is reflected immediately, and keep watching for mounts
            // that happen while the panel is open.
            runScan();
            ensureObserver();
            const state = {
              fields: lastFields,
              tabUrl: location.href,
              applyEntry: findApplyEntry(document, lastAdapter)?.label ?? null,
            };
            toggleOverlay(state, overlayCallbacks);
            // Nothing fillable yet? Watch briefly for a lazy-mounted form.
            if (recognizedCount(lastFields) === 0) watchForLateMount();
          }
          sendResponse({ ok: true });
          return false;
        }

        case "SCAN_PAGE": {
          lastProfile = message.profile;
          lastFillEEO = message.fillEEO;
          const response = runScan();
          ensureObserver();
          maybeShowOrUpdateOverlay();

          if (response.fields.length > 0) {
            sendResponse(response); // we have the form — answer first
          } else if (isTopFrame) {
            // Empty top frame: give child frames 400ms to claim the scan.
            setTimeout(() => sendResponse(response), 400);
          } else {
            // Empty child frame: answer last, only as a fallback.
            setTimeout(() => sendResponse(response), 900);
          }
          return true; // keep the channel open for the delayed response
        }

        case "FILL_FIELDS": {
          const mine = message.instructions.filter((i) =>
            i.fieldId.startsWith(`${FRAME_TOKEN}-`)
          );
          if (mine.length > 0) {
            void getEngine()
              .run(mine, registry)
              .then((reports) => {
                const response: FillResponse = {
                  ok: true,
                  outcomes: reports.map(reportToOutcome),
                };
                sendResponse(response);
              });
            return true; // engine resolves after the stability window
          }
          if (isTopFrame) {
            // Fallback so the popup always gets *some* answer if the owning
            // frame disappeared (e.g. iframe navigated away). The owning frame
            // now answers only after its reconciliation settles (up to a few
            // ~800ms cycles), so this must wait long enough not to beat a real
            // owner whose form lives in a child iframe.
            const response: FillResponse = {
              ok: false,
              error: "The form's frame is gone — rescan the page",
              outcomes: [],
            };
            setTimeout(() => sendResponse(response), 3000);
            return true;
          }
          return false; // not ours, stay silent
        }

        case "FORM_OP": {
          // This frame owns the form; run the requested overlay op locally and
          // return its result to the top-frame panel (via the background relay).
          void dispatchFormOp(overlayCallbacks, message.op, message.args).then(sendResponse);
          return true; // async
        }

        case "REMOTE_FORM_AVAILABLE": {
          // A child frame owns a form. Adopt it only if WE have no form of our
          // own and haven't already mounted a panel for it.
          if (
            isTopFrame &&
            !overlayShown &&
            shouldAdoptRemoteHost(recognizedCount(lastFields), message.recognized)
          ) {
            const frameId = message.frameId;
            const send = (op: FormOpName, args: unknown[]): Promise<FormOpResult> =>
              sendToRuntime<FormOpResult>({ type: "RELAY_FORM_OP", frameId, op, args }) as Promise<FormOpResult>;
            remoteFields = message.fields;
            remoteCallbacks = makeProxyCallbacks(send);
            // The AI modal opens an iframe overlay in THIS (panel) frame, so it
            // must run locally rather than being proxied to the adopted subframe.
            remoteCallbacks.onOpenAiModal = overlayCallbacks.onOpenAiModal;
            overlayShown = true;
            adoptedRemote = true;
            console.log(`[Tailrd overlay] adopting form in frame ${frameId} (${message.recognized} recognized fields)`);
            showOverlay({ fields: remoteFields, tabUrl: location.href }, remoteCallbacks);
          }
          sendResponse({ ok: true });
          return false;
        }

        case "REMOTE_FIELDS_UPDATED": {
          // The child host re-scanned (profile / rescan / mutation) — refresh.
          if (isTopFrame && adoptedRemote) {
            remoteFields = message.fields;
            updateOverlay({ fields: remoteFields, tabUrl: location.href });
          }
          sendResponse({ ok: true });
          return false;
        }

        case "REMOTE_FLOW_PROGRESS": {
          // The child host's flow beat — render it on the adopted panel.
          if (isTopFrame && adoptedRemote) updateFlowProgress(message.progress);
          sendResponse({ ok: true });
          return false;
        }

        default:
          return false;
      }
    }
  );

  // Kick off autonomous detection after the initial layout settles.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    autoInit();
  } else {
    window.addEventListener("DOMContentLoaded", autoInit, { once: true });
  }
}
