import { useSearchParams } from "react-router-dom";
import { LinkedinLogo } from "@phosphor-icons/react";

/**
 * "Continue with LinkedIn" — a full-page navigation to the backend OAuth start
 * endpoint (it leaves the SPA, so a plain <a> is correct). Hidden unless
 * VITE_LINKEDIN_ENABLED === "true", mirroring the Google button's gating.
 * The "or" divider is provided by <GoogleSignInButton /> above it.
 */
export function LinkedInSignInButton() {
  const [searchParams] = useSearchParams();
  const enabled = import.meta.env.VITE_LINKEDIN_ENABLED === "true";
  if (!enabled) return null;
  const next = searchParams.get("next") || "/app";
  const href = `/auth/linkedin/start?next=${encodeURIComponent(next)}`;
  return (
    <a className="linkedin-signin-button" href={href} aria-label="Continue with LinkedIn">
      <LinkedinLogo size={18} weight="fill" />
      <span>Continue with LinkedIn</span>
    </a>
  );
}
