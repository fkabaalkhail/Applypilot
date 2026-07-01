import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import api from "../auth/api";

type VerifyState = "pending" | "verifying" | "success" | "expired" | "error";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, resendVerification } = useAuth();

  const token = searchParams.get("token");

  const [state, setState] = useState<VerifyState>(token ? "verifying" : "pending");
  const [errorMessage, setErrorMessage] = useState("");
  const [resendSuccess, setResendSuccess] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isResending, setIsResending] = useState(false);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasVerified = useRef(false);

  // Start countdown timer
  const startCountdown = useCallback((seconds: number) => {
    setCountdown(seconds);
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }
    };
  }, []);

  // Verify token when present in URL
  useEffect(() => {
    if (!token || hasVerified.current) return;
    hasVerified.current = true;

    async function verifyToken() {
      try {
        const { data } = await api.post("/auth/verify-email", { token });
        // Store access token on success (refresh token is set as HttpOnly cookie)
        localStorage.setItem("access_token", data.access_token);
        setState("success");
        // Full page reload to refresh auth state with verified user
        setTimeout(() => {
          window.location.href = "/app";
        }, 1500);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "response" in err) {
          const axiosErr = err as { response?: { status?: number; data?: { detail?: string } } };
          const status = axiosErr.response?.status;
          if (status === 410) {
            setState("expired");
            setErrorMessage("Your verification link has expired. Please request a new one.");
          } else if (status === 400) {
            setState("error");
            setErrorMessage(
              axiosErr.response?.data?.detail || "This verification link is invalid. Please request a new one."
            );
          } else {
            setState("error");
            setErrorMessage("Something went wrong. Please try again.");
          }
        } else {
          setState("error");
          setErrorMessage("Network error. Please check your connection and try again.");
        }
      }
    }

    verifyToken();
  }, [token, navigate]);

  // Handle resend button click
  async function handleResend() {
    setIsResending(true);
    setResendSuccess(false);
    setErrorMessage("");

    try {
      await resendVerification();
      setResendSuccess(true);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { status?: number; data?: { detail?: string; retry_after?: number } } };
        const status = axiosErr.response?.status;
        if (status === 429) {
          const retryAfter = axiosErr.response?.data?.retry_after || 60;
          startCountdown(retryAfter);
        } else {
          setErrorMessage(axiosErr.response?.data?.detail || "Failed to resend email. Please try again.");
        }
      } else {
        setErrorMessage("Network error. Please check your connection and try again.");
      }
    } finally {
      setIsResending(false);
    }
  }

  const isResendDisabled = isResending || countdown > 0;

  // Verifying state — loading spinner
  if (state === "verifying") {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className="auth-brand">
            <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
          </div>
          <div className="auth-head">
            <h1 className="auth-title">Verifying your email</h1>
            <p className="auth-subtitle">Please wait while we verify your email address...</p>
          </div>
        </div>
      </div>
    );
  }

  // Success state
  if (state === "success") {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className="auth-brand">
            <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
          </div>
          <div className="auth-head">
            <h1 className="auth-title">Email verified!</h1>
            <p className="auth-subtitle">
              Your email has been verified successfully. Redirecting you to the app...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Expired state
  if (state === "expired") {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className="auth-brand">
            <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
          </div>
          <div className="auth-head">
            <h1 className="auth-title">Link expired</h1>
            <p className="auth-subtitle">{errorMessage}</p>
          </div>

          <div className="auth-form">
            {resendSuccess && (
              <div className="auth-success" role="status">
                Verification email sent! Check your inbox.
              </div>
            )}

            <button
              type="button"
              className="auth-submit"
              onClick={handleResend}
              disabled={isResendDisabled}
            >
              {countdown > 0
                ? `Resend available in ${countdown}s`
                : isResending
                  ? "Sending..."
                  : "Resend Email"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Error state (invalid token or network error)
  if (state === "error") {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <div className="auth-brand">
            <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
          </div>
          <div className="auth-head">
            <h1 className="auth-title">Verification failed</h1>
            <p className="auth-subtitle">{errorMessage}</p>
          </div>

          <div className="auth-form">
            {resendSuccess && (
              <div className="auth-success" role="status">
                Verification email sent! Check your inbox.
              </div>
            )}

            <button
              type="button"
              className="auth-submit"
              onClick={handleResend}
              disabled={isResendDisabled}
            >
              {countdown > 0
                ? `Resend available in ${countdown}s`
                : isResending
                  ? "Sending..."
                  : "Resend Email"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Pending state — default (no token in URL)
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo-icon.png" alt="Resumate" className="auth-brand-logo" />
        </div>
        <div className="auth-head">
          <h1 className="auth-title">Check your inbox</h1>
          <p className="auth-subtitle">
            We've sent a verification email to{" "}
            <strong>{user?.email || "your email address"}</strong>. Click the link in the email to
            verify your account.
          </p>
        </div>

        <div className="auth-form">
          {resendSuccess && (
            <div className="auth-success" role="status">
              Verification email sent! Check your inbox.
            </div>
          )}

          {errorMessage && (
            <div className="auth-error" role="alert">
              {errorMessage}
            </div>
          )}

          <p className="auth-subtitle" style={{ fontSize: "0.85rem", textAlign: "center" }}>
            Didn't receive the email? Check your spam folder or click below to resend.
          </p>

          <button
            type="button"
            className="auth-submit"
            onClick={handleResend}
            disabled={isResendDisabled}
          >
            {countdown > 0
              ? `Resend available in ${countdown}s`
              : isResending
                ? "Sending..."
                : "Resend Email"}
          </button>
        </div>
      </div>
    </div>
  );
}
