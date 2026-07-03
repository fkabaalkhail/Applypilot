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
  ControlType,
  CoverLetterGenOpts,
  DetectedField,
  FieldCategory,
  FieldsUpdatedEvent,
  FillResponse,
  FlowProgress,
  FlowState,
  FlowStateResponse,
  FormOpName,
  FormOpResult,
  GenerateCoverLetterResponse,
  PingResponse,
  ProfileResponse,
  RecordApplicationResponse,
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
import { deepQueryAll } from "./domUtils";
import { base64ToFile, downloadBase64File, injectResumeFile } from "./fileUpload";
import { FRAME_TOKEN, observePage, scanPage, selectOptions, type RuntimeControl } from "./formScanner";
import { LONG_TEXT } from "./fieldMatcher";
import { AutofillReconciler, type FieldReport } from "./reconciler";
import { defaultSelectedIds } from "../shared/selection";
import { extractJobContext } from "./jobContext";
import { aiFillCandidates, planAiFill, planFillRoute, planReaskFields, tallyOutcomes, toAiFillField, type PlannedAnswer, type ReaskCandidate } from "./aiFillPlanner";
import { splitByCache, cacheAnswers } from "./answerCache";
import { promptForMissingFields, type MissingFieldPrompt } from "./missingInfoModal";
import { buildProfilePatch, isProfileCategory } from "../shared/profileCategories";
import { AUTOFILL_CONFIDENCE_THRESHOLD } from "../shared/constants";
import { fillAriaCombobox } from "./comboboxEngine";
import { driveField } from "./mainWorldClient";
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
import { FlowController, FLOW_TTL_MS, type FlowDeps, type FlowSnapshot, type StepTally } from "./flowController";
import { clickAdvance, findAdvanceButton } from "./advance";
import { hasUnsolvedCaptcha, isVerificationWall, resumeFieldNeedingFile, validationMessages } from "./flowChecks";
import { detectWall, runAccountWall } from "./accountFlow";
import { bindSubmitTracking, type SubmitTrackerHandle } from "./submitTracker";

// Guard against double injection (manifest match + programmatic inject).
declare global {
  interface Window {
    __apContentScriptLoaded?: boolean;
  }
}

/** Show the overlay after detecting at least this many recognizable fields. */
const MIN_FIELDS_FOR_OVERLAY = 1;

if (!window.__apContentScriptLoaded) {
  window.__apContentScriptLoaded = true;
  initialize();
}

