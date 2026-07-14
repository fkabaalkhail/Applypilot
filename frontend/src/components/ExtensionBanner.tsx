import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X, PuzzlePiece } from "@phosphor-icons/react";
import { pingExtension, type ExtensionState } from "../lib/extensionBridge";
import { CHROME_STORE_URL } from "../lib/extensionStore";
import "./extension-banner.css";

const SNOOZE_KEY = "tailrd.extBanner.snoozedUntil";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function isSnoozed(): boolean {
  const until = Number(localStorage.getItem(SNOOZE_KEY));
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Dev-only override. The extension's externally_connectable.matches covers only
 * tailrd.ca, so on localhost the real ping always reports "not-installed" and
 * the other two states are undrivable. Vite statically replaces
 * import.meta.env.DEV with false in production, so this whole branch is
 * dead-code-eliminated from the prod bundle.
 */
function devStateOverride(): ExtensionState | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(window.location.search).get("extState");
  return v === "connected" || v === "installed" || v === "not-installed" ? v : null;
}

export default function ExtensionBanner() {
  const [state, setState] = useState<ExtensionState>("unknown");
  const [dismissed, setDismissed] = useState(isSnoozed);

  useEffect(() => {
    const override = devStateOverride();
    if (override) {
      setState(override);
      return;
    }
    let alive = true;
    void pingExtension().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Installing is the outcome we wanted, so retire the snooze. A snooze that
  // outlived an uninstall would silently suppress the prompt for a week.
  useEffect(() => {
    if (state === "connected") localStorage.removeItem(SNOOZE_KEY);
  }, [state]);

  // "unknown" is the pre-ping state: render nothing rather than flash a banner
  // at users who already have the extension.
  if (state === "unknown" || state === "connected" || dismissed) return null;

  const snooze = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    setDismissed(true);
  };

  const installed = state === "installed";

  return (
    <aside className="ext-banner" role="region" aria-label="Tailrd Chrome extension">
      <div className="ext-banner-copy">
        <span className="ext-banner-eyebrow">
          {installed ? "Almost there" : "New · Chrome extension"}
        </span>
        <p className="ext-banner-headline">
          {installed
            ? "Sign in to the extension to start autofilling"
            : "Autofill any job application in one click"}
        </p>
        {installed ? (
          <Link className="ext-banner-cta" to="/extension/connect">
            Finish setup
          </Link>
        ) : (
          <a
            className="ext-banner-cta"
            href={CHROME_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to Chrome — it's free
          </a>
        )}
      </div>

      <div className="ext-banner-art" aria-hidden="true">
        <span className="ext-banner-ring ext-banner-ring-lg" />
        <span className="ext-banner-ring ext-banner-ring-md" />
        <span className="ext-banner-mark">
          <PuzzlePiece size={28} weight="fill" />
        </span>
      </div>

      <button type="button" className="ext-banner-close" onClick={snooze} aria-label="Dismiss">
        <X size={16} weight="bold" />
      </button>
    </aside>
  );
}
