import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import api from "../auth/api";

export interface PendingJob {
  id: number;
  title: string;
  company: string;
}

export interface ApplyQueueState {
  queue: PendingJob[];
  current: PendingJob | null;
}

type ApplyQueueAction =
  | { type: "REGISTER"; job: PendingJob }
  | { type: "SHOW_NEXT" }
  | { type: "DEQUEUE" };

export function applyQueueReducer(state: ApplyQueueState, action: ApplyQueueAction): ApplyQueueState {
  switch (action.type) {
    case "REGISTER":
      if (state.current === null) {
        return { ...state, current: action.job };
      }
      return { ...state, queue: [...state.queue, action.job] };
    case "SHOW_NEXT": {
      if (state.current !== null || state.queue.length === 0) {
        return state;
      }
      const [next, ...rest] = state.queue;
      return { current: next, queue: rest };
    }
    case "DEQUEUE": {
      if (state.queue.length === 0) {
        return { current: null, queue: [] };
      }
      const [next, ...rest] = state.queue;
      return { current: next, queue: rest };
    }
    default:
      return state;
  }
}

interface ApplyTrackingContextValue {
  registerApplyClick: (job: PendingJob) => void;
  current: PendingJob | null;
  confirmYes: () => void;
  confirmNo: () => void;
}

const ApplyTrackingContext = createContext<ApplyTrackingContextValue | null>(null);

export function ApplyTrackingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(applyQueueReducer, { queue: [], current: null });

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        dispatch({ type: "SHOW_NEXT" });
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function registerApplyClick(job: PendingJob) {
    dispatch({ type: "REGISTER", job });
  }

  function confirmYes() {
    const job = state.current;
    if (job) {
      api.post(`/jobs/${job.id}/mark-applied`).catch(() => {
        // Silently fail — the user already confirmed visually; not worth a blocking error UI.
      });
    }
    dispatch({ type: "DEQUEUE" });
  }

  function confirmNo() {
    dispatch({ type: "DEQUEUE" });
  }

  return (
    <ApplyTrackingContext.Provider value={{ registerApplyClick, current: state.current, confirmYes, confirmNo }}>
      {children}
    </ApplyTrackingContext.Provider>
  );
}

export function useApplyTracking(): ApplyTrackingContextValue {
  const ctx = useContext(ApplyTrackingContext);
  if (!ctx) {
    throw new Error("useApplyTracking must be used within an ApplyTrackingProvider");
  }
  return ctx;
}
