import React, { useRef, useState } from "react";

interface TiltCardProps {
  children: React.ReactNode;
  className?: string;
  maxTilt?: number;
  scale?: number;
  spotlightSize?: number;
}

export function TiltCard({
  children,
  className = "",
  maxTilt = 12,
  scale = 1.02,
  spotlightSize = 300,
}: TiltCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [spotlight, setSpotlight] = useState({ x: 50, y: 50, opacity: 0 });
  const [isHovered, setIsHovered] = useState(false);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const card = cardRef.current;
    if (!card) return;

    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = e.clientX - cx;
    const dy = e.clientY - cy;

    const tiltX = -(dy / (rect.height / 2)) * maxTilt;
    const tiltY = (dx / (rect.width / 2)) * maxTilt;

    const spotX = ((e.clientX - rect.left) / rect.width) * 100;
    const spotY = ((e.clientY - rect.top) / rect.height) * 100;

    setTilt({ x: tiltX, y: tiltY });
    setSpotlight({ x: spotX, y: spotY, opacity: 0.18 });
  }

  function handleMouseEnter() {
    setIsHovered(true);
    setSpotlight((s) => ({ ...s, opacity: 0.18 }));
  }

  function handleMouseLeave() {
    setIsHovered(false);
    setTilt({ x: 0, y: 0 });
    setSpotlight((s) => ({ ...s, opacity: 0 }));
  }

  return (
    <div
      ref={cardRef}
      className={className}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        position: "relative",
        overflow: "hidden",
        transform: isHovered
          ? `perspective(800px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${scale})`
          : "perspective(800px) rotateX(0deg) rotateY(0deg) scale(1)",
        transition: isHovered
          ? "transform 0.1s ease-out"
          : "transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        willChange: "transform",
      }}
    >
      {/* Spotlight overlay */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 10,
          background: `radial-gradient(${spotlightSize}px circle at ${spotlight.x}% ${spotlight.y}%, rgba(255,255,255,${spotlight.opacity}), transparent 70%)`,
          transition: isHovered ? "opacity 0.1s" : "opacity 0.4s",
          borderRadius: "inherit",
        }}
      />
      {children}
    </div>
  );
}
