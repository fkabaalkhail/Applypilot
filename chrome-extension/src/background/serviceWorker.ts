/**
 * Background service worker (MV3).
 *
 * Owns everything that talks to the Tailrd backend — the popup and content
 * scripts never fetch directly. Authentication is obtained through the web
 * handshake (api/handshake.ts); data is kept in a single synced snapshot
 * (api/sync.ts) that the UI reads from, online or offline.
 *
 * Note: extension contexts with (optional) host permissions bypass CORS, so the
 * FastAPI backend needs no CORS changes for the extension.
 */
import { connectAccount } from "../api/handshake";
import { AuthRequiredError, checkAuthStatus, ensureFreshAccessToken, logout } from "../api/client";
import { downloadResumeFile, getSnapshotForUi, syncIfStale } from "../api/sync";
import { aiFillFields } from "../api/aiFill";
import { saveAnswer } from "../api/answers";
import { renderResume, tailorResume } from "../api/tailorResume";
import { generateCoverLetter, renderCoverLetter } from "../api/coverLetter";
import { clearSessionExpired, getConfig, getSessionExpired, getSnapshot, saveConfig } from "../shared/storage";
import type {
  AiFillResponse,
  BackgroundRequest,
  FieldsUpdatedEvent,
  GenerateCoverLetterResponse,
  LoginResponse,
  ProfileResponse,
  RenderCoverLetterResponse,
  RenderResumeResponse,
  ResumeFileResponse,
  ResumesResponse,
  SimpleResponse,
  StatusResponse,
  SyncResponse,
  TailorResumeResponse,
} from "../shared/types";

/** Periodic sync alarm — keeps the cached snapshot fresh while active. */
const SYNC_ALARM = "tailrd-sync";

function ensureSyncAlarm(): void {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  // getConfig() merges defaults, so no seeding is required.
  ensureSyncAlarm();
  void syncIfStale().catch(() => {});
});

// Re-arm the alarm and sync once whenever the worker spins up (startup).
chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
  void syncIfStale().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void ensureFreshAccessToken()
      .catch(() => {})
      .finally(() => void syncIfStale().catch(() => {}));
  }
});

