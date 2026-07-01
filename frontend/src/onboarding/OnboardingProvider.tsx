import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { TOUR_STEPS } from "./tourConfig";
import { TOUR_PROGRESS_KEY, type OnboardingProgress, type TourAnalytics } from "./types";
import { makeTourReducer, type TourState } from "./useTourController";
import { OnboardingOverlay } from "./OnboardingOverlay";

interface OnboardingContextValue {
  start: () => void;
  restart: () => Promise<void>;
  isRunning: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}

function readProgress(): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(TOUR_PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as OnboardingProgress) : null;
  } catch {
    return null;
  }
}

export function OnboardingProvider({
  children,
  analytics,
}: {
  children: ReactNode;
  analytics?: TourAnalytics;
}) {
  const reducer = useMemo(() => makeTourReducer(TOUR_STEPS), []);
  const [state, dispatch] = useReducer(reducer, { phase: "idle", index: -1 } as TourState);
  const { user, setOnboardingComplete } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const startedRef = useRef(false);
  const [stepReady, setStepReady] = useState(false);

  const step = state.index >= 0 ? TOUR_STEPS[state.index] : undefined;

  // Auto-start once for first-time users.
  useEffect(() => {
    if (startedRef.current) return;
    if (!user || user.has_completed_onboarding) return;
    startedRef.current = true;
    const saved = readProgress();
    analytics?.onTourStarted?.();
    if (saved && !saved.skipped) {
      const idx = TOUR_STEPS.findIndex((s) => s.id === saved.currentStepId);
      dispatch({ type: "START", index: idx >= 0 ? idx : undefined });
    } else {
      dispatch({ type: "START" });
    }
  }, [user, analytics]);

  // On each running step: navigate, run prepare, persist progress, fire analytics.
  useEffect(() => {
    if (state.phase !== "running" || !step) return;
    let cancelled = false;
    setStepReady(false);

    (async () => {
      if (step.route && location.pathname !== step.route) {
        navigate(step.route);
        // allow the route to render before prepare/lookup
        await new Promise((r) => setTimeout(r, 150));
      }
      if (cancelled) return;
      if (step.prepare) {
        try {
          await Promise.race([
            Promise.resolve(step.prepare()),
            new Promise<void>((resolve) => setTimeout(resolve, 4000)),
          ]);
          await new Promise((r) => setTimeout(r, 60));
        } catch (e) {
          if (import.meta.env.DEV) console.warn(`[onboarding] prepare failed for "${step.id}"`, e);
        }
      }
      if (cancelled) return;
      try {
        localStorage.setItem(
          TOUR_PROGRESS_KEY,
          JSON.stringify({ currentStepId: step.id, skipped: false } satisfies OnboardingProgress),
        );
      } catch { /* ignore quota */ }
      analytics?.onStepViewed?.(step, state.index);
      setStepReady(true);
    })();

    return () => { cancelled = true; };
  }, [state.phase, state.index, step, navigate, location.pathname, analytics]);

  const finish = useCallback(async (skipped: boolean) => {
    if (step) {
      if (skipped) analytics?.onTourSkipped?.(state.index);
      else analytics?.onStepCompleted?.(step, state.index);
    }
    analytics?.onTourFinished?.();
    try { localStorage.removeItem(TOUR_PROGRESS_KEY); } catch { /* ignore */ }
    dispatch({ type: "FINISH" });
    try { await setOnboardingComplete(true); } catch { /* offline: DB sync retried next session */ }
  }, [step, state.index, analytics, setOnboardingComplete]);

  const handleNext = useCallback(() => {
    const isLast = state.index >= TOUR_STEPS.length - 1;
    if (isLast) {
      void finish(false);
      return;
    }
    if (step) analytics?.onStepCompleted?.(step, state.index);
    dispatch({ type: "NEXT" });
  }, [step, state.index, analytics, finish]);

  const handlePrev = useCallback(() => dispatch({ type: "PREV" }), []);
  const handleSkip = useCallback(() => void finish(true), [finish]);
  const handleMissing = useCallback(() => dispatch({ type: "NEXT" }), []);

  const start = useCallback(() => dispatch({ type: "START" }), []);
  const restart = useCallback(async () => {
    try { localStorage.removeItem(TOUR_PROGRESS_KEY); } catch { /* ignore */ }
    try { await setOnboardingComplete(false); } catch { /* ignore */ }
    startedRef.current = true;
    dispatch({ type: "START" });
  }, [setOnboardingComplete]);

  const ctxValue = useMemo<OnboardingContextValue>(
    () => ({ start, restart, isRunning: state.phase === "running" }),
    [start, restart, state.phase],
  );

  const showOverlay = state.phase === "running" && !!step && stepReady;

  return (
    <OnboardingContext.Provider value={ctxValue}>
      {children}
      {showOverlay && step && (
        <OnboardingOverlay
          step={step}
          index={state.index}
          total={TOUR_STEPS.length}
          canPrev={state.index > 0}
          isLast={state.index >= TOUR_STEPS.length - 1}
          onPrev={handlePrev}
          onNext={handleNext}
          onSkip={handleSkip}
          onMissing={handleMissing}
        />
      )}
    </OnboardingContext.Provider>
  );
}
