import { useState, FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Envelope, Lock, Eye, EyeSlash } from "@phosphor-icons/react";
import { useAuth } from "../auth/useAuth";
import { GoogleSignInButton } from "../auth/GoogleSignInButton";

export default function SignUpPage() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
        </div>

        <div className="auth-head">
          <h1 className="auth-title">Create your account</h1>
          <p className="auth-subtitle">Start matching with your dream jobs today.</p>
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
            <div className="auth-input-wrap">
              <Envelope className="auth-input-icon" size={18} weight="regular" />
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
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              Password
            </label>
            <div className="auth-input-wrap">
              <Lock className="auth-input-icon" size={18} weight="regular" />
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="auth-input"
                placeholder="At least 8 characters"
                required
                minLength={8}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="auth-input-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? <EyeSlash size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="confirm-password" className="auth-label">
              Confirm password
            </label>
            <div className="auth-input-wrap">
              <Lock className="auth-input-icon" size={18} weight="regular" />
              <input
                id="confirm-password"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="auth-input"
                placeholder="Re-enter your password"
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
          </div>

          <button
            type="submit"
            className="auth-submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating account..." : "Create account"}
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
    </div>
  );
}
