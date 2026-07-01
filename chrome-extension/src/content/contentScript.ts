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
  AiDraft,
  AiFillResponse,
  BackgroundRequest,
  ContentRequest,
  CoverLetterGenOpts,
  DetectedField,
  FieldsUpdatedEvent,
  FillResponse,
  FormOpName,
  FormOpResult,
  GenerateCoverLetterResponse,
  PingResponse,
  RenderCoverLetterResponse,
  RenderResumeResponse,
  ResumeDoc,
  ResumeFileResponse,
  ResumesResponse,
  ScanResponse,
  SimpleResponse,
  TailorResumeOpts,
  TailorResumeResponse,
  UserApplicationProfile,
} from "../shared/types";
import { deepQueryAll } from "./domUtils";
import { base64ToFile, downloadBase64File, injectResumeFile } from "./fileUpload";
import { FRAME_TOKEN, observePage, scanPage, type RuntimeControl } from "./formScanner";
import { LONG_TEXT } from "./fieldMatcher";
import { AutofillReconciler, type FieldReport } from "./reconciler";
import { defaultSelectedIds } from "../shared/selection";
import { extractJobContext } from "./jobContext";
import { aiFillCandidates, planAiFill, tallyOutcomes, toAiFillField } from "./aiFillPlanner";
import { fillAriaCombobox } from "./comboboxEngine";
import { dispatchFormOp, makeProxyCallbacks, shouldAdoptRemoteHost } from "./crossFrame";
import {
  findNavButtons,
  isApplicationComplete,
  looksLikeTerminalStep,
  runMultiStep,
  stepSignature,
} from "./multiStep";
import { verifyControl, writeControl } from "./writeEngine";
import {
  showOverlay,
  updateOverlay,
  toggleOverlay,
  type OverlayCallbacks,
} from "./overlay";

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
  let lastFields: DetectedField[] = [];
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
    lastFields = result.fields;
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
  ): Promise<{ fieldId: string; ok: boolean }[]> {
    const outcomes: { fieldId: string; ok: boolean }[] = [];
    for (const t of targets) {
      const el = registry.get(t.fieldId)?.el;
      if (!el) {
        outcomes.push({ fieldId: t.fieldId, ok: false });
        continue;
      }
      const res = await fillAriaCombobox(el, t.value);
      outcomes.push({ fieldId: t.fieldId, ok: res.filled });
    }
    return outcomes;
  }

  /** Whether a tracked field is a custom ARIA dropdown (filled by comboboxEngine). */
  function isComboboxField(fieldId: string): boolean {
    return registry.get(fieldId)?.controlType === "combobox";
  }

  /**
   * One full fill pass over the given field ids: deterministic reconciler write,
   * then custom dropdowns, then a best-effort AI pass for unanswered fields.
   * Shared by the single-page Autofill button and the multi-step orchestrator.
   */
  async function runFillPass(
    ids: string[]
  ): Promise<{ ok: number; fail: number; total: number; drafts: AiDraft[] }> {
    const wanted = new Set(ids);
    const selected = lastFields.filter(
      (f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null
    );

    // Phase 1a — deterministic local fill via the reconciler for everything
    // the synchronous write engine can drive (text/select/checkbox/radio).
    const targets = selected
      .filter((f) => f.controlType !== "combobox")
      .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
    const localReports = await getEngine().run(targets, registry);

    // Phase 1b — custom ARIA dropdowns, driven one-shot by the listbox engine.
    const comboOutcomes = await fillComboboxTargets(
      selected
        .filter((f) => f.controlType === "combobox")
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }))
    );

    // Phase 2 — AI fill for fields the profile couldn't answer (best-effort).
    const candidates = aiFillCandidates(lastFields);
    const drafts: AiDraft[] = [];
    let aiReports: FieldReport[] = [];
    let aiComboOutcomes: { fieldId: string; ok: boolean }[] = [];
    if (candidates.length > 0) {
      try {
        const resp = await sendToBackground<AiFillResponse>({
          type: "AI_FILL",
          fields: candidates.map(toAiFillField),
          jobContext: extractJobContext(),
        });
        if (resp?.ok) {
          const plan = planAiFill(candidates, resp.answers);
          drafts.push(...plan.drafts);
          // Silent answers: custom dropdowns go through the listbox engine
          // (writeControl can't script them); everything else via the reconciler.
          const aiCombo = plan.simpleTargets.filter((t) => isComboboxField(t.fieldId));
          const aiSimple = plan.simpleTargets.filter((t) => !isComboboxField(t.fieldId));
          if (aiSimple.length > 0) {
            aiReports = await getEngine().addTargets(aiSimple, registry);
          }
          if (aiCombo.length > 0) {
            aiComboOutcomes = await fillComboboxTargets(aiCombo);
          }
        }
      } catch {
        // AI fill is additive — the local pass already happened. Swallow.
      }
    }

    const { ok, fail, total } = tallyOutcomes(localReports, aiReports, comboOutcomes, aiComboOutcomes);
    return { ok, fail, total, drafts };
  }

  const overlayCallbacks: OverlayCallbacks = {
    onAutofill: (ids: string[]) => runFillPass(ids),
    onAutoContinue: async () => {
      // Drive a multi-page (Workday-style) flow: fill the current page, click
      // Next, confirm the turn, re-scan + re-fill, halting at the review step.
      // Never submits. Runs in whichever frame owns the form (this one).
      const result = await runMultiStep(
        {
          fillCurrentPage: async () => {
            runScan();
            engine?.updateRegistry(registry);
            const ids = [...defaultSelectedIds(lastFields)];
            await runFillPass(ids);
            reportFields();
          },
          signature: () => stepSignature(document, location),
          navButtons: () => findNavButtons(document),
          // Stop before any terminal/review step — Workday progress bar when
          // present, else generic heading/submit-button detection.
          atReviewStep: () => looksLikeTerminalStep(document),
          isComplete: () => isApplicationComplete(location, document),
          click: (el) => el.click(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          log: (msg) => console.log("[Tailrd multi-step]", msg),
        },
        {}
      );
      return result;
    },
    onInsertAnswer: async (fieldId: string, value: string) => {
      const control = registry.get(fieldId);
      if (!control) return { ok: false, reason: "Field is no longer on the page — rescan." };
      // Custom dropdowns can't be scripted by writeControl — open the listbox
      // and click the option matching the (accepted) answer instead.
      if (control.controlType === "combobox") {
        if (!control.el) return { ok: false, reason: "Dropdown is no longer on the page — rescan." };
        const res = await fillAriaCombobox(control.el, value);
        return res.filled
          ? { ok: true }
          : { ok: false, reason: res.reason ?? "Couldn't select that option — choose it manually." };
      }
      const res = writeControl(control, value);
      if (!res.written) return { ok: false, reason: res.reason };
      return verifyControl(control, value)
        ? { ok: true }
        : { ok: false, reason: "Value did not stick — please check the field." };
    },
    onSaveAnswer: async (question: string, answer: string) => {
      // Best-effort: the field is already filled; remembering it is a bonus.
      try {
        const resp = await sendToBackground<SimpleResponse>({
          type: "SAVE_ANSWER",
          question,
          answer,
          jobContext: extractJobContext(),
        });
        return { ok: !!resp?.ok };
      } catch {
        return { ok: false };
      }
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
