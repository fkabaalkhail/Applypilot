import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServerDate, timeAgo } from "../lib/datetime";

afterEach(() => vi.useRealTimers());

describe("parseServerDate", () => {
  it("reads an offset-less timestamp as UTC, not local time", () => {
    // The bug: JS parses "2026-07-08T14:00:00" as *local*, so a UTC-4 user saw a
    // just-created resume as four hours in the future.
    const naive = parseServerDate("2026-07-08T14:00:00");
    const explicit = parseServerDate("2026-07-08T14:00:00Z");
    expect(naive?.getTime()).toBe(explicit?.getTime());
  });

  it("respects an explicit offset when one is present", () => {
    expect(parseServerDate("2026-07-08T10:00:00-04:00")?.toISOString())
      .toBe("2026-07-08T14:00:00.000Z");
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseServerDate("")).toBeNull();
    expect(parseServerDate(null)).toBeNull();
    expect(parseServerDate("not a date")).toBeNull();
  });
});

describe("timeAgo", () => {
  it("clamps a future timestamp to 'just now' rather than printing a negative", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-07-08T12:00:00Z"));
    expect(timeAgo("2026-07-08T16:00:00Z")).toBe("just now");
    expect(timeAgo("2026-07-08T12:00:00")).toBe("just now");
  });

  it("formats the usual ranges", () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-07-08T12:00:00Z"));
    expect(timeAgo("2026-07-08T11:30:00Z")).toBe("30m ago");
    expect(timeAgo("2026-07-08T06:00:00Z")).toBe("6h ago");
    expect(timeAgo("2026-07-07T06:00:00Z")).toBe("yesterday");
    expect(timeAgo("2026-06-28T12:00:00Z")).toBe("10 days ago");
    expect(timeAgo("2026-05-08T12:00:00Z")).toBe("2 months ago");
    expect(timeAgo("2024-07-08T12:00:00Z")).toBe("2 years ago");
  });

  it("renders an em dash for a missing timestamp", () => {
    expect(timeAgo(null)).toBe("—");
  });
});
