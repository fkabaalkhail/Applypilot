/**
 * Background service worker (MV3).
 *
 * Owns everything that talks to the ApplyPilot backend — the popup and
 * content scripts never fetch directly. Also opens the dashboard tab.
 *
 * Note: extension contexts with (optional) host permissions bypass CORS,
 * so the FastAPI backend needs no CORS changes for the extension.
 */
import {
  AuthRequiredError,
  checkAuthStatus,
  fetchApplicationProfile,
  login,
  logout,
} from "../api/client";
import { getConfig } from "../shared/storage";
import type {
  BackgroundRequest,
  FieldsUpdatedEvent,
  LoginResponse,
  ProfileResponse,
  SimpleResponse,
  StatusResponse,
} from "../shared/types";

chrome.runtime.onInstalled.addListener(() => {
  // getConfig() merges defaults, so no seeding is required — this hook is
  // kept for future migrations.
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
): Promise<StatusResponse | ProfileResponse | LoginResponse | SimpleResponse> {
  switch (message.type) {
    case "GET_STATUS": {
      const config = await getConfig();
      if (config.useMockData) {
        return { ok: true, mode: "mock", apiBaseUrl: config.apiBaseUrl };
      }
      const status = await checkAuthStatus();
      return {
        ok: true,
        mode: status.connected ? "connected" : "signedOut",
        email: status.email,
        apiBaseUrl: config.apiBaseUrl,
      };
    }

    case "LOGIN": {
      try {
        await login(message.email, message.password);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Login failed",
        };
      }
    }

    case "LOGOUT": {
      await logout();
      return { ok: true };
    }

    case "GET_PROFILE": {
      try {
        const { profile, source } = await fetchApplicationProfile(message.forceRefresh);
        return { ok: true, profile, source };
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

    case "OPEN_DASHBOARD": {
      const { dashboardUrl } = await getConfig();
      await chrome.tabs.create({ url: dashboardUrl });
      return { ok: true };
    }
  }
}
