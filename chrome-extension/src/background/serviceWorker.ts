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
import { AuthRequiredError, checkAuthStatus, logout } from "../api/client";
import { downloadResumeFile, getSnapshotForUi, syncIfStale } from "../api/sync";
import { getConfig, getSnapshot, saveConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  FieldsUpdatedEvent,
  LoginResponse,
  ProfileResponse,
  ResumeFileResponse,
  ResumesResponse,
  SimpleResponse,
  StatusResponse,
  SyncResponse,
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
  if (alarm.name === SYNC_ALARM) void syncIfStale().catch(() => {});
});

// When the user clicks the extension icon in the toolbar, inject the content
// script (if needed) and tell it to toggle the side panel open.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) return;

  // Ensure content script is injected
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
  } catch {
    // Not injected yet — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["contentScript.js"],
      });
    } catch {
      return; // Can't inject (chrome://, web store, etc.)
    }
  }

  // Send toggle message to show the side panel
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch {
    // Content script may not be ready yet, retry after a brief delay
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id!, { type: "TOGGLE_PANEL" });
      } catch { /* give up */ }
    }, 300);
  }
});

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest | FieldsUpdatedEvent, _sender, sendResponse) => {
    // Content scripts emit FIELDS_UPDATED for the popup; not addressed to us.
    if (!message || typeof message.type !== "string" || message.type === "FIELDS_UPDATED") {
      return false;
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

async function handle(
  message: BackgroundRequest
): Promise<
  | StatusResponse
  | ProfileResponse
  | LoginResponse
  | SimpleResponse
  | ResumesResponse
  | ResumeFileResponse
  | SyncResponse
> {
  switch (message.type) {
    case "GET_STATUS": {
      const config = await getConfig();
      if (config.useMockData) {
        return { ok: true, mode: "mock", apiBaseUrl: config.apiBaseUrl };
      }
      const status = await checkAuthStatus();
      if (!status.connected) {
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

    case "OPEN_DASHBOARD": {
      const { dashboardUrl } = await getConfig();
      await chrome.tabs.create({ url: dashboardUrl });
      return { ok: true };
    }
  }
}
