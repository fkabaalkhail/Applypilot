import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";

/** Shared marketing top nav. Section links use hash routes so they work from
 *  any page; the Landing page scrolls to the hash on mount / hash change. */
export default function SiteHeader() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  return (
    <nav className="landing-nav">
      <div className="landing-nav-inner">
        <div className="landing-brand">
          <Link to="/" aria-label="Tailrd home">
            <img src="/logo-full.png" alt="Tailrd" className="landing-logo-full" />
          </Link>
        </div>
        <div className="landing-nav-links">
          <Link to={{ pathname: "/", hash: "#features" }} className="nav-link-item">Features</Link>
          <Link to="/pricing" className="nav-link-item">Pricing</Link>
          <Link to={{ pathname: "/", hash: "#success-story" }} className="nav-link-item">Results</Link>
          <Link to={{ pathname: "/", hash: "#faq" }} className="nav-link-item">FAQ</Link>
        </div>
        <div className="landing-nav-actions">
          {isAuthenticated ? (
            <button className="btn-cta nav-cta" onClick={() => navigate("/app")}>Dashboard</button>
          ) : (
            <>
              <button className="btn-ghost nav-login" onClick={() => navigate("/sign-in")}>Log in</button>
              <button className="btn-cta nav-cta" onClick={() => navigate("/sign-up")}>Sign up</button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
