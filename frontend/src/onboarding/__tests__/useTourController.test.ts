import { describe, it, expect } from "vitest";
import { makeTourReducer, nextVisibleIndex } from "../useTourController";
import type { TourStep } from "../types";

const steps: TourStep[] = [
  { id: "a", title: "A", description: "" },
  { id: "b", title: "B", description: "", condition: () => false },
  { id: "c", title: "C", description: "" },
];

const tourReducer = makeTourReducer(steps);

describe("nextVisibleIndex", () => {
  it("skips steps whose condition is false going forward", () => {
    expect(nextVisibleIndex(steps, 0, 1)).toBe(2);
  });
  it("returns -1 past the end", () => {
    expect(nextVisibleIndex(steps, 2, 1)).toBe(-1);
  });
});

describe("tourReducer", () => {
  it("START enters running at index 0", () => {
    const s = tourReducer({ phase: "idle", index: -1 }, { type: "START" });
    expect(s).toEqual({ phase: "running", index: 0 });
  });
  it("NEXT past the last visible step finishes", () => {
    const s = tourReducer({ phase: "running", index: 2 }, { type: "NEXT" });
    expect(s.phase).toBe("finished");
  });
  it("SKIP finishes immediately", () => {
    const s = tourReducer({ phase: "running", index: 1 }, { type: "SKIP" });
    expect(s.phase).toBe("finished");
  });
});
