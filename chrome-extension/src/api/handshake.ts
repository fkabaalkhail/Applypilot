/**
 * Extension ↔ web authentication handshake (PKCE).
 *
 * The extension never handles credentials. ``connectAccount()`` opens the web
 * app's /extension/connect page via chrome.identity.launchWebAuthFlow (which
 * reuses the user's live web session), receives a one-time authorization code,
 * and exchanges it — proving possession of the PKCE verifier — for an
 * extension-scoped token pair at POST /auth/extension/token.
 *
 * Security:
 *   - PKCE S256: the verifier never leaves the extension; a leaked code is useless.
 *   - ``state`` nonce guards against cross-flow injection.
 *   - launchWebAuthFlow only completes to THIS extension's chromiumapp.org URL.
 */
import { getConfig, saveAuth } from "../shared/storage";
import { publicRequest } from "./client";

interface ExtensionTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  email: string;
  email_verified: boolean;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Cryptographically-random string from the PKCE unreserved-character set. */
function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += PKCE_CHARS[bytes[i] % PKCE_CHARS.length];
  return out;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full connect handshake. On success the extension's token pair is
 * persisted via saveAuth. Throws on cancellation or any failure (the caller
 * surfaces the message). Does NOT sync — the caller triggers the initial sync.
 */
export async function connectAccount(): Promise<{ email: string }> {
  const { dashboardUrl } = await getConfig();
  const redirectUri = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/

  const verifier = randomString(64);
  const challenge = await sha256Challenge(verifier);
  const stateNonce = randomString(24);

  const connectUrl = new URL(dashboardUrl.replace(/\/+$/, "") + "/extension/connect");
  connectUrl.searchParams.set("code_challenge", challenge);
  connectUrl.searchParams.set("code_challenge_method", "S256");
  connectUrl.searchParams.set("state", stateNonce);
  connectUrl.searchParams.set("redirect_uri", redirectUri);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: connectUrl.toString(),
    interactive: true,
  });
  if (!responseUrl) throw new Error("Connection was cancelled");

  // The code + state come back in the URL fragment.
  const fragment = new URLSearchParams(new URL(responseUrl).hash.replace(/^#/, ""));
  const code = fragment.get("code");
  const returnedState = fragment.get("state");
  if (!code) throw new Error("No authorization code was returned");
  if (returnedState !== stateNonce) throw new Error("Security check failed — please try again");

  const tokens = await publicRequest<ExtensionTokenResponse>("/auth/extension/token", {
    method: "POST",
    body: JSON.stringify({ code, code_verifier: verifier }),
  });

  await saveAuth({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    email: tokens.email,
  });

  return { email: tokens.email };
}
