/**
 * Typed wrappers around chrome.storage.local.
 *
 * Everything the extension persists lives here:
 *  - config:        user-editable settings (API URL, mock mode, EEO toggle)
 *  - auth:          JWT pair from the ApplyPilot backend
 *  - profile cache: last fetched profile, with TTL
 */
import { DEFAULT_API_BASE_URL, DEFAULT_DASHBOARD_URL, PROFILE_CACHE_TTL_MS } from "./constants";
import type { ExtensionSyncSnapshot } from "./types";

const KEYS = {
  config: "ap_config",
  // Persistent: refresh token + email (survives browser restart).
  auth: "ap_auth",
  // In-memory only (chrome.storage.session): the short-lived access token.
  authAccess: "ap_auth_access",
  // Last synced snapshot (profile, resumes, cover letters, …) — offline source.
  snapshot: "ap_sync",
  // Per-resume original file cache (base64), keyed by resume id.
  resumeFilePrefix: "ap_resume_file_",
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
  // Connect-first: the extension is a companion to the web app. Sample data is
  // an opt-in dev affordance, not the default experience.
  useMockData: false,
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
// Sync snapshot (the offline source of truth for the whole UI)
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  snapshot: ExtensionSyncSnapshot;
  fetchedAt: number;
}

/** Cached snapshot regardless of age — the offline fallback. */
export async function getSnapshot(): Promise<SnapshotEntry | null> {
  const data = await chrome.storage.local.get(KEYS.snapshot);
  return (data[KEYS.snapshot] as SnapshotEntry | undefined) ?? null;
}

/** Cached snapshot only if still fresh (within TTL) — the fast path. */
export async function getFreshSnapshot(): Promise<SnapshotEntry | null> {
  const entry = await getSnapshot();
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

/** The sync version of the cached snapshot, or null when there is none. */
export async function getSnapshotVersion(): Promise<number | null> {
  const entry = await getSnapshot();
  return entry ? entry.snapshot.version : null;
}

export async function saveSnapshot(snapshot: ExtensionSyncSnapshot): Promise<void> {
  const entry: SnapshotEntry = { snapshot, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [KEYS.snapshot]: entry });
}

export async function clearSnapshot(): Promise<void> {
  await chrome.storage.local.remove(KEYS.snapshot);
}

// ---------------------------------------------------------------------------
// Resume file cache (original PDF/DOCX, base64) for offline auto-upload
// ---------------------------------------------------------------------------

export interface ResumeFileEntry {
  resumeId: number;
  /** Snapshot version when cached — lets us invalidate when the resume changes. */
  version: number;
  dataBase64: string;
  name: string;
  contentType: string;
  fetchedAt: number;
}

function resumeFileKey(resumeId: number): string {
  return `${KEYS.resumeFilePrefix}${resumeId}`;
}

export async function getCachedResumeFile(resumeId: number): Promise<ResumeFileEntry | null> {
  const key = resumeFileKey(resumeId);
  const data = await chrome.storage.local.get(key);
  return (data[key] as ResumeFileEntry | undefined) ?? null;
}

export async function cacheResumeFile(entry: ResumeFileEntry): Promise<void> {
  await chrome.storage.local.set({ [resumeFileKey(entry.resumeId)]: entry });
}
