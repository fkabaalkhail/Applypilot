import { useEffect } from "react";
import { X } from "@phosphor-icons/react";
import type { PageIntroContent } from "./pageIntros";
import "./page-intro.css";

interface Props {
  content: PageIntroContent;
  onClose: () => void;
}

/** Presentational first-visit intro modal. Themed with our tokens. */
export function PageIntroModal({ content, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pgi-overlay" onClick={onClose}>
      <div
        className="pgi-card"
        role="dialog"
        aria-modal="true"
        aria-label={content.title}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pgi-close" onClick={onClose} aria-label="Close">
          <X size={18} weight="bold" />
        </button>

        <div className="pgi-banner">
          <div className="pgi-badge">
            <img src="/logo-icon.png" alt="Tailrd" />
          </div>
          <span className="pgi-eyebrow">{content.eyebrow}</span>
          <h2 className="pgi-title">{content.title}</h2>
          <p className="pgi-desc">{content.description}</p>

          <div className="pgi-preview" aria-hidden>
            <div className="pgi-preview-head">
              <div className="pgi-preview-brand">
                <span className="pgi-preview-dot" />
                <span className="pgi-bar w45" style={{ margin: 0, width: 64 }} />
              </div>
              <span className="pgi-preview-chip">STRONG MATCH · 96%</span>
            </div>
            <div className="pgi-bar w85" />
            <div className="pgi-bar w70" />
            <div className="pgi-bar w45" />
          </div>
        </div>

        <div className="pgi-footer">
          <button className="pgi-btn" onClick={onClose}>Start Now</button>
        </div>
      </div>
    </div>
  );
}
