/**
 * Typed wrappers around chrome.storage.local.
 *
 * Everything the extension persists lives here:
 *  - config:        user-editable settings (API URL, mock mode, EEO toggle)
 *  - auth:          JWT pair from the ApplyPilot backend
 *  - profile cache: last fetched profile, with TTL
 */
import { DEFAULT_API_BASE_URL, DEFAULT_DASHBOARD_URL, PROFILE_CACHE_TTL_MS } from "./constants";
import type { ProfileSource, UserApplicationProfile } from "./types";

const KEYS = {
  config: "ap_config",
  // Persistent: refresh token + email (survives browser restart).
  auth: "ap_auth",
  // In-memory only (chrome.storage.session): the short-lived access token.
  authAccess: "ap_auth_access",
  profileCache: "ap_profile_cache",
} as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ExtensionConfig {
  apiBaseUrl: string;
  dashboardUrl: string;
  /** When true the extension uses the bundled mock profile (no network). */
  useMockData: boolean;
  /** Explicit opt-in for filling EEO / demographic fields. Default false. */
  fillEEO: boolean;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  dashboardUrl: DEFAULT_DASHBOARD_URL,
  // Mock data by default so the extension works before the backend is wired up.
  useMockData: true,
  fillEEO: false,
};

export async function getConfig(): Promise<ExtensionConfig> {
  const data = await chrome.storage.local.get(KEYS.config);
  return { ...DEFAULT_CONFIG, ...(data[KEYS.config] as Partial<ExtensionConfig> | undefined) };
}

export async function saveConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const next = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ [KEYS.config]: next });
  return next;
}

// ---------------------------------------------------------------------------
// Auth tokens
// ---------------------------------------------------------------------------

export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  email: string;
}

interface PersistentAuth {
  refreshToken: string;
  email: string;
}

/**
 * Returns the stored auth, or null when there is no refresh token (= signed
 * out). The access token lives in session storage and may be empty after a
 * browser restart — callers refresh-on-401, which re-mints and re-stores it.
 *
 * Auth is only read in the service-worker context (the popup/content scripts
 * message the worker), so chrome.storage.session is reachable here.
 */
export async function getAuth(): Promise<StoredAuth | null> {
  const local = await chrome.storage.local.get(KEYS.auth);
  const persistent = local[KEYS.auth] as PersistentAuth | undefined;
  if (!persistent?.refreshToken) return null;

  let accessToken = "";
  try {
    const sess = await chrome.storage.session.get(KEYS.authAccess);
    accessToken = (sess[KEYS.authAccess] as string | undefined) ?? "";
  } catch {
    // session storage unavailable — leave empty; a refresh will populate it
  }
  return { accessToken, refreshToken: persistent.refreshToken, email: persistent.email };
}

export async function saveAuth(auth: StoredAuth): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.auth]: { refreshToken: auth.refreshToken, email: auth.email },
  });
  try {
    await chrome.storage.session.set({ [KEYS.authAccess]: auth.accessToken });
  } catch {
    // session storage unavailable — the access token just won't persist
  }
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(KEYS.auth);
  try {
    await chrome.storage.session.remove(KEYS.authAccess);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

interface ProfileCacheEntry {
  profile: UserApplicationProfile;
  source: ProfileSource;
  fetchedAt: number;
  /** Server sync version this profile was fetched at (for staleness checks). */
  version: number;
}

/** Fresh cache only (within TTL) — used for the fast path. */
export async function getCachedProfile(): Promise<ProfileCacheEntry | null> {
  const entry = await getCachedProfileAny();
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

/** Cached profile regardless of TTL — the offline fallback. */
export async function getCachedProfileAny(): Promise<ProfileCacheEntry | null> {
  const data = await chrome.storage.local.get(KEYS.profileCache);
  return (data[KEYS.profileCache] as ProfileCacheEntry | undefined) ?? null;
}

/** The sync version of the cached profile, or null when there is no cache. */
export async function getCachedProfileVersion(): Promise<number | null> {
  const entry = await getCachedProfileAny();
  return entry ? entry.version : null;
}

export async function cacheProfile(
  profile: UserApplicationProfile,
  source: ProfileSource,
  version = 1
): Promise<void> {
  const entry: ProfileCacheEntry = { profile, source, fetchedAt: Date.now(), version };
  await chrome.storage.local.set({ [KEYS.profileCache]: entry });
}

export async function clearProfileCache(): Promise<void> {
  await chrome.storage.local.remove(KEYS.profileCache);
}
