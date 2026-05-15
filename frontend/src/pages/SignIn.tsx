import { useState, FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { GoogleSignInButton } from "../auth/GoogleSignInButton";

export default function SignInPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      await login(email, password);
      navigate("/app");
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } };
        const status = axiosErr.response?.status;
        const detail = axiosErr.response?.data?.detail;
        if (status === 401) {
          setError(detail || "Invalid email or password.");
        } else if (status === 422) {
          setError(detail || "Please check your input and try again.");
        } else {
          setError(detail || `Server error (${status}). Please try again later.`);
        }
      } else if (err && typeof err === "object" && "code" in err) {
        const axiosErr = err as { code?: string; message?: string };
        if (axiosErr.code === "ERR_NETWORK") {
          setError("Cannot reach the server. Check that the backend is running.");
        } else {
          setError(axiosErr.message || "Network error. Please try again.");
        }
      } else {
        setError("Login failed. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        {/* Left overlay panel */}
        <div className="auth-overlay">
          <img src="/logo-icon.png" alt="Resumate" className="auth-overlay-logo" />
          <h2 className="auth-overlay-title">New Here?</h2>
          <p className="auth-overlay-text">
            Create an account and start matching with your dream jobs today.
          </p>
          <Link to="/sign-up" className="auth-overlay-btn">
            Sign Up
          </Link>
        </div>

        {/* Right form panel */}
        <div className="auth-form-panel">
          <div className="auth-form-header">
            <h1 className="auth-form-title">Welcome Back</h1>
            <p className="auth-form-subtitle">Sign in to your account</p>
          </div>

          <form onSubmit={handleSubmit} className="auth-form">
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="email" className="auth-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="auth-input"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>

            <div className="auth-field">
              <label htmlFor="password" className="auth-label">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="auth-input"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className="auth-submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <GoogleSignInButton />

          <p className="auth-footer">
            Don't have an account?{" "}
            <Link to="/sign-up" className="auth-link">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