function sendToBackground<T>(message: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
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
  // Remembered so MutationObserver rescans can recompute proposed values.
  let lastProfile: UserApplicationProfile | null = null;
  let lastFillEEO = false;
  let observer: MutationObserver | null = null;
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
      void chrome.runtime
        .sendMessage({ type: "RELAY_TO_TOP", payload: { type: "REMOTE_FIELDS_UPDATED", fields: lastFields } })
        .catch(() => {});
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

  /**
   * Fill custom ARIA dropdowns one at a time by opening the listbox and clicking
   * the matching option (comboboxEngine). Sequential so two menus never fight,
   * and deliberately NOT handed to the reconciler — re-driving a dropdown on
   * every mutation is the churn we avoid. Returns popup-style outcomes.
   */
  async function fillComboboxTargets(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      const el = registry.get(t.fieldId)?.el;
      if (!el) {
        outcomes.push({ fieldId: t.fieldId, ok: false });
        continue;
      }
      const res = await fillAriaCombobox(el, t.value);
      outcomes.push({ fieldId: t.fieldId, ok: res.filled });
      if (!res.filled && res.options) reask.push({ fieldId: t.fieldId, options: res.options });
    }
    return { outcomes, reask };
  }

  /** Fill react-select / Workday fields via the MAIN-world driver. */
  async function fillDriverTargets(
    targets: { fieldId: string; value: string }[]
  ): Promise<{ outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    const reask: ReaskCandidate[] = [];
    for (const t of targets) {
      const control = registry.get(t.fieldId);
      if (!control?.driver) { outcomes.push({ fieldId: t.fieldId, ok: false }); continue; }
      const res = await driveField(t.fieldId, t.value, control.driver);
      if (res.ok || !control.el) {
        outcomes.push({ fieldId: t.fieldId, ok: res.ok });
        continue;
      }
      // Driver miss — best-effort ARIA fallback: may fill, or harvest options.
      const fb = await fillAriaCombobox(control.el, t.value);
      outcomes.push({ fieldId: t.fieldId, ok: fb.filled });
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
    merge: boolean
  ): Promise<{ reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] }> {
    if (items.length === 0 && merge) return { reports: [], outcomes: [], reask: [] };
    const { opOutcomes, remaining } = await runAdapterOperations(lastAdapter, items, (id) => registry.get(id));
    const driverTargets = remaining.filter((it) => isDriverField(it.fieldId));
    const comboTargets = remaining.filter((it) => !isDriverField(it.fieldId) && isComboboxField(it.fieldId));
    const reconTargets = remaining.filter((it) => !isDriverField(it.fieldId) && !isComboboxField(it.fieldId));
    const reports = merge
      ? reconTargets.length
        ? await getEngine().addTargets(reconTargets, registry)
        : []
      : await getEngine().run(reconTargets, registry);
    const combo = comboTargets.length
      ? await fillComboboxTargets(comboTargets)
      : { outcomes: [], reask: [] };
    const driver = driverTargets.length
      ? await fillDriverTargets(driverTargets)
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
  // Free-text control types worth asking the user about when required + empty.
  const PROMPTABLE_TYPES = new Set<ControlType>(["text", "textarea", "contenteditable"]);

  /** True when the control for `id` currently holds no user-visible value. */
  function controlIsEmpty(id: string): boolean {
    const el = registry.get(id)?.el;
    if (!el) return true;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return !el.value.trim();
    }
    return !(el.textContent ?? "").trim();
  }

  /**
   * After a fill pass, prompt for the still-empty free-text questions that
   * neither the profile, the answer bank, nor the AI could fill — either because
   * they're REQUIRED, or because they map to a personal-info profile field we
   * don't have yet (name, phone, address, links, work-authorization, salary…).
   * Fills whatever the user provides, then persists it so the NEXT application
   * fills it automatically:
   *   - answers that map to a profile field → the application profile
   *     (UPDATE_PROFILE), so they also appear in Autofill Information + the web
   *     app Profile page;
   *   - everything else → the answer bank / Question Memory (SAVE_ANSWER).
   * EEO/sensitive fields are never prompted (they fill from the profile only).
   */
  async function promptMissingInfo(): Promise<{
    reports: FieldReport[];
    outcomes: { fieldId: string; ok: boolean }[];
  }> {
    const empty = { reports: [], outcomes: [] };
    const candidates = lastFields.filter(
      (f) =>
        f.fillable &&
        !f.sensitive &&
        (f.required || isProfileCategory(f.category)) &&
        PROMPTABLE_TYPES.has(f.controlType) &&
        controlIsEmpty(f.id)
    );
    if (candidates.length === 0) return empty;

    const prompts: MissingFieldPrompt[] = candidates.map((f) => ({
      id: f.id,
      label: f.label,
      multiline: f.controlType === "textarea" || f.controlType === "contenteditable",
    }));

    const answers = await promptForMissingFields(prompts).catch(() => null);
    if (!answers || Object.keys(answers).length === 0) return empty;

    const targets = Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value }));
    const filled = await fillItems(targets, true);

    // Persist each answer so it auto-fills next time. Answers that correspond to
    // a real profile field are saved back to the application profile (so they
    // show up in Autofill Information + the web app Profile and sync everywhere);
    // free-form screening answers go to the answer bank / Question Memory.
    const jobContext = extractJobContext();
    const profileEntries: { category: FieldCategory; value: string }[] = [];
    for (const [fieldId, value] of Object.entries(answers)) {
      const f = lastFields.find((x) => x.id === fieldId);
      if (!f) continue;
      if (isProfileCategory(f.category)) {
        profileEntries.push({ category: f.category, value });
      } else {
        void sendToBackground<SimpleResponse>({
          type: "SAVE_ANSWER",
          question: f.label,
          answer: value,
          jobContext,
        }).catch(() => {});
      }
    }
    const patch = buildProfilePatch(profileEntries);
    if (Object.keys(patch).length > 0) {
      void sendToBackground<ProfileResponse>({ type: "UPDATE_PROFILE", update: patch }).catch(
        () => {}
      );
    }
    return { reports: filled.reports, outcomes: filled.outcomes };
  }

  async function fillOnce(ids: string[] | null): Promise<StepTally> {
      const wanted = ids ? new Set(ids) : defaultSelectedIds(lastFields);
      const selected = lastFields.filter(
        (f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null
      );

      // Phase A — deterministic profile fields fill instantly (local fast-path).
      const route = planFillRoute(selected, AUTOFILL_CONFIDENCE_THRESHOLD);
      const localFill = await fillItems(route.localTargets, false);

      // Phase B — judgment fields answered by the backend (primary), deduped by the
      // session cache; also the eligible EMPTY fields (today's AI candidates). The
      // local proposedValue is the fallback so a judgment field never regresses when
      // the backend is unavailable.
      const backendFields = dedupeById([...route.backendFields, ...aiFillCandidates(lastFields)]);
      let aiFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      let fallbackFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      if (backendFields.length > 0) {
        const { hits, misses } = splitByCache(backendFields);
        let answers: PlannedAnswer[] = hits;
        try {
          if (misses.length > 0) {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: misses.map(toAiFillField),
              jobContext: extractJobContext(),
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
        aiFill = await fillItems(plan.simpleTargets, true);

        // Local fallback: judgment fields that had a local value but weren't answered
        // by the backend still fill from proposedValue — no regression.
        const answered = new Set<string>(plan.simpleTargets.map((t) => t.fieldId));
        const fallbackTargets = route.backendFields
          .filter((f) => !answered.has(f.id) && f.proposedValue !== null)
          .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
        fallbackFill = await fillItems(fallbackTargets, true);
      }

      // One re-ask round: choice controls whose fill missed now carry the
      // widget's REAL options — a single batched AI_FILL snaps the answers
      // ("Canada" → "Canadian"), then a merge pass drives them in.
      let reaskFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      const reaskCandidates = [...localFill.reask, ...aiFill.reask, ...fallbackFill.reask];
      if (reaskCandidates.length > 0) {
        for (const c of reaskCandidates) {
          const f = lastFields.find((x) => x.id === c.fieldId);
          if (f) f.options = c.options; // panel now shows the real choices
        }
        const reaskFields = planReaskFields(lastFields, reaskCandidates);
        if (reaskFields.length > 0) {
          try {
            const resp = await sendToBackground<AiFillResponse>({
              type: "AI_FILL",
              fields: reaskFields,
              jobContext: extractJobContext(),
            });
            if (resp?.ok) {
              const affected = lastFields.filter((f) => reaskFields.some((r) => r.id === f.id));
              cacheAnswers(affected, resp.answers); // overwrite the unconstrained answers
              const plan = planAiFill(affected, resp.answers);
              reaskFill = await fillItems(plan.simpleTargets, true);
            }
          } catch {
            // Backend unreachable — the manual-select outcomes stand.
          }
        }
      }

      // Ask the user for any required question we still couldn't answer, fill
      // their replies, and remember them for next time.
      const missingFill = await promptMissingInfo();

      const { ok, fail, total } = tallyOutcomes(
        localFill.reports,
        aiFill.reports,
        fallbackFill.reports,
        reaskFill.reports,
        missingFill.reports,
        localFill.outcomes,
        aiFill.outcomes,
        fallbackFill.outcomes,
        reaskFill.outcomes,
        missingFill.outcomes
      );
      return { ok, fail, total };
  }

  /** Route a flow progress beat to wherever the panel lives (mirrors reportFields). */
  function emitFlowProgress(p: FlowProgress): void {
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
      fillStep: (ids) => fillOnce(ids),
      snapshot: (): FlowSnapshot => ({ fields: lastFields, scopeEl: lastScope }),
      rescan: () => {
        runScan();
        engine?.updateRegistry(registry);
      },
      findAdvance: (scope, extraAdvance) => findAdvanceButton(scope, lastAdapter, { extraAdvance }),
      clickAdvance,
      onTerminal: (button) => bindSubmitOnce(button),
      accountStep: async (snap) => {
        const scope = snap.scopeEl ?? document.body;
        const wall = detectWall(scope);
        if (!wall) {
          accountBlocked = false;
          return {};
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
        accountBlocked = out.pause === "account";
        return { extraAdvance: out.extraAdvance };
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
      attachResume: attachPickedResume,
      setState: async (state: FlowState | null) => {
        try {
          await sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state });
        } catch {
          // Background asleep — the flow still runs, it just won't survive navigation.
        }
      },
      onProgress: emitFlowProgress,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
  }

  /** Resume a persisted flow after a real navigation (form-owning frame only). */
  async function maybeResumeFlow(): Promise<void> {
    if (flowController) return;
    if (recognizedCount(lastFields) === 0) return; // not the form-owning frame (yet)
    try {
      const resp = await sendToBackground<FlowStateResponse>({ type: "FLOW_STATE_GET" });
      const st = resp?.state;
      if (!st?.active) return;
      if (Date.now() - st.startedAt > FLOW_TTL_MS) {
        void sendToBackground<SimpleResponse>({ type: "FLOW_STATE_SET", state: null }).catch(() => {});
        return;
      }
      if (flowController) return; // an autofill click set it while we awaited FLOW_STATE_GET
      flowController = new FlowController(makeFlowDeps());
      void flowController.run(st, null);
    } catch {
      // Background asleep — the flow simply doesn't resume.
    }
  }

  const overlayCallbacks: OverlayCallbacks = {
    onAutofill: async (ids: string[], uploadResumeId?: number | null) => {
      flowResumeId = uploadResumeId ?? null;
      // One click = one flow. Replace any prior flow, fill this step now (the
      // panel awaits this first tally), then let the controller advance.
      // Invariant: a Stop during this initial fill wins (skip the controller);
      // a fresh click supersedes a background resume that started mid-fill.
      const gen = flowGeneration;
      flowController?.stop();
      const tally = await fillOnce(ids);
      if (gen === flowGeneration) {
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
      return injectResumeFile(
        control.el,
        base64ToFile(file.dataBase64, file.name, file.contentType)
      );
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
      return injectResumeFile(control.el, base64ToFile(file.dataBase64, file.name, file.contentType));
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
        return injectResumeFile(fileControl.el, base64ToFile(file.dataBase64, file.name, file.contentType));
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
    const state = { fields: lastFields, tabUrl: location.href };
    if (!overlayShown && recognizedCount(lastFields) >= MIN_FIELDS_FOR_OVERLAY) {
      overlayShown = true;
      console.log(`[Tailrd overlay] mounting panel (recognized=${recognizedCount(lastFields)} of ${lastFields.length} fields)`);
      showOverlay(state, overlayCallbacks);
    } else if (overlayShown) {
      updateOverlay(state);
    } else if (!overlayShown) {
      console.log(`[Tailrd overlay] NOT mounting — only ${recognizedCount(lastFields)} recognized fields in TOP frame`);
    }
  }

  // ---- Observer ---------------------------------------------------------------

  /** Start watching for SPA re-renders after the first scan request. */
  function ensureObserver(): void {
    if (observer) return;
    observer = observePage(() => {
      const before = lastFields.length;
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
        void chrome.runtime.sendMessage(event).catch(() => {
          // Popup closed — nobody listening. That's fine.
        });
      }
      reportFields();
      if (!isTopFrame) announceIfFormHost();
    });
  }

  function autoInit(): void {
    runScan();
    ensureObserver();
    if (isTopFrame) {
      maybeShowOrUpdateOverlay();
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
            const state = { fields: lastFields, tabUrl: location.href };
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
              chrome.runtime.sendMessage({ type: "RELAY_FORM_OP", frameId, op, args }) as Promise<FormOpResult>;
            remoteFields = message.fields;
            remoteCallbacks = makeProxyCallbacks(send);
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
