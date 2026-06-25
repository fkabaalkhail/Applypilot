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
  googleLogin,
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
        firstName: status.firstName,
        lastName: status.lastName,
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

    case "GOOGLE_LOGIN": {
      try {
        // Use chrome.identity to get a Google ID token via OAuth
        const redirectUrl = chrome.identity.getRedirectURL();
        const clientId = "333525816538-1e7099ljo24tprl2atgi3k81q4s1s112.apps.googleusercontent.com";
        const nonce = crypto.randomUUID();
        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("response_type", "id_token");
        authUrl.searchParams.set("redirect_uri", redirectUrl);
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("nonce", nonce);
        authUrl.searchParams.set("prompt", "select_account");

        const responseUrl = await chrome.identity.launchWebAuthFlow({
          url: authUrl.toString(),
          interactive: true,
        });

        if (!responseUrl) {
          return { ok: false, error: "Google sign-in was cancelled" };
        }

        // Extract id_token from the URL fragment
        const url = new URL(responseUrl);
        const fragment = new URLSearchParams(url.hash.substring(1));
        const idToken = fragment.get("id_token");

        if (!idToken) {
          return { ok: false, error: "Could not get Google ID token" };
        }

        // Send the ID token to our backend's /auth/google endpoint
        await googleLogin(idToken);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Google sign-in failed",
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