// When the user clicks the extension icon in the toolbar, make sure the content
// script is in the TOP frame (which hosts the side-panel overlay) and tell it to
// toggle the panel open.
//
// We deal with the top frame *specifically* (frameId 0) rather than broadcasting:
//  - A broadcast PING can be answered by a sub-frame (an embedded ATS form, or a
//    reCAPTCHA iframe), which would make us think the page is injected when the
//    top frame — the only place the overlay can mount — actually isn't. The panel
//    would then silently fail to open.
//  - A single all-frames injection can reject when a page has cross-origin or
//    sandboxed frames (very common on pages that use reCAPTCHA). The old code let
//    that rejection abort the whole open. We now inject the top frame on its own,
//    and only best-effort the sub-frames so their failure can't block the panel.
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (!tabId || !tab.url || !/^https?:/i.test(tab.url)) return;

  // Is the content script already in the TOP frame?
  let topFrameReady = false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId: 0 });
    topFrameReady = true;
  } catch {
    topFrameReady = false;
  }

  if (!topFrameReady) {
    // Inject the top frame first — this is what the overlay needs. The content
    // script self-guards against double injection, so this is harmless if a
    // race already added it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ["contentScript.js"],
      });
    } catch {
      return; // Restricted page (chrome://, Web Store, PDF viewer, …) — can't open.
    }

    // Best-effort: also inject sub-frames so embedded application forms get
    // scanned/filled. This can reject on cross-origin / sandboxed frames (e.g.
    // reCAPTCHA), which must NOT prevent the panel from opening — hence its own
    // detached catch.
    chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ["contentScript.js"] })
      .catch(() => {});
  }

  // Toggle the panel in the top frame specifically.
  const toggleTop = () =>
    chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PANEL" }, { frameId: 0 });
  try {
    await toggleTop();
  } catch {
    // Content script may not be ready yet — retry once after a brief delay.
    setTimeout(() => void toggleTop().catch(() => {}), 300);
  }
});

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest | FieldsUpdatedEvent, _sender, sendResponse) => {
    // Content scripts emit FIELDS_UPDATED for the popup; not addressed to us.
    if (!message || typeof message.type !== "string" || message.type === "FIELDS_UPDATED") {
      return false;
    }

    // --- Cross-frame relay (form lives in a child iframe) --------------------
    // These messages move between frames of one tab; they need sender identity,
    // so they're handled here (not in handle()).
    const tabId = _sender.tab?.id;
    if (message.type === "FORM_HOST_ANNOUNCE") {
      // A child frame owns a form — tell the top frame which frame, plus fields.
      if (tabId !== undefined && _sender.frameId !== undefined && _sender.frameId !== 0) {
        void chrome.tabs
          .sendMessage(
            tabId,
            {
              type: "REMOTE_FORM_AVAILABLE",
              frameId: _sender.frameId,
              recognized: message.recognized,
              fields: message.fields,
            },
            { frameId: 0 }
          )
          .catch(() => {});
      }
      return false;
    }
    if (message.type === "RELAY_TO_TOP") {
      if (tabId !== undefined) {
        void chrome.tabs.sendMessage(tabId, message.payload, { frameId: 0 }).catch(() => {});
      }
      return false;
    }
    if (message.type === "RELAY_FORM_OP") {
      // Top frame → owning child frame; bridge the response back.
      if (tabId === undefined) {
        sendResponse({ ok: false, error: "No tab" });
        return false;
      }
      chrome.tabs
        .sendMessage(tabId, { type: "FORM_OP", op: message.op, args: message.args }, { frameId: message.frameId })
        .then(sendResponse)
        .catch((err: unknown) => {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : "Frame unreachable" });
        });
      return true; // async response
    }

    handle(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Unexpected error",
        });
      });
    return true; // async response
  }
);

export async function handle(
  message: BackgroundRequest
): Promise<
  | StatusResponse
  | ProfileResponse
  | LoginResponse
  | SimpleResponse
  | ResumesResponse
  | ResumeFileResponse
  | SyncResponse
  | AiFillResponse
  | TailorResumeResponse
  | RenderResumeResponse
  | GenerateCoverLetterResponse
  | RenderCoverLetterResponse
