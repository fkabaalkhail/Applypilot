import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();
vi.mock("../auth/api", () => ({
  default: { post: (...args: unknown[]) => apiPost(...args) },
}));

import {
  checkListingLive,
  isListingClosed,
  listingStatusFromLiveCheck,
  postedAgo,
  resetLiveChecks,
  sourceLabel,
} from "../lib/jobListing";

function httpError(status: number, detail?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: detail === undefined ? {} : { detail } },
  });
}

describe("isListingClosed", () => {
  it("treats removed and expired as closed, everything else as open", () => {
    expect(isListingClosed("removed")).toBe(true);
    expect(isListingClosed("expired")).toBe(true);
    expect(isListingClosed("active")).toBe(false);
    expect(isListingClosed("stale")).toBe(false);
    expect(isListingClosed(null)).toBe(false);
    expect(isListingClosed(undefined)).toBe(false);
  });
});

describe("postedAgo", () => {
  const NOW = new Date("2026-09-27T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a real future date as the date, not 'Today'", () => {
    const label = postedAgo("2026-11-14T00:00:00");
    expect(label).not.toBe("Today");
    expect(label).toMatch(/Nov 1[34]/);
  });

  it("includes the year for a future date in another year", () => {
    expect(postedAgo("2027-02-10T12:00:00Z")).toMatch(/2027/);
  });

  it("reads a date-only posting a few hours ahead as today", () => {
    expect(postedAgo("2026-09-28T00:00:00")).toBe("Today");
  });

  it("formats past timestamps relative to now", () => {
    expect(postedAgo("2026-09-27T11:30:00Z")).toBe("Just now");
    expect(postedAgo("2026-09-27T07:00:00Z")).toBe("5h ago");
    expect(postedAgo("2026-09-26T08:00:00Z")).toBe("1 day ago");
    expect(postedAgo("2026-09-23T12:00:00Z")).toBe("4 days ago");
    expect(postedAgo("2026-09-13T12:00:00Z")).toBe("2w ago");
    expect(postedAgo("2026-07-01T12:00:00Z")).toMatch(/Jul 1/);
  });

  it("treats an offset-less server timestamp as UTC", () => {
    expect(postedAgo("2026-09-27T07:00:00")).toBe("5h ago");
  });

  it("returns an empty label for missing or unparseable values", () => {
    expect(postedAgo(null)).toBe("");
    expect(postedAgo("")).toBe("");
    expect(postedAgo("not a date")).toBe("");
  });
});

describe("sourceLabel", () => {
  it("labels aggregators and GitHub lists by source_platform", () => {
    expect(sourceLabel({ source_platform: "github" })).toEqual({ label: "GitHub", kind: "github" });
    expect(sourceLabel({ source_platform: "linkedin" })).toEqual({ label: "LinkedIn", kind: "linkedin" });
    expect(sourceLabel({ source_platform: "indeed" })).toEqual({ label: "Indeed", kind: "other" });
  });

  it("labels ATS rows by their ATS, never as LinkedIn", () => {
    expect(sourceLabel({ source_platform: "ats", ats_type: "workday" }).label).toBe("Workday");
    expect(sourceLabel({ source_platform: "ats", ats_type: "successfactors" }).label).toBe("SuccessFactors");
    expect(
      sourceLabel({ source_platform: "ats", ats_type: "", url: "https://jobs.lever.co/acme/123" }).label,
    ).toBe("Lever");
    expect(
      sourceLabel({ source_platform: "ats", url: "https://job-boards.greenhouse.io/acme/jobs/1" }).label,
    ).toBe("Greenhouse");
    expect(sourceLabel({ source_platform: "ats", url: "https://www.carvana.com/careers/1" })).toEqual({
      label: "Company site",
      kind: "other",
    });
  });

  it("keeps LinkedIn for LinkedIn rows stored as ATS rows", () => {
    expect(sourceLabel({ source_platform: "ats", ats_type: "linkedin" })).toEqual({
      label: "LinkedIn",
      kind: "linkedin",
    });
  });
});

describe("checkListingLive", () => {
  beforeEach(() => {
    apiPost.mockReset();
    resetLiveChecks();
  });

  it("posts once per job per session and reuses the answer", async () => {
    apiPost.mockResolvedValue({ data: { id: 7, listing_status: "removed", verdict: "dead" } });
    const first = await checkListingLive(7);
    const second = await checkListingLive(7);
    expect(first).toEqual({ id: 7, listing_status: "removed", verdict: "dead" });
    expect(second).toBe(first);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith("/jobs/7/check-live");
  });

  it("resolves null on server errors and malformed answers", async () => {
    apiPost.mockRejectedValueOnce(httpError(500));
    expect(await checkListingLive(1)).toBeNull();
    apiPost.mockRejectedValueOnce(new Error("Network Error"));
    expect(await checkListingLive(2)).toBeNull();
    apiPost.mockResolvedValueOnce({ data: {} });
    expect(await checkListingLive(3)).toBeNull();
    // A missing job is not a missing endpoint: keep checking other jobs.
    apiPost.mockRejectedValueOnce(httpError(404, "Job not found."));
    expect(await checkListingLive(4)).toBeNull();
    apiPost.mockResolvedValueOnce({ data: { id: 5, listing_status: "active", verdict: "alive" } });
    expect(await checkListingLive(5)).toEqual({ id: 5, listing_status: "active", verdict: "alive" });
  });

  it("stops asking for the session once the endpoint is shown to be missing", async () => {
    apiPost.mockRejectedValueOnce(httpError(405, "Method Not Allowed"));
    expect(await checkListingLive(1)).toBeNull();
    expect(await checkListingLive(2)).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);

    resetLiveChecks();
    apiPost.mockReset();
    apiPost.mockRejectedValueOnce(httpError(404, "Not Found"));
    expect(await checkListingLive(1)).toBeNull();
    expect(await checkListingLive(2)).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it("maps a dead verdict to a closed status", () => {
    expect(listingStatusFromLiveCheck({ id: 1, listing_status: "active", verdict: "dead" })).toBe("removed");
    expect(listingStatusFromLiveCheck({ id: 1, listing_status: "expired", verdict: "dead" })).toBe("expired");
    expect(listingStatusFromLiveCheck({ id: 1, listing_status: "stale", verdict: "unknown" })).toBe("stale");
    expect(listingStatusFromLiveCheck({ id: 1, listing_status: "active", verdict: "alive" })).toBe("active");
  });
});
