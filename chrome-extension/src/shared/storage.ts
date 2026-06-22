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
  auth: "ap_auth",
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

export async function getAuth(): Promise<StoredAuth | null> {
  const data = await chrome.storage.local.get(KEYS.auth);
  const auth = data[KEYS.auth] as StoredAuth | undefined;
  return auth && auth.accessToken ? auth : null;
}

export async function saveAuth(auth: StoredAuth): Promise<void> {
  await chrome.storage.local.set({ [KEYS.auth]: auth });
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(KEYS.auth);
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

interface ProfileCacheEntry {
  profile: UserApplicationProfile;
  source: ProfileSource;
  fetchedAt: number;
}

export async function getCachedProfile(): Promise<ProfileCacheEntry | null> {
  const data = await chrome.storage.local.get(KEYS.profileCache);
  const entry = data[KEYS.profileCache] as ProfileCacheEntry | undefined;
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

export async function cacheProfile(
  profile: UserApplicationProfile,
  source: ProfileSource
): Promise<void> {
  const entry: ProfileCacheEntry = { profile, source, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [KEYS.profileCache]: entry });
}

export async function clearProfileCache(): Promise<void> {
  await chrome.storage.local.remove(KEYS.profileCache);
}
