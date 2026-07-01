import { useEffect } from "react";
import { Spotlight } from "./engine/Spotlight";
import { TourTooltip } from "./engine/TourTooltip";
import { useTargetElement } from "./engine/useTargetElement";
import type { TourStep } from "./types";

interface Props {
  step: TourStep;
  index: number;
  total: number;
  canPrev: boolean;
  isLast: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
  /** Called when the target could not be found within the timeout. */
  onMissing: () => void;
}

export function OnboardingOverlay(props: Props) {
  const { rect, status } = useTargetElement(props.step.target, true);

  useEffect(() => {
    if (status === "missing") {
      if (import.meta.env.DEV) {
        console.warn(`[onboarding] target not found, skipping step "${props.step.id}"`);
      }
      props.onMissing();
    }
  }, [status, props.step.id, props.onMissing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onSkip();
      else if (e.key === "ArrowRight") props.onNext();
      else if (e.key === "ArrowLeft" && props.canPrev) props.onPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onSkip, props.onNext, props.onPrev, props.canPrev]);

  if (status === "pending" || status === "missing") return null;

  return (
    <div className="tour-overlay">
      <Spotlight rect={rect} padding={props.step.spotlightPadding ?? 8} />
      <TourTooltip
        title={props.step.title}
        description={props.step.description}
        index={props.index}
        total={props.total}
        canPrev={props.canPrev}
        isLast={props.isLast}
        rect={rect}
        placement={props.step.placement ?? "auto"}
        onPrev={props.onPrev}
        onNext={props.onNext}
        onSkip={props.onSkip}
      />
    </div>
  );
}
