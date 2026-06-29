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
  DetectedField,
  FieldsUpdatedEvent,
  FillResponse,
  PingResponse,
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
import { AutofillReconciler, type FieldReport } from "./reconciler";
import { defaultSelectedIds } from "../shared/selection";
import { extractJobContext } from "./jobContext";
import { aiFillCandidates, planAiFill, tallyOutcomes, toAiFillField } from "./aiFillPlanner";
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

  const overlayCallbacks: OverlayCallbacks = {
    onAutofill: async (ids: string[]) => {
      // Phase 1 — local profile fill (unchanged behavior).
      const wanted = new Set(ids);
      const targets = lastFields
        .filter((f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null)
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const localReports = await getEngine().run(targets, registry);

      // Phase 2 — AI fill for fields the profile couldn't answer (best-effort).
      const candidates = aiFillCandidates(lastFields);
      const drafts: AiDraft[] = [];
      let aiReports: FieldReport[] = [];
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
            if (plan.simpleTargets.length > 0) {
              aiReports = await getEngine().addTargets(plan.simpleTargets, registry);
            }
          }
        } catch {
          // AI fill is additive — the local pass already happened. Swallow.
        }
      }

      const { ok, fail, total } = tallyOutcomes(localReports, aiReports);
      return { ok, fail, total, drafts };
    },
    onInsertAnswer: async (fieldId: string, value: string) => {
      const control = registry.get(fieldId);
      if (!control) return { ok: false, reason: "Field is no longer on the page — rescan." };
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
      maybeUpdateOverlay();
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
      updateOverlay({ fields: lastFields, tabUrl: location.href });
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
  };

  function maybeShowOrUpdateOverlay(): void {
    if (!isTopFrame) return;
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

  function maybeUpdateOverlay(): void {
    if (!isTopFrame || !overlayShown) return;
    updateOverlay({ fields: lastFields, tabUrl: location.href });
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
      maybeShowOrUpdateOverlay();
    });
  }

  function autoInit(): void {
    if (!isTopFrame) return;
    runScan();
    ensureObserver();
    maybeShowOrUpdateOverlay();
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
          if (isTopFrame) {
            const state = { fields: lastFields, tabUrl: location.href };
            toggleOverlay(state, overlayCallbacks);
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
