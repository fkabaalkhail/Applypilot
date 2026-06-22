/**
 * API client for the ApplyPilot backend.
 *
 * Runs inside the background service worker (extension contexts with host
 * permissions are exempt from CORS, so no backend CORS changes are needed).
 *
 * Profile resolution order:
 *   1. Mock profile           — when "use sample data" is on or no API URL set
 *   2. Fresh cache            — within PROFILE_CACHE_TTL_MS
 *   3. GET /api/user/application-profile   — the ideal, purpose-built endpoint
 *   4. GET /settings          — existing backend endpoint, mapped best-effort
 *
 * Auth: JWT bearer tokens from POST /auth/login, refreshed via /auth/refresh
 * (the backend rotates refresh tokens, so each refresh stores a new pair).
 */
import { PROFILE_ENDPOINT, SETTINGS_ENDPOINT } from "../shared/constants";
import {
  cacheProfile,
  clearAuth,
  clearProfileCache,
  getAuth,
  getCachedProfile,
  getConfig,
  saveAuth,
} from "../shared/storage";
import type { ProfileSource, UserApplicationProfile } from "../shared/types";
import { MOCK_PROFILE } from "./mockProfile";
import type { ApiErrorBody, BackendSettings, MeResponse, TokenResponse } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a request needs a signed-in user and there is none. */
export class AuthRequiredError extends Error {
  constructor(message = "Sign in to ApplyPilot to load your profile") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function apiUrl(path: string): Promise<string> {
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

/** Unauthenticated request (login / refresh). */
async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
      } catch (err) {
        // Refresh token expired/revoked — force a clean sign-in.
        await clearAuth();
        throw new AuthRequiredError();
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Authenticated request with one automatic refresh-and-retry on 401. */
async function authedRequest<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
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

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

export async function login(email: string, password: string): Promise<void> {
  const tokens = await publicRequest<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  await saveAuth({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    email,
  });
  await clearProfileCache();
}

export async function googleLogin(credential: string): Promise<void> {
  const tokens = await publicRequest<TokenResponse>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential }),
  });
  // Fetch user email from /auth/me after login
  const meRes = await fetch(await apiUrl("/auth/me"), {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  let email = "";
  if (meRes.ok) {
    const me = (await meRes.json()) as MeResponse;
    email = me.email || "";
  }
  await saveAuth({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    email,
  });
  await clearProfileCache();
}

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
  await clearProfileCache();
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

// ---------------------------------------------------------------------------
// Application profile
// ---------------------------------------------------------------------------

export async function fetchApplicationProfile(
  forceRefresh = false
): Promise<{ profile: UserApplicationProfile; source: ProfileSource }> {
  const config = await getConfig();

  // Mock mode — explicit sample data, no network at all.
  if (config.useMockData || !config.apiBaseUrl) {
    return { profile: MOCK_PROFILE, source: "mock" };
  }

  if (!forceRefresh) {
    const cached = await getCachedProfile();
    if (cached) return { profile: cached.profile, source: "cache" };
  }

  // Preferred endpoint. Falls through to /settings while it doesn't exist.
  try {
    const raw = await authedRequest<Partial<UserApplicationProfile>>(PROFILE_ENDPOINT);
    const profile = normalizeProfile(raw);
    await cacheProfile(profile, "api");
    return { profile, source: "api" };
  } catch (err) {
    const notImplemented =
      err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
    if (!notImplemented) throw err;
  }

  const settings = await authedRequest<BackendSettings>(SETTINGS_ENDPOINT);
  const profile = mapSettingsToProfile(settings);
  await cacheProfile(profile, "api-settings");
  return { profile, source: "api-settings" };
}

/**
 * Coerce a (possibly partial) API payload into a complete profile so the
 * rest of the extension never has to null-check individual fields.
 */
function normalizeProfile(raw: Partial<UserApplicationProfile>): UserApplicationProfile {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    firstName: str(raw.firstName),
    lastName: str(raw.lastName),
    email: str(raw.email),
    phone: str(raw.phone),
    location: str(raw.location),
    linkedin: str(raw.linkedin),
    github: str(raw.github),
    portfolio: str(raw.portfolio),
    currentCompany: str(raw.currentCompany),
    currentTitle: str(raw.currentTitle),
    workAuthorization: str(raw.workAuthorization),
    requiresSponsorship: str(raw.requiresSponsorship),
    education: Array.isArray(raw.education) ? raw.education : [],
    experience: Array.isArray(raw.experience) ? raw.experience : [],
    skills: Array.isArray(raw.skills) ? raw.skills.filter((s): s is string => typeof s === "string") : [],
    coverLetter: str(raw.coverLetter),
    salaryExpectation: raw.salaryExpectation ? str(raw.salaryExpectation) : undefined,
    eeo: raw.eeo,
  };
}

/**
 * Best-effort mapping from the existing GET /settings payload.
 * Fields the backend does not store yet (github, education, experience,
 * cover letter…) stay empty and simply show up as "needs review" in the popup.
 */
function mapSettingsToProfile(s: BackendSettings): UserApplicationProfile {
  // prefilled_answers is a free-form question→answer map; mine it for the
  // two screening answers we understand.
  const answers = s.prefilled_answers ?? {};
  let workAuthorization = "";
  let requiresSponsorship = "";
  for (const [question, answer] of Object.entries(answers)) {
    const q = question.toLowerCase();
    if (!requiresSponsorship && q.includes("sponsor")) requiresSponsorship = answer;
    else if (!workAuthorization && (q.includes("authoriz") || q.includes("eligible")))
      workAuthorization = answer;
  }

  return normalizeProfile({
    firstName: s.first_name,
    lastName: s.last_name,
    email: s.email,
    phone: s.phone,
    location: s.city || s.location,
    linkedin: s.linkedin_url,
    portfolio: s.website,
    currentTitle: s.job_title,
    workAuthorization,
    requiresSponsorship,
  });
}
