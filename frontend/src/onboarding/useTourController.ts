import type { TourStep } from "./types";

export interface TourState {
  phase: "idle" | "running" | "finished";
  index: number;
}

export type TourAction =
  | { type: "START"; index?: number }
  | { type: "NEXT" }
  | { type: "PREV" }
  | { type: "GOTO"; index: number }
  | { type: "SKIP" }
  | { type: "FINISH" };

/** Next index (in `dir`) whose condition passes; -1 if none remain. */
export function nextVisibleIndex(steps: TourStep[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < steps.length; i += dir) {
    const cond = steps[i].condition;
    if (!cond || cond()) return i;
  }
  return -1;
}

function firstVisible(steps: TourStep[]): number {
  const c0 = steps[0]?.condition;
  return !c0 || c0() ? 0 : nextVisibleIndex(steps, 0, 1);
}

export function makeTourReducer(steps: TourStep[]) {
  return function tourReducer(state: TourState, action: TourAction): TourState {
    switch (action.type) {
      case "START": {
        const idx = action.index ?? firstVisible(steps);
        return idx < 0 ? { phase: "finished", index: -1 } : { phase: "running", index: idx };
      }
      case "NEXT": {
        const idx = nextVisibleIndex(steps, state.index, 1);
        return idx < 0 ? { phase: "finished", index: state.index } : { phase: "running", index: idx };
      }
      case "PREV": {
        const idx = nextVisibleIndex(steps, state.index, -1);
        return idx < 0 ? state : { phase: "running", index: idx };
      }
      case "GOTO":
        return { phase: "running", index: action.index };
      case "SKIP":
      case "FINISH":
        return { phase: "finished", index: state.index };
      default:
        return state;
    }
  };
}
