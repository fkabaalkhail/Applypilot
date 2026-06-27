/**
 * Low-level API client for the Tailrd backend.
 *
 * Runs inside the background service worker (extension contexts with host
 * permissions are exempt from CORS, so no backend CORS changes are needed).
 *
 * This module owns only the HTTP + token plumbing:
 *   - publicRequest / authedRequest / authedRaw
 *   - silent refresh-on-401 (the backend rotates refresh tokens)
 *   - logout + checkAuthStatus
 *
 * The extension never logs in here — tokens are obtained via the web handshake
 * (see api/handshake.ts). Data fetching + caching lives in api/sync.ts.
 */
import {
  clearAuth,
  clearSnapshot,
  getAccessTokenExp,
  getAuth,
  getConfig,
  saveAuth,
} from "../shared/storage";
import type { ApiErrorBody, MeResponse, TokenResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a request needs a signed-in user and there is none. */
export class AuthRequiredError extends Error {
  constructor(message = "Connect your Tailrd account to sync your profile") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

export async function apiUrl(path: string): Promise<string> {
  const { apiBaseUrl } = await getConfig();
  return apiBaseUrl.replace(/\/+$/, "") + path;
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.detail) detail = body.detail;
  } catch {
    // non-JSON error body — keep the generic message
  }
  return new ApiError(detail, res.status);
}

/** Unauthenticated request (token handshake / refresh). */
export async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(await apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

// Single-flight guard so concurrent 401s trigger only one token refresh.
let refreshInFlight: Promise<void> | null = null;

async function refreshTokens(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const auth = await getAuth();
      if (!auth?.refreshToken) throw new AuthRequiredError();
      try {
        const tokens = await publicRequest<TokenResponse>("/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: auth.refreshToken }),
        });
        // The backend revokes the old refresh token — always store the new pair.
        await saveAuth({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          email: auth.email,
        });
      } catch {
        // Refresh token expired/revoked — force a clean reconnect.
        await clearAuth();
        throw new AuthRequiredError();
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Refresh proactively when the access token is missing or near expiry. */
export const ACCESS_TOKEN_SKEW_SECONDS = 120;

export async function ensureFreshAccessToken(): Promise<void> {
  const auth = await getAuth();
  if (!auth?.refreshToken) return; // not connected — nothing to refresh
  const exp = await getAccessTokenExp();
  const needs = !auth.accessToken || exp === null || exp - Math.floor(Date.now() / 1000) <= ACCESS_TOKEN_SKEW_SECONDS;
  if (needs) await refreshTokens();
}

/** Authenticated request with one automatic refresh-and-retry on 401. */
export async function authedRequest<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  await ensureFreshAccessToken();
  const auth = await getAuth();
  if (!auth) throw new AuthRequiredError();

  const res = await fetch(await apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401 && retry) {
    await refreshTokens();
    return authedRequest<T>(path, init, false);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** Authenticated raw fetch (binary-safe) with one refresh-and-retry on 401. */
export async function authedRaw(path: string, init?: RequestInit, retry = true): Promise<Response> {
  await ensureFreshAccessToken();
  const auth = await getAuth();
  if (!auth) throw new AuthRequiredError();

  const res = await fetch(await apiUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401 && retry) {
    await refreshTokens();
    return authedRaw(path, init, false);
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

// ---------------------------------------------------------------------------
// Auth lifecycle
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  const auth = await getAuth();
  if (auth) {
    try {
      await authedRequest("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: auth.refreshToken }),
      });
    } catch {
      // Best effort — clear local state regardless.
    }
  }
  await clearAuth();
  await clearSnapshot();
}

export async function checkAuthStatus(): Promise<{
  connected: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
}> {
  const auth = await getAuth();
  if (!auth) return { connected: false };
  try {
    const me = await authedRequest<MeResponse>("/auth/me");
    return {
      connected: true,
      email: me.email || auth.email,
      firstName: me.first_name || undefined,
      lastName: me.last_name || undefined,
    };
  } catch {
    return { connected: false };
  }
}
