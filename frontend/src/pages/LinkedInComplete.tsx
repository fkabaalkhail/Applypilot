import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { safeNextPath } from "../auth/nextRedirect";

/** Landing page after the LinkedIn OAuth callback (route: /linkedin/complete).
 *  Hydrates the session from the refresh cookie, then redirects into the app. */
export default function LinkedInComplete() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { completeOAuthRedirect } = useAuth();
  const [failed, setFailed] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    // React 18 StrictMode invokes effects twice in dev; without this guard two
    // concurrent completeOAuthRedirect() calls each POST /auth/refresh, and the
    // second rotation revokes the token the first just minted.
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;
    completeOAuthRedirect()
      .then(() => { if (!cancelled) navigate(safeNextPath(searchParams.get("next")), { replace: true }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [completeOAuthRedirect, navigate, searchParams]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo-icon.png" alt="Tailrd" className="auth-brand-logo" />
        </div>
        {failed ? (
          <div className="auth-head">
            <h1 className="auth-title">Sign-in failed</h1>
            <p className="auth-subtitle">We couldn't complete your LinkedIn sign-in.</p>
            <Link to="/sign-in" className="auth-link">Back to sign in</Link>
          </div>
        ) : (
          <div className="auth-head">
            <h1 className="auth-title">Signing you in…</h1>
            <p className="auth-subtitle">One moment while we finish connecting your LinkedIn account.</p>
          </div>
        )}
      </div>
    </div>
  );
}
