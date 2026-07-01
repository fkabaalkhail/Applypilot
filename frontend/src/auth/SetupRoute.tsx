import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { SetupWizard } from "../setup";

export function SetupRoute() {
  const { isAuthenticated, isLoading, isEmailVerified, user } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/sign-in" replace />;
  if (!isEmailVerified) return <Navigate to="/verify-email" replace />;
  if (user?.has_completed_setup) return <Navigate to="/app" replace />;
  return <SetupWizard />;
}
