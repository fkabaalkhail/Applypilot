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
  BackgroundRequest,
  ContentRequest,
  DetectedField,
  FieldsUpdatedEvent,
  FillResponse,
  PingResponse,
  ResumeFileResponse,
  ResumesResponse,
  ScanResponse,
  UserApplicationProfile,
} from "../shared/types";
import { fillFields } from "./autofill";
import { base64ToFile, injectResumeFile } from "./fileUpload";
import { FRAME_TOKEN, observePage, scanPage, type RuntimeControl } from "./formScanner";
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

function initialize(): void {
  let registry: Map<string, RuntimeControl> = new Map();
  let lastFields: DetectedField[] = [];
  // Remembered so MutationObserver rescans can recompute proposed values.
  let lastProfile: UserApplicationProfile | null = null;
  let lastFillEEO = false;
  let observer: MutationObserver | null = null;
  let overlayShown = false;

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
      const wanted = new Set(ids);
      const instructions = lastFields
        .filter((f) => wanted.has(f.id) && f.fillable && f.proposedValue !== null)
        .map((f) => ({ fieldId: f.id, value: f.proposedValue as string }));
      const outcomes = fillFields(instructions, registry);
      const ok = outcomes.filter((o) => o.ok).length;
      return { ok, fail: outcomes.length - ok, total: instructions.length };
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
  };

  function maybeShowOrUpdateOverlay(): void {
    if (!isTopFrame) return;
    const state = { fields: lastFields, tabUrl: location.href };
    if (!overlayShown && recognizedCount(lastFields) >= MIN_FIELDS_FOR_OVERLAY) {
      overlayShown = true;
      showOverlay(state, overlayCallbacks);
    } else if (overlayShown) {
      updateOverlay(state);
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
            const response: FillResponse = { ok: true, outcomes: fillFields(mine, registry) };
            sendResponse(response);
            return false;
          }
          if (isTopFrame) {
            // Fallback so the popup always gets *some* answer if the owning
            // frame disappeared (e.g. iframe navigated away).
            const response: FillResponse = {
              ok: false,
              error: "The form's frame is gone — rescan the page",
              outcomes: [],
            };
            setTimeout(() => sendResponse(response), 600);
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
