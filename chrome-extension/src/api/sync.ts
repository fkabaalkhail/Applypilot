/**
 * Sync engine.
 *
 * The web app is the source of truth. The extension keeps a single cached
 * snapshot (GET /api/extension/sync) and only re-downloads it when the cheap
 * version probe (GET /api/extension/sync/version) reports a change. Everything
 * the UI reads — profile, resumes, cover letters, custom resumes, settings,
 * subscription, usage — comes from this snapshot, so the extension keeps working
 * offline from cache and never silently loses the user's data.
 */
import { SYNC_ENDPOINT, SYNC_VERSION_ENDPOINT } from "../shared/constants";
import {
  cacheResumeFile,
  clearSnapshot,
  getCachedResumeFile,
  getConfig,
  getFreshSnapshot,
  getSnapshot,
  getSnapshotVersion,
  saveSnapshot,
} from "../shared/storage";
import type {
  ExtensionSyncSnapshot,
  ProfileSource,
  UserApplicationProfile,
} from "../shared/types";
import { ApiError, AuthRequiredError, authedRaw, authedRequest } from "./client";
import { MOCK_PROFILE } from "./mockProfile";

// ---------------------------------------------------------------------------
// Normalization + mock snapshot
// ---------------------------------------------------------------------------

/** Coerce a (possibly partial) profile payload so the UI never null-checks. */
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

function normalizeSnapshot(raw: ExtensionSyncSnapshot): ExtensionSyncSnapshot {
  return {
    ...raw,
    version: typeof raw.version === "number" ? raw.version : 1,
    updatedAt: raw.updatedAt ?? null,
    profile: normalizeProfile(raw.profile ?? ({} as UserApplicationProfile)),
    resumes: Array.isArray(raw.resumes) ? raw.resumes : [],
    coverLetters: Array.isArray(raw.coverLetters) ? raw.coverLetters : [],
    customResumes: Array.isArray(raw.customResumes) ? raw.customResumes : [],
    activeResumeId: raw.activeResumeId ?? null,
    settings: raw.settings ?? { jobTitle: "", prefilledAnswers: {} },
    subscription: raw.subscription ?? { tier: "free", status: "active" },
    usage: raw.usage ?? { aiCreditsUsed: 0, aiCreditsLimit: null },
  };
}

/** A self-contained snapshot for "use sample data" (dev) mode. */
export function buildMockSnapshot(): ExtensionSyncSnapshot {
  return {
    version: 0,
    updatedAt: null,
    profile: MOCK_PROFILE,
    resumes: [],
    activeResumeId: null,
    coverLetters: [],
    customResumes: [],
    settings: { jobTitle: "", prefilledAnswers: {} },
    subscription: { tier: "free", status: "active" },
    usage: { aiCreditsUsed: 0, aiCreditsLimit: null },
  };
}

// ---------------------------------------------------------------------------
// Snapshot fetch + staleness
// ---------------------------------------------------------------------------

/** Fetch just the server's current sync version (cheap staleness check). */
export async function fetchSyncVersion(): Promise<number> {
  const res = await authedRequest<{ version?: number }>(SYNC_VERSION_ENDPOINT);
  return res.version ?? 1;
}

/** Download the full snapshot, normalize, and cache it. */
export async function fetchSnapshotFromApi(): Promise<ExtensionSyncSnapshot> {
  const raw = await authedRequest<ExtensionSyncSnapshot>(SYNC_ENDPOINT);
  const snapshot = normalizeSnapshot(raw);
  await saveSnapshot(snapshot);
  return snapshot;
}

/**
 * If the server's version differs from the cached snapshot's, re-download.
 * Returns true when a refresh happened. Best-effort — offline/missing-endpoint
 * errors are swallowed so the extension keeps working from cache. Re-auth
 * failures clear the snapshot so the UI can prompt a reconnect.
 */
export async function syncIfStale(): Promise<boolean> {
  const config = await getConfig();
  if (config.useMockData || !config.apiBaseUrl) return false;

  const cachedVersion = await getSnapshotVersion();
  try {
    if (cachedVersion === null) {
      // Nothing cached yet — pull the first snapshot.
      await fetchSnapshotFromApi();
      return true;
    }
    const serverVersion = await fetchSyncVersion();
    if (serverVersion !== cachedVersion) {
      await fetchSnapshotFromApi();
      return true;
    }
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await clearSnapshot();
      throw err;
    }
    // offline or transient — keep using the cache
  }
  return false;
}

/**
 * Resolve the snapshot for the UI with provenance.
 *   mock → sample data; fresh cache → cache; else fetch (falling back to any
 *   cached snapshot when the network/API is unavailable).
 */
export async function getSnapshotForUi(
  forceRefresh = false
): Promise<{ snapshot: ExtensionSyncSnapshot; source: ProfileSource }> {
  const config = await getConfig();
  if (config.useMockData || !config.apiBaseUrl) {
    return { snapshot: buildMockSnapshot(), source: "mock" };
  }

  if (!forceRefresh) {
    const fresh = await getFreshSnapshot();
    if (fresh) return { snapshot: fresh.snapshot, source: "cache" };
  }

  try {
    const snapshot = await fetchSnapshotFromApi();
    return { snapshot, source: "api" };
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    // Network/server error — serve the last cached snapshot so the extension
    // keeps working while the API is unavailable.
    const stale = await getSnapshot();
    if (stale) return { snapshot: stale.snapshot, source: "cache" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resume file download (cache-first, offline-capable)
// ---------------------------------------------------------------------------

/**
 * Download a resume's original file as base64 so the content script can rebuild
 * a File and inject it into an ATS upload control. Cache-first: returns the
 * cached copy when it matches the current snapshot version, so re-uploads are
 * instant and work offline. The cache is invalidated when the snapshot version
 * (which bumps on any resume change) advances.
 */
export async function downloadResumeFile(
  resumeId: number
): Promise<{ dataBase64: string; name: string; contentType: string }> {
  const currentVersion = (await getSnapshotVersion()) ?? 0;

  const cached = await getCachedResumeFile(resumeId);
  if (cached && cached.version === currentVersion) {
    return { dataBase64: cached.dataBase64, name: cached.name, contentType: cached.contentType };
  }

  try {
    const res = await authedRaw(`/resumes/${resumeId}/file`);
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get("Content-Type") || "application/octet-stream";
    const name =
      filenameFromDisposition(res.headers.get("Content-Disposition")) || `resume-${resumeId}`;
    const dataBase64 = arrayBufferToBase64(buf);
    await cacheResumeFile({
      resumeId,
      version: currentVersion,
      dataBase64,
      name,
      contentType,
      fetchedAt: Date.now(),
    });
    return { dataBase64, name, contentType };
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    // Offline / transient — fall back to any cached copy regardless of version.
    if (cached) {
      return { dataBase64: cached.dataBase64, name: cached.name, contentType: cached.contentType };
    }
    if (err instanceof ApiError) throw err;
    throw err;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000; // chunk to avoid call-stack limits on large files
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  return m ? decodeURIComponent(m[1]) : null;
}
