import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();
vi.mock("../auth/api", () => ({
  default: { post: (...args: unknown[]) => apiPost(...args) },
}));

import {
  APPLY_CHECK_WAIT_MS,
  checkListingLive,
  handleApplyLinkClick,
  isListingClosed,
  isUnprobeableApplyUrl,
  listingStatusFromLiveCheck,
  openApplyAfterLiveCheck,
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
    expect(postedAgo("2026-11-14T00:00:00")).toBe("Nov 14");
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

// Date-only sources are stored at midnight and serialized without an offset.
// Read as UTC midnight, they land on the previous evening west of UTC, so the
// absolute label must keep the stored calendar day.
describe("postedAgo west of UTC", () => {
  const NOW = new Date("2026-09-28T16:00:00Z");
  let savedTz: string | undefined;

  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Toronto";
  });

  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs in a zone behind UTC", () => {
    expect(new Date("2026-08-04T00:00:00Z").getDate()).toBe(3);
  });

  it("shows a date-only posting on its own calendar day", () => {
    expect(postedAgo("2026-08-04T00:00:00")).toBe("Aug 4");
    expect(postedAgo("2026-07-01T00:00:00")).toBe("Jul 1");
    expect(postedAgo("2026-07-01 00:00:00")).toBe("Jul 1");
    expect(postedAgo("2026-07-01T00:00:00.000")).toBe("Jul 1");
    expect(postedAgo("2026-07-01")).toBe("Jul 1");
    expect(postedAgo("2026-11-14T00:00:00")).toBe("Nov 14");
    expect(postedAgo("2025-08-04T00:00:00")).toBe("Aug 4, 2025");
    expect(postedAgo("2027-01-01T00:00:00")).toBe("Jan 1, 2027");
  });

  it("still shows a real timestamp in the viewer's zone", () => {
    // 02:00 UTC on Jul 1 is the evening of Jun 30 in Toronto.
    expect(postedAgo("2026-07-01T02:00:00Z")).toBe("Jun 30");
    expect(postedAgo("2026-07-01T02:00:00")).toBe("Jun 30");
  });

  it("keeps the relative labels for recent date-only postings", () => {
    expect(postedAgo("2026-09-29T00:00:00")).toBe("Today");
    expect(postedAgo("2026-09-26T00:00:00")).toBe("2 days ago");
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

describe("openApplyAfterLiveCheck", () => {
  const url = "https://acme.wd3.myworkdayjobs.com/en-US/careers/job/SWE_R1";

  function fakeTab() {
    return {
      opener: {} as unknown,
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(),
    };
  }

  let openSpy: ReturnType<typeof vi.spyOn>;
  let tab: ReturnType<typeof fakeTab>;

  beforeEach(() => {
    apiPost.mockReset();
    resetLiveChecks();
    tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
  });

  afterEach(() => {
    openSpy.mockRestore();
    vi.useRealTimers();
  });

  it("opens a blank tab inside the click, then sends it to the job once the check says alive", async () => {
    apiPost.mockResolvedValue({ data: { id: 1, listing_status: "active", verdict: "alive" } });
    const pending = openApplyAfterLiveCheck(1, url);
    // Synchronous: the tab exists before any await, so popup blockers allow it.
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.location.href).toBe("about:blank");
    expect(pending).not.toBeNull();
    await expect(pending).resolves.toEqual({ kind: "opened" });
    expect(tab.location.href).toBe(url);
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledWith("/jobs/1/check-live");
  });

  it("closes the tab instead of opening a dead link", async () => {
    apiPost.mockResolvedValue({ data: { id: 2, listing_status: "active", verdict: "dead" } });
    const outcome = await openApplyAfterLiveCheck(2, url);
    expect(outcome).toEqual({ kind: "closed", listingStatus: "removed" });
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe("about:blank");
  });

  it("opens the link on an unknown verdict or a failed check", async () => {
    apiPost.mockResolvedValueOnce({ data: { id: 3, listing_status: "active", verdict: "unknown" } });
    await expect(openApplyAfterLiveCheck(3, url)).resolves.toEqual({ kind: "opened" });
    expect(tab.location.href).toBe(url);

    tab = fakeTab();
    apiPost.mockRejectedValueOnce(httpError(429));
    await expect(openApplyAfterLiveCheck(4, url)).resolves.toEqual({ kind: "opened" });
    expect(tab.location.href).toBe(url);
  });

  it("stops waiting on a slow check and opens the link", async () => {
    vi.useFakeTimers();
    apiPost.mockReturnValue(new Promise(() => {}));
    const pending = openApplyAfterLiveCheck(5, url);
    let settled = false;
    pending?.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(APPLY_CHECK_WAIT_MS - 100);
    expect(settled).toBe(false);
    expect(tab.location.href).toBe("about:blank");
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    expect(tab.location.href).toBe(url);
  });

  it("does not wait on Indeed links, which cannot be probed", () => {
    expect(openApplyAfterLiveCheck(6, "https://ca.indeed.com/viewjob?jk=abc")).toBeNull();
    expect(openApplyAfterLiveCheck(6, "https://www.indeed.com/viewjob?jk=abc")).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(isUnprobeableApplyUrl("https://notindeed.com/job")).toBe(false);
  });

  it("follows the link normally once the check already answered alive", async () => {
    apiPost.mockResolvedValue({ data: { id: 7, listing_status: "active", verdict: "alive" } });
    await checkListingLive(7);
    expect(openApplyAfterLiveCheck(7, url)).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("never opens a tab for a listing the check already found dead", async () => {
    apiPost.mockResolvedValue({ data: { id: 8, listing_status: "removed", verdict: "dead" } });
    await checkListingLive(8);
    await expect(openApplyAfterLiveCheck(8, url)).resolves.toEqual({
      kind: "closed",
      listingStatus: "removed",
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("leaves the click alone when the browser refuses the tab", () => {
    openSpy.mockImplementation(() => null);
    apiPost.mockReturnValue(new Promise(() => {}));
    expect(openApplyAfterLiveCheck(9, url)).toBeNull();
  });

  it("does not navigate a tab the user already closed", async () => {
    let answer: (value: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const pending = openApplyAfterLiveCheck(10, url);
    tab.closed = true;
    answer({ data: { id: 10, listing_status: "active", verdict: "alive" } });
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(tab.location.href).toBe("about:blank");
  });
});

describe("handleApplyLinkClick", () => {
  const url = "https://jobs.lever.co/acme/0f7b3c1e";
  let openSpy: ReturnType<typeof vi.spyOn>;
  let tab: { opener: unknown; closed: boolean; location: { href: string }; close: ReturnType<typeof vi.fn> };

  function click(overrides: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}) {
    return {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    apiPost.mockReset();
    resetLiveChecks();
    tab = { opener: {}, closed: false, location: { href: "about:blank" }, close: vi.fn() };
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
  });

  afterEach(() => {
    openSpy.mockRestore();
    vi.useRealTimers();
  });

  it("holds the click, then registers the apply once the job opens", async () => {
    apiPost.mockResolvedValue({ data: { id: 1, listing_status: "active", verdict: "alive" } });
    const event = click();
    const onOpened = vi.fn();
    const onClosed = vi.fn();
    handleApplyLinkClick(event, 1, url, { onOpened, onClosed });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(onClosed).not.toHaveBeenCalled();
    expect(tab.location.href).toBe(url);
  });

  it("reports a dead listing and never registers the apply", async () => {
    apiPost.mockResolvedValue({ data: { id: 2, listing_status: "active", verdict: "dead" } });
    const onOpened = vi.fn();
    const onClosed = vi.fn();
    handleApplyLinkClick(click(), 2, url, { onOpened, onClosed });
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith("removed"));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
  });

  it("leaves a modified click to the browser", () => {
    const event = click({ ctrlKey: true });
    const onOpened = vi.fn();
    handleApplyLinkClick(event, 3, url, { onOpened, onClosed: vi.fn() });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("still reports a dead verdict that lands after the wait gave up", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const onOpened = vi.fn();
    const onClosed = vi.fn();
    handleApplyLinkClick(click(), 4, url, { onOpened, onClosed });
    await vi.advanceTimersByTimeAsync(APPLY_CHECK_WAIT_MS + 10);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(url);
    expect(onClosed).not.toHaveBeenCalled();

    answer({ data: { id: 4, listing_status: "active", verdict: "dead" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(onClosed).toHaveBeenCalledWith("removed");
  });
});
