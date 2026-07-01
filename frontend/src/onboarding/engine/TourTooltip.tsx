import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { computePlacement } from "./usePlacement";
import type { Placement } from "../types";

interface Props {
  title: string;
  description: string;
  index: number;
  total: number;
  canPrev: boolean;
  isLast: boolean;
  rect: DOMRect | null;
  placement: Placement;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function TourTooltip(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const p = computePlacement(props.rect, size, vp, props.placement ?? "auto");
    setPos({ top: p.top, left: p.left });
  }, [props.rect, props.placement, props.title]);

  // Focus the card for keyboard users / focus trap entry.
  useEffect(() => { ref.current?.focus(); }, [props.index]);

  return (
    <motion.div
      ref={ref}
      className="tour-tooltip"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      tabIndex={-1}
      style={{ top: pos.top, left: pos.left }}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
    >
      <h3 className="tour-tooltip-title">{props.title}</h3>
      <p className="tour-tooltip-desc">{props.description}</p>
      <div className="tour-tooltip-footer">
        <div className="tour-dots" aria-label={`Step ${props.index + 1} of ${props.total}`}>
          {Array.from({ length: props.total }).map((_, i) => (
            <span key={i} className={`tour-dot${i === props.index ? " active" : ""}`} />
          ))}
        </div>
        <div className="tour-actions">
          <button className="tour-skip" onClick={props.onSkip}>Skip</button>
          <div className="tour-actions-right">
            {props.canPrev && (
              <button className="tour-btn tour-btn-ghost" onClick={props.onPrev}>Back</button>
            )}
            <button className="tour-btn tour-btn-primary" onClick={props.onNext}>
              {props.isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