> {
  switch (message.type) {
    case "GET_STATUS": {
      const config = await getConfig();
      if (config.useMockData) {
        return { ok: true, mode: "mock", apiBaseUrl: config.apiBaseUrl };
      }
      const status = await checkAuthStatus();
      if (!status.connected) {
        if (await getSessionExpired()) {
          const cached = await getSnapshot();
          if (cached) {
            const p = cached.snapshot.profile;
            return {
              ok: true,
              mode: "sessionExpired",
              email: p.email || undefined,
              firstName: p.firstName || undefined,
              lastName: p.lastName || undefined,
              apiBaseUrl: config.apiBaseUrl,
              subscription: cached.snapshot.subscription,
              usage: cached.snapshot.usage,
            };
          }
        }
        return { ok: true, mode: "signedOut", apiBaseUrl: config.apiBaseUrl };
      }
      // Surface subscription + usage from the cached snapshot when available.
      const cached = await getSnapshot();
      return {
        ok: true,
        mode: "connected",
        email: status.email,
        firstName: status.firstName,
        lastName: status.lastName,
        apiBaseUrl: config.apiBaseUrl,
        subscription: cached?.snapshot.subscription,
        usage: cached?.snapshot.usage,
      };
    }

    case "CONNECT": {
      try {
        await connectAccount();
        await clearSessionExpired();
        // Connecting always means leaving sample-data mode.
        await saveConfig({ useMockData: false });
        await syncIfStale().catch(() => {});
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Could not connect your account",
        };
      }
    }

    case "LOGOUT": {
      await logout();
      return { ok: true };
    }

    case "GET_PROFILE": {
      try {
        // Cheaply check the sync version; pull a fresh snapshot only if the web
        // app changed something.
        if (!message.forceRefresh) await syncIfStale().catch(() => false);
        const { snapshot, source } = await getSnapshotForUi(message.forceRefresh);
        return { ok: true, profile: snapshot.profile, source };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Could not load profile",
        };
      }
    }

    case "GET_RESUMES": {
      try {
        const { snapshot } = await getSnapshotForUi();
        return { ok: true, resumes: snapshot.resumes };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, resumes: [], error: err.message };
        }
        return {
          ok: false,
          resumes: [],
          error: err instanceof Error ? err.message : "Could not load resumes",
        };
      }
    }

    case "GET_SYNC": {
      try {
        if (!message.forceRefresh) await syncIfStale().catch(() => false);
        const { snapshot, source } = await getSnapshotForUi(message.forceRefresh);
        return { ok: true, snapshot, source };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Could not sync",
        };
      }
    }

    case "DOWNLOAD_RESUME": {
      try {
        const { dataBase64, name, contentType } = await downloadResumeFile(message.resumeId);
        return { ok: true, dataBase64, name, contentType };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, name: "", contentType: "", error: err.message };
        }
        return {
          ok: false,
          name: "",
          contentType: "",
          error: err instanceof Error ? err.message : "Could not download resume",
        };
      }
    }

    case "AI_FILL": {
      try {
        const { answers, errors } = await aiFillFields(message.fields, message.jobContext);
        return { ok: true, answers, errors };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, answers: [], errors: [err.message] };
        }
        return {
          ok: false,
          answers: [],
          errors: [err instanceof Error ? err.message : "AI fill failed"],
        };
      }
    }

    case "SAVE_ANSWER": {
      try {
        await saveAnswer(message.question, message.answer, message.jobContext);
        return { ok: true };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
      }
    }

    case "TAILOR_RESUME": {
      try {
        const result = await tailorResume(
          message.resumeId, message.jobContext, message.sections, message.addKeywords
        );
        return { ok: true, result };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : "Tailoring failed" };
      }
    }

    case "RENDER_RESUME": {
      try {
        const { dataBase64, name, contentType } = await renderResume(message.document, message.filename);
        return { ok: true, dataBase64, name, contentType };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, name: "", contentType: "", error: err.message };
        }
        return { ok: false, name: "", contentType: "", error: err instanceof Error ? err.message : "Render failed" };
      }
    }

    case "GENERATE_COVER_LETTER": {
      try {
        const { text } = await generateCoverLetter(
          message.resumeId, message.jobContext, message.tone, message.baseText
        );
        return { ok: true, text };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, error: err.message };
        }
        return { ok: false, error: err instanceof Error ? err.message : "Cover-letter generation failed" };
      }
    }

    case "RENDER_COVER_LETTER": {
      try {
        const { dataBase64, name, contentType } = await renderCoverLetter(message.text, message.filename);
        return { ok: true, dataBase64, name, contentType };
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { ok: false, needsLogin: true, name: "", contentType: "", error: err.message };
        }
        return { ok: false, name: "", contentType: "", error: err instanceof Error ? err.message : "Render failed" };
      }
    }

    case "OPEN_DASHBOARD": {
      const { dashboardUrl } = await getConfig();
      await chrome.tabs.create({ url: dashboardUrl });
      return { ok: true };
    }
    default:
      // Cross-frame relay messages (FORM_HOST_ANNOUNCE / RELAY_FORM_OP /
      // RELAY_TO_TOP) are intercepted in the onMessage listener before handle()
      // runs, so reaching here means an unrecognized message.
      return { ok: false, error: "Unhandled background message" };
  }
}
