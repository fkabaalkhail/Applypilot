// chrome-extension/test/cleanupLegacyStorage.test.ts
/**
 * The removed Remembered Answers feature left `ap_local_answers` on disk in
 * every existing install, and it held exactly the answers we promised would
 * never leave the machine. Deleting the code without deleting the data would
 * leave that sitting there forever, so the removal ships with a migration.
 *
 * What has to hold: it removes the key, it runs at most once, and it never
 * throws, the service worker calls it from a top-level event listener.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanupLegacyStorage,
  CLEANUP_MARKER_KEY,
  LEGACY_ANSWER_KEYS,
} from "../src/background/cleanupLegacyStorage";

// Minimal chrome.storage.local stub backed by a plain object. `remove` takes a
// string or an array, matching the real API (the module passes an array).
function makeStorageArea(seed: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...seed };
  return {
    _data: data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      Object.assign(data, obj);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
  };
}

let area: ReturnType<typeof makeStorageArea>;

function install(seed: Record<string, unknown> = {}): void {
  area = makeStorageArea(seed);
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: area } };
}

beforeEach(() => {
  install({ ap_local_answers: { "are you willing to relocate": { answer: "Yes", savedAt: 1 } } });
});

describe("cleanupLegacyStorage, one-time removal of the answer store", () => {
  it("removes every legacy remembered-answer key", async () => {
    await cleanupLegacyStorage();
    for (const key of LEGACY_ANSWER_KEYS) {
      expect(area._data[key]).toBeUndefined();
    }
  });

  it("names ap_local_answers, the key the device-local store actually used", () => {
    expect([...LEGACY_ANSWER_KEYS]).toContain("ap_local_answers");
  });

  it("marks itself done so a second pass is a no-op", async () => {
    await cleanupLegacyStorage();
    expect(area._data[CLEANUP_MARKER_KEY]).toBe(true);

    // A later write under the same key (impossible now, but the point is that
    // the pass does not run twice) is left alone.
    area._data.ap_local_answers = { q: { answer: "a", savedAt: 2 } };
    area.remove.mockClear();
    await cleanupLegacyStorage();
    expect(area.remove).not.toHaveBeenCalled();
    expect(area._data.ap_local_answers).toBeDefined();
  });

  it("is idempotent across many calls, one removal pass, total", async () => {
    await cleanupLegacyStorage();
    await cleanupLegacyStorage();
    await cleanupLegacyStorage();
    expect(area.remove).toHaveBeenCalledTimes(1);
  });

  it("leaves every other stored key untouched", async () => {
    install({
      ap_local_answers: { q: { answer: "a", savedAt: 1 } },
      ap_autofill_extras: { customFields: [{ label: "Pronouns", value: "they/them" }] },
      apCredentials: [{ origin: "https://x", email: "a@b.c" }],
      ap_auth: { refreshToken: "t" },
    });
    await cleanupLegacyStorage();
    expect(area._data.ap_autofill_extras).toBeDefined();
    expect(area._data.apCredentials).toBeDefined();
    expect(area._data.ap_auth).toBeDefined();
    expect(area._data.ap_local_answers).toBeUndefined();
  });

  it("never throws when storage is unavailable, and does not record a pass", async () => {
    install();
    area.get.mockRejectedValueOnce(new Error("storage gone"));
    await expect(cleanupLegacyStorage()).resolves.toBeUndefined();
    expect(area._data[CLEANUP_MARKER_KEY]).toBeUndefined();
  });

  it("does not mark itself done when the removal itself fails, so startup retries", async () => {
    area.remove.mockRejectedValueOnce(new Error("write failed"));
    await expect(cleanupLegacyStorage()).resolves.toBeUndefined();
    expect(area._data[CLEANUP_MARKER_KEY]).toBeUndefined();

    // Next startup: the retry lands.
    await cleanupLegacyStorage();
    expect(area._data.ap_local_answers).toBeUndefined();
    expect(area._data[CLEANUP_MARKER_KEY]).toBe(true);
  });

  it("still marks itself done on a clean install that never had the key", async () => {
    install();
    await cleanupLegacyStorage();
    expect(area._data[CLEANUP_MARKER_KEY]).toBe(true);
  });
});
