/**
 * Content script entry point.
 *
 * Runs in every frame of supported ATS pages (declared in the manifest) and
 * is injected on demand into any other page via the popup's Scan button.
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
  ContentRequest,
  DetectedField,
  FieldsUpdatedEvent,
  FillResponse,
  PingResponse,
  ScanResponse,
  UserApplicationProfile,
} from "../shared/types";
import { fillFields } from "./autofill";
import { FRAME_TOKEN, observePage, scanPage, type RuntimeControl } from "./formScanner";

// Guard against double injection (manifest match + programmatic inject).
declare global {
  interface Window {
    __apContentScriptLoaded?: boolean;
  }
}

if (!window.__apContentScriptLoaded) {
  window.__apContentScriptLoaded = true;
  initialize();
}

function initialize(): void {
  let registry: Map<string, RuntimeControl> = new Map();
  let lastFields: DetectedField[] = [];
  // Remembered so MutationObserver rescans can recompute proposed values.
  let lastProfile: UserApplicationProfile | null = null;
  let lastFillEEO = false;
  let observer: MutationObserver | null = null;

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

  /** Start watching for SPA re-renders after the first scan request. */
  function ensureObserver(): void {
    if (observer) return;
    observer = observePage(() => {
      const before = lastFields.length;
      runScan();
      if (lastFields.length !== before) {
        // Let the popup know (it refreshes if open; background ignores this).
        const event: FieldsUpdatedEvent = {
          type: "FIELDS_UPDATED",
          url: location.href,
          fieldCount: lastFields.length,
        };
        void chrome.runtime.sendMessage(event).catch(() => {
          // Popup closed — nobody listening. That's fine.
        });
      }
    });
  }

  chrome.runtime.onMessage.addListener(
    (message: ContentRequest, _sender, sendResponse): boolean => {
      switch (message.type) {
        case "PING": {
          const response: PingResponse = { ok: true, frameToken: FRAME_TOKEN };
          sendResponse(response);
          return false;
        }

        case "SCAN_PAGE": {
          lastProfile = message.profile;
          lastFillEEO = message.fillEEO;
          const response = runScan();
          ensureObserver();

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
}
