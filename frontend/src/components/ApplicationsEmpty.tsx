import { Link } from "react-router-dom";
import { MagnifyingGlass } from "@phosphor-icons/react";

/**
 * Empty state for the Applications page.
 *
 * The illustration deliberately draws the card this page will be made of, logo
 * tile, role, company, so the blank screen previews its own filled state. The
 * check seal is the only saturated element; everything else stays in the
 * hairline greys the real cards use.
 */
function ApplicationsArt() {
  return (
    <svg
      className="empty-state-art"
      viewBox="0 0 260 176"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="app-empty-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#533afd" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#533afd" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="app-empty-seal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#665efd" />
          <stop offset="100%" stopColor="#533afd" />
        </linearGradient>
        {/* The front card is white on a white panel, without a shadow it is only
          * a hairline, and the whole stack reads as a smudge. */}
        <filter id="app-empty-lift" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#0d253d" floodOpacity="0.10" />
        </filter>
      </defs>

      {/* Ground shadow, so the stack sits on something */}
      <ellipse cx="126" cy="152" rx="86" ry="13" fill="url(#app-empty-glow)" />

      {/* The two applications behind the one in front */}
      <rect
        x="60" y="36" width="132" height="96" rx="12"
        transform="rotate(-10 126 84)"
        fill="#f4f3ff" stroke="#e4e0fd" strokeWidth="1.5"
      />
      <rect
        x="60" y="36" width="132" height="96" rx="12"
        transform="rotate(-5 126 84)"
        fill="#eef0ff" stroke="#d7d0fc" strokeWidth="1.5"
      />

      {/* The front card: the same anatomy as a real application row */}
      <g transform="rotate(1.5 126 84)">
        <rect
          x="60" y="36" width="132" height="96" rx="12"
          fill="#ffffff" stroke="#dfe6ee" strokeWidth="1.5"
          filter="url(#app-empty-lift)"
        />
        <rect x="74" y="50" width="22" height="22" rx="7" fill="#dfe5ec" />
        <rect x="104" y="52" width="62" height="7" rx="3.5" fill="#ccd4dd" />
        <rect x="104" y="64" width="40" height="6" rx="3" fill="#e3e8ee" />
        <rect x="74" y="88" width="104" height="1.5" rx="0.75" fill="#eef2f6" />
        <rect x="74" y="100" width="96" height="6" rx="3" fill="#eef2f6" />
        <rect x="74" y="112" width="60" height="6" rx="3" fill="#eef2f6" />
      </g>

      {/* Applied. The one thing on the page with any colour in it. */}
      <circle cx="186" cy="44" r="17" fill="url(#app-empty-seal)" stroke="#ffffff" strokeWidth="4" />
      <path
        d="M178 44.5 L183.5 50 L194 38.5"
        fill="none" stroke="#ffffff" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round"
      />

      <circle cx="52" cy="30" r="3.5" fill="#c3b9fd" opacity="0.8" />
      <circle cx="212" cy="128" r="2.5" fill="#f96bee" opacity="0.55" />
    </svg>
  );
}

export default function ApplicationsEmpty() {
  return (
    <div className="empty-state">
      <ApplicationsArt />
      <h2>No applications yet</h2>
      <p>
        Apply from the jobs feed or with the Tailrd extension, and each one is tracked
        here: the company, the role, and the day you applied.
      </p>
      <Link to="/app" className="empty-state-cta">
        <MagnifyingGlass size={16} weight="bold" /> Browse jobs
      </Link>
    </div>
  );
}
