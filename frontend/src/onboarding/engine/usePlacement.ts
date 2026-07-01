import type { Placement } from "../types";

export type ResolvedPlacement = Exclude<Placement, "auto"> | "center";

interface Size { width: number; height: number; }

const MARGIN = 8;

function fits(p: Exclude<Placement, "auto">, r: DOMRect, tip: Size, vp: Size, gap: number): boolean {
  switch (p) {
    case "bottom": return r.bottom + gap + tip.height <= vp.height - MARGIN;
    case "top": return r.top - gap - tip.height >= MARGIN;
    case "right": return r.right + gap + tip.width <= vp.width - MARGIN;
    case "left": return r.left - gap - tip.width >= MARGIN;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

export function computePlacement(
  targetRect: DOMRect | null,
  tip: Size,
  vp: Size,
  preferred: Placement,
  gap = 12,
): { top: number; left: number; placement: ResolvedPlacement } {
  if (!targetRect) {
    return {
      top: (vp.height - tip.height) / 2,
      left: (vp.width - tip.width) / 2,
      placement: "center",
    };
  }

  const order: Exclude<Placement, "auto">[] =
    preferred === "auto"
      ? ["bottom", "top", "right", "left"]
      : [preferred, "bottom", "top", "right", "left"];

  const chosen = order.find((p) => fits(p, targetRect, tip, vp, gap)) ?? "bottom";

  let top: number;
  let left: number;
  switch (chosen) {
    case "bottom":
      top = targetRect.bottom + gap;
      left = targetRect.left + targetRect.width / 2 - tip.width / 2;
      break;
    case "top":
      top = targetRect.top - gap - tip.height;
      left = targetRect.left + targetRect.width / 2 - tip.width / 2;
      break;
    case "right":
      top = targetRect.top + targetRect.height / 2 - tip.height / 2;
      left = targetRect.right + gap;
      break;
    case "left":
      top = targetRect.top + targetRect.height / 2 - tip.height / 2;
      left = targetRect.left - gap - tip.width;
      break;
  }

  return {
    placement: chosen,
    top: clamp(top, MARGIN, vp.height - tip.height - MARGIN),
    left: clamp(left, MARGIN, vp.width - tip.width - MARGIN),
  };
}
