import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./useAuth";
import { safeNextPath } from "./nextRedirect";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: string;
              size?: string;
              width?: number;
              text?: string;
              shape?: string;
            }
          ) => void;
        };
      };
    };
  }
}

export function GoogleSignInButton() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { loginWithGoogle } = useAuth();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

  useEffect(() => {
    if (!clientId || !buttonRef.current) return;

    const initializeGoogle = () => {
      if (!window.google) return;

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          setError("");
          try {
            await loginWithGoogle(response.credential);
            navigate(safeNextPath(searchParams.get("next")));
          } catch (err: unknown) {
            if (err && typeof err === "object" && "response" in err) {
              const axiosErr = err as { response?: { data?: { detail?: string } } };
              setError(axiosErr.response?.data?.detail || "Google sign-in failed.");
            } else {
              setError("Google sign-in failed. Please try again.");
            }
          }
        },
      });

      window.google.accounts.id.renderButton(buttonRef.current!, {
        theme: "outline",
        size: "large",
        width: 320,
        text: "continue_with",
        shape: "pill",
      });
    };

    // Google script might not be loaded yet
    if (window.google) {
      initializeGoogle();
    } else {
      const interval = setInterval(() => {
        if (window.google) {
          clearInterval(interval);
          initializeGoogle();
        }
      }, 100);
      // Clean up after 5 seconds if Google never loads
      const timeout = setTimeout(() => clearInterval(interval), 5000);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
    }
  }, [clientId, loginWithGoogle, navigate, searchParams]);

  if (!clientId) return null;

  return (
    <div className="google-signin-wrapper">
      <div className="auth-divider">
        <span className="auth-divider-text">or</span>
      </div>
      <div ref={buttonRef} className="google-signin-button" />
      {error && (
        <div className="auth-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
