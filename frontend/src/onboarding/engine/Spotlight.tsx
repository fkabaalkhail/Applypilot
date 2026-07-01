import { motion } from "framer-motion";

interface Props { rect: DOMRect | null; padding: number; }

export function Spotlight({ rect, padding }: Props) {
  const pad = padding;
  const hole = rect
    ? { x: rect.left - pad, y: rect.top - pad, w: rect.width + pad * 2, h: rect.height + pad * 2 }
    : { x: 0, y: 0, w: 0, h: 0 };

  return (
    <svg className="tour-spotlight-svg" aria-hidden>
      <defs>
        <mask id="tour-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {rect && (
            <motion.rect
              rx={10}
              ry={10}
              fill="black"
              initial={false}
              animate={{ x: hole.x, y: hole.y, width: hole.w, height: hole.h }}
              transition={{ type: "spring", stiffness: 300, damping: 32 }}
            />
          )}
        </mask>
      </defs>
      <rect className="tour-spotlight-dim" x="0" y="0" width="100%" height="100%" mask="url(#tour-mask)" />
    </svg>
  );
}
