/**
 * downloadResumeFile must revalidate the sync version BEFORE trusting its
 * cached file: a résumé edited on the web bumps the server version, and the
 * attach that happens minutes later (inside the snapshot's 10-minute TTL) must
 * fetch the fresh file, not replay the stale cached bytes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface StoredFile {
  resumeId: number;
  version: number;
  dataBase64: string;
  name: string;
  contentType: string;
  fetchedAt: number;
}

const state: {
  snapshotVersion: number | null;
  cachedFile: StoredFile | null;
  serverVersion: number;
} = { snapshotVersion: 3, cachedFile: null, serverVersion: 3 };

vi.mock("../src/shared/storage", () => ({
  getConfig: vi.fn(async () => ({ apiBaseUrl: "https://api.test", useMockData: false })),
  getSnapshotVersion: vi.fn(async () => state.snapshotVersion),
  getSnapshot: vi.fn(async () =>
    state.snapshotVersion === null
      ? null
      : { snapshot: { version: state.snapshotVersion }, fetchedAt: Date.now() }
  ),
  getFreshSnapshot: vi.fn(async () => null),
  saveSnapshot: vi.fn(async (s: { version: number }) => {
    state.snapshotVersion = s.version;
  }),
  clearSnapshot: vi.fn(async () => {
    state.snapshotVersion = null;
  }),
  getCachedResumeFile: vi.fn(async () => state.cachedFile),
  cacheResumeFile: vi.fn(async (entry: StoredFile) => {
    state.cachedFile = entry;
  }),
}));

const rawFetches: string[] = [];
vi.mock("../src/api/client", () => {
  class ApiError extends Error {}
  class AuthRequiredError extends Error {}
  return {
    ApiError,
    AuthRequiredError,
    authedRequest: vi.fn(async (path: string) => {
      if (path.includes("/sync/version")) return { version: state.serverVersion };
      if (path.includes("/sync")) return { version: state.serverVersion };
      throw new Error(`unexpected authedRequest ${path}`);
    }),
    authedRaw: vi.fn(async (path: string) => {
      rawFetches.push(path);
      return {
        arrayBuffer: async () => new TextEncoder().encode("FRESHBYTES").buffer,
        headers: {
          get: (h: string) =>
            h === "Content-Type"
              ? "application/pdf"
              : h === "Content-Disposition"
                ? 'inline; filename="fresh.pdf"'
                : null,
        },
      };
    }),
  };
});

import { downloadResumeFile } from "../src/api/sync";

beforeEach(() => {
  rawFetches.length = 0;
  state.snapshotVersion = 3;
  state.serverVersion = 3;
  state.cachedFile = {
    resumeId: 7,
    version: 3,
    dataBase64: btoa("STALEBYTES"),
    name: "stale.pdf",
    contentType: "application/pdf",
    fetchedAt: 1,
  };
});

describe("downloadResumeFile — attach-time freshness", () => {
  it("serves the cached file when the server version is unchanged", async () => {
    const res = await downloadResumeFile(7);
    expect(atob(res.dataBase64)).toBe("STALEBYTES");
    expect(rawFetches).toEqual([]); // no re-download needed
  });

  it("re-downloads the file when the web app bumped the version (résumé edited)", async () => {
    state.serverVersion = 4; // the user just edited their résumé on the web
    const res = await downloadResumeFile(7);
    expect(rawFetches).toEqual(["/resumes/7/file"]);
    expect(atob(res.dataBase64)).toBe("FRESHBYTES");
    expect(res.name).toBe("fresh.pdf");
    // and the fresh copy is cached under the NEW version
    expect(state.cachedFile?.version).toBe(4);
  });
});
