import { describe, it, expect } from "vitest";
import { applyQueueReducer, type ApplyQueueState, type PendingJob } from "../context/ApplyTracking";

const jobA: PendingJob = { id: 1, title: "Software Engineer", company: "Acme" };
const jobB: PendingJob = { id: 2, title: "Backend Intern", company: "Beta Corp" };

function initialState(): ApplyQueueState {
  return { queue: [], current: null };
}

describe("applyQueueReducer", () => {
  it("REGISTER appends to the queue when nothing is current", () => {
    const state = applyQueueReducer(initialState(), { type: "REGISTER", job: jobA });
    expect(state.queue).toEqual([]);
    expect(state.current).toEqual(jobA);
  });

  it("REGISTER queues behind an already-current job", () => {
    let state = applyQueueReducer(initialState(), { type: "REGISTER", job: jobA });
    state = applyQueueReducer(state, { type: "REGISTER", job: jobB });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("SHOW_NEXT promotes the front of the queue to current when current is empty", () => {
    let state: ApplyQueueState = { queue: [jobA, jobB], current: null };
    state = applyQueueReducer(state, { type: "SHOW_NEXT" });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("SHOW_NEXT is a no-op when current is already set", () => {
    let state: ApplyQueueState = { queue: [jobB], current: jobA };
    state = applyQueueReducer(state, { type: "SHOW_NEXT" });
    expect(state.current).toEqual(jobA);
    expect(state.queue).toEqual([jobB]);
  });

  it("DEQUEUE clears current and promotes the next queued job (FIFO)", () => {
    let state: ApplyQueueState = { queue: [jobB], current: jobA };
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toEqual(jobB);
    expect(state.queue).toEqual([]);
  });

  it("DEQUEUE with an empty queue leaves current null", () => {
    let state: ApplyQueueState = { queue: [], current: jobA };
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it("processes multiple registers in FIFO order across repeated dequeues", () => {
    let state = initialState();
    state = applyQueueReducer(state, { type: "REGISTER", job: jobA });
    state = applyQueueReducer(state, { type: "REGISTER", job: jobB });
    expect(state.current).toEqual(jobA);
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toEqual(jobB);
    state = applyQueueReducer(state, { type: "DEQUEUE" });
    expect(state.current).toBeNull();
  });
});
