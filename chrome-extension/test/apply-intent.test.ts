import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordApplyIntent, matchApplyIntent } from "../src/background/applyIntent";

/**
 * The dashboard→extension job_id handoff store. The web app pushes {jobId, url}
 * when the user clicks Apply; a later submit on the ATS page is matched back to
 * the job by host so the recorded application links to it.
 */

// Minimal chrome.storage.session mock (Map-backed, async like the real API).
function installChromeMock(): void {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  };
}

beforeEach(() => installChromeMock());
afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("applyIntent — dashboard job_id handoff store", () => {
  it("matches a recorded intent by host (ignoring query params)", async () => {
    await recordApplyIntent({ jobId: 42, url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(
      await matchApplyIntent("https://boards.greenhouse.io/acme/jobs/1?utm=tailrd")
    ).toBe(42);
  });

  it("matches by host even when the ATS redirected the path", async () => {
    await recordApplyIntent({ jobId: 7, url: "https://jobs.lever.co/acme/apply" });
    expect(await matchApplyIntent("https://jobs.lever.co/acme/apply/confirm")).toBe(7);
  });

  it("prefers an exact pathname match when two jobs share a host", async () => {
    await recordApplyIntent({ jobId: 1, url: "https://boards.greenhouse.io/acme/jobs/1" });
    await recordApplyIntent({ jobId: 2, url: "https://boards.greenhouse.io/acme/jobs/2" });
    expect(await matchApplyIntent("https://boards.greenhouse.io/acme/jobs/1")).toBe(1);
    expect(await matchApplyIntent("https://boards.greenhouse.io/acme/jobs/2")).toBe(2);
  });

  it("returns null for a host with no intent", async () => {
    await recordApplyIntent({ jobId: 5, url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(await matchApplyIntent("https://different-ats.com/apply")).toBeNull();
  });

  it("returns null for an unparseable page url", async () => {
    await recordApplyIntent({ jobId: 5, url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(await matchApplyIntent("not a url")).toBeNull();
  });

  it("expires intents after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await recordApplyIntent({ jobId: 9, url: "https://boards.greenhouse.io/acme/jobs/1" });

    vi.setSystemTime(new Date("2026-01-01T00:45:00Z")); // +45 min > 30 min TTL
    expect(await matchApplyIntent("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
    vi.useRealTimers();
  });
});
