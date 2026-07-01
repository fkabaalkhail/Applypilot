export type Placement = "top" | "bottom" | "left" | "right" | "auto";

export interface TourStep {
  /** Stable unique id, also used as the persisted resume key. */
  id: string;
  /** If set and not the current path, navigate here before showing. */
  route?: string;
  /** CSS selector for the highlighted element. Omit for a centered card. */
  target?: string;
  title: string;
  description: string;
  placement?: Placement;
  /** If it returns false, the step is skipped. */
  condition?: () => boolean;
  /** px of padding around the spotlight cutout (default 8). */
  spotlightPadding?: number;
  /** Runs after navigation, before target lookup (e.g. open a job). */
  prepare?: () => void | Promise<void>;
}

export interface TourAnalytics {
  onTourStarted?: () => void;
  onStepViewed?: (step: TourStep, index: number) => void;
  onStepCompleted?: (step: TourStep, index: number) => void;
  onTourSkipped?: (atIndex: number) => void;
  onTourFinished?: () => void;
}

export interface OnboardingProgress {
  currentStepId: string;
  skipped: boolean;
}

export const TOUR_PROGRESS_KEY = "tailrd_tour_progress";
