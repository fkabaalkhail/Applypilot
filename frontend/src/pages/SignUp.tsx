import { useState, FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { GoogleSignInButton } from "../auth/GoogleSignInButton";

export default function SignUpPage() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      await register(email, password);
      navigate("/verify-email");
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } };
        const status = axiosErr.response?.status;
        const detail = axiosErr.response?.data?.detail;
        if (status === 409) {
          setError(detail || "This email is already registered. Try signing in.");
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
        setError("Registration failed. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-container">
        {/* Left form panel */}
        <div className="auth-form-panel">
          <div className="auth-form-header">
            <h1 className="auth-form-title">Create Account</h1>
            <p className="auth-form-subtitle">Get started with Resumate</p>
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
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            <div className="auth-field">
              <label htmlFor="confirm-password" className="auth-label">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="auth-input"
                placeholder="••••••••"
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              className="auth-submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Creating account..." : "Sign Up"}
            </button>
          </form>

          <GoogleSignInButton />

          <p className="auth-footer">
            Already have an account?{" "}
            <Link to="/sign-in" className="auth-link">
              Sign in
            </Link>
          </p>
        </div>

        {/* Right overlay panel */}
        <div className="auth-overlay auth-overlay--right">
          <img src="/logo-icon.png" alt="Resumate" className="auth-overlay-logo" />
          <h2 className="auth-overlay-title">Welcome Back!</h2>
          <p className="auth-overlay-text">
            Already have an account? Sign in to access your dashboard and job matches.
          </p>
          <Link to="/sign-in" className="auth-overlay-btn">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
