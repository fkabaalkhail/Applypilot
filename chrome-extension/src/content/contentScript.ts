/**
 * Content script entry point.
 *
 * Runs in every frame of supported ATS pages (declared in the manifest) and
 * is injected on demand into any other page via the popup's Scan button.
 *
 * Two ways it is used:
 *  1. Autonomously — on the top frame it scans for an application form and, when
 *     it finds one, fetches the profile from the background and shows the in-page
 *     overlay (auto-expanded once). This is the "auto pop-up" the user sees.
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
  ProfileResponse,
  ScanResponse,
  StatusResponse,
  UserApplicationProfile,
} from "../shared/types";
import { fillFields } from "./autofill";
import { FRAME_TOKEN, observePage, scanPage, type RuntimeControl } from "./formScanner";
import {
  showOverlay,
  updateOverlay,
  type OverlayCallbacks,
  type OverlayStatus,
} from "./overlay";

// Guard against double injection (manifest match + programmatic inject).
declare global {
  interface Window {
    __apContentScriptLoaded?: boolean;
  }
}

/** Below this many recognized, fillable fields we don't auto-show the overlay. */
const MIN_FIELDS_FOR_OVERLAY = 2;

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

  // Overlay state (top frame only).
  let overlayShown = false;
  let overlayStatus: OverlayStatus = "offline";
  let overlayProfileName = "";
  let profileFetched = false;
  let profileFetchPromise: Promise<void> | null = null;

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
      // Keep the in-page overlay in sync with the live form.
      void maybeShowOverlay();
    });
  }

  // ---- Autonomous overlay ----------------------------------------------------

  function recognizedFillableCount(fields: DetectedField[]): number {
    return fields.filter((f) => f.category !== "unknown" && f.fillable && !f.sensitive).length;
  }

  async function fetchProfileForOverlay(): Promise<void> {
    const status = await sendToBackground<StatusResponse>({ type: "GET_STATUS" }).catch(() => null);
    overlayStatus = status && status.ok ? status.mode : "offline";
    // Account name is the fallback display name until the full profile loads.
    if (status) {
      overlayProfileName = [status.firstName, status.lastName].filter(Boolean).join(" ");
    }

    if (overlayStatus === "signedOut" || overlayStatus === "offline") {
      lastProfile = null;
      profileFetched = true;
      return;
    }

    const resp = await sendToBackground<ProfileResponse>({ type: "GET_PROFILE" }).catch(() => null);
    if (resp && resp.ok && resp.profile) {
      lastProfile = resp.profile;
      const name = [resp.profile.firstName, resp.profile.lastName].filter(Boolean).join(" ");
      if (name) overlayProfileName = name;
    } else if (resp && resp.needsLogin) {
      overlayStatus = "signedOut";
      lastProfile = null;
    }
    profileFetched = true;
  }

  function ensureProfileFetched(): Promise<void> {
    if (profileFetched) return Promise.resolve();
    if (!profileFetchPromise) {
      profileFetchPromise = fetchProfileForOverlay().finally(() => {
        profileFetchPromise = null;
      });
    }
    return profileFetchPromise;
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
    onOpenDashboard: () => {
      void sendToBackground({ type: "OPEN_DASHBOARD" });
    },
    onRescan: () => {
      runScan();
      void maybeShowOverlay();
    },
  };

  async function maybeShowOverlay(): Promise<void> {
    if (!isTopFrame) return;
    if (recognizedFillableCount(lastFields) < MIN_FIELDS_FOR_OVERLAY) return;

    const needRescan = !profileFetched;
    await ensureProfileFetched();
    if (needRescan) runScan(); // recompute proposed values now that we have the profile

    const state = { status: overlayStatus, profileName: overlayProfileName, fields: lastFields };
    if (!overlayShown) {
      overlayShown = true;
      showOverlay(state, overlayCallbacks);
    } else {
      updateOverlay(state);
    }
  }

  function autoInit(): void {
    if (!isTopFrame) return;
    runScan();
    ensureObserver();
    void maybeShowOverlay();
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

        case "SCAN_PAGE": {
          lastProfile = message.profile;
          lastFillEEO = message.fillEEO;
          const response = runScan();
          ensureObserver();
          // The popup just gave us a fresh profile — refresh the overlay too.
          void maybeShowOverlay();

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
