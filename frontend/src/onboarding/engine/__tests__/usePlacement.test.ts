import { describe, it, expect } from "vitest";
import { computePlacement } from "../usePlacement";

const vp = { width: 1000, height: 800 };
const tip = { width: 200, height: 100 };

function rect(top: number, left: number, w = 100, h = 40): DOMRect {
  return { top, left, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("computePlacement", () => {
  it("centers when there is no target", () => {
    const r = computePlacement(null, tip, vp, "auto");
    expect(r.placement).toBe("center");
    expect(r.left).toBe((vp.width - tip.width) / 2);
  });

  it("places below the target for bottom preference with room", () => {
    const r = computePlacement(rect(100, 400), tip, vp, "bottom");
    expect(r.placement).toBe("bottom");
    expect(r.top).toBeGreaterThan(140);
  });

  it("flips to top when there is no room below", () => {
    const r = computePlacement(rect(760, 400), tip, vp, "bottom");
    expect(r.placement).toBe("top");
  });

  it("clamps within the viewport horizontally", () => {
    const r = computePlacement(rect(100, 980), tip, vp, "bottom");
    expect(r.left).toBeGreaterThanOrEqual(8);
    expect(r.left + tip.width).toBeLessThanOrEqual(vp.width - 8);
  });
});
