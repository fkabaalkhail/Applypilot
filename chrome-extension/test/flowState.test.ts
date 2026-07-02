import { describe, it, expect, beforeEach } from "vitest";
import { getFlowState, setFlowState } from "../src/background/flowState";
import type { FlowState } from "../src/shared/types";

/** Minimal chrome.storage.session mock (get(key) → { key: value }). */
function mockSessionStorage(): Record<string, unknown> {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: mem[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(mem, obj);
        },
      },
    },
    tabs: { onRemoved: { addListener: (): void => {} } },
  };
  return mem;
}

const state: FlowState = { active: true, step: 2, startedAt: 123, lastSignature: "3:abc" };

describe("flowState", () => {
  beforeEach(() => {
    mockSessionStorage();
  });

  it("round-trips a per-tab state", async () => {
    await setFlowState(7, state);
    expect(await getFlowState(7)).toEqual(state);
    expect(await getFlowState(8)).toBeNull();
  });

  it("clears a tab's state with null and leaves other tabs alone", async () => {
    await setFlowState(7, state);
    await setFlowState(9, { ...state, step: 0 });
    await setFlowState(7, null);
    expect(await getFlowState(7)).toBeNull();
    expect((await getFlowState(9))?.step).toBe(0);
  });
});
