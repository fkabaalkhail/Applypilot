import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { SetupRoute } from "./auth/SetupRoute";
import App from "./App";
import Landing from "./pages/Landing";
import About from "./pages/About";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Cookies from "./pages/Cookies";
import Support from "./pages/Support";
import Pricing from "./pages/Pricing";
import Jobs from "./pages/Jobs";
import JobsList from "./pages/JobsList";
import Applications from "./pages/Applications";
import Resume from "./pages/Resume";
import ResumeDetail from "./pages/ResumeDetail";
import Profile from "./pages/Profile";
import Feedback from "./pages/Feedback";
import Refer from "./pages/Refer";
import Interview from "./pages/Interview";
import SignInPage from "./pages/SignIn";
import SignUpPage from "./pages/SignUp";
import VerifyEmailPage from "./pages/VerifyEmail";
import DemoApply from "./pages/DemoApply";
import ExtensionConnect from "./pages/ExtensionConnect";
import CustomResumeEmbed from "./pages/embed/CustomResumeEmbed";
import CoverLetterEmbed from "./pages/embed/CoverLetterEmbed";
import LinkedInComplete from "./pages/LinkedInComplete";
import "./index.css";

// Internal feedback console. Lazy so the admin bundle is never downloaded by
// the users whose feedback it reads. The route is unlisted, but the real gate
// is server-side: /feedback rejects anyone without users.is_admin.
const AdminFeedback = React.lazy(() => import("./pages/AdminFeedback"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/cookies" element={<Cookies />} />
          <Route path="/support" element={<Support />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/sign-in/*" element={<SignInPage />} />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/linkedin/complete" element={<LinkedInComplete />} />
          <Route path="/extension/connect" element={<ExtensionConnect />} />
          <Route path="/embed/custom-resume" element={<CustomResumeEmbed />} />
          <Route path="/embed/cover-letter" element={<CoverLetterEmbed />} />
          <Route path="/list" element={<JobsList />} />
          <Route path="/demo-apply" element={<DemoApply />} />
          <Route path="/setup" element={<SetupRoute />} />
          <Route
            path="/admin"
            element={
              <React.Suspense fallback={null}>
                <AdminFeedback />
              </React.Suspense>
            }
          />
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          >
            <Route index element={<Jobs />} />
            <Route path="resume" element={<Resume />} />
            <Route path="resume/:id" element={<ResumeDetail />} />
            <Route path="profile" element={<Profile />} />
            <Route path="refer" element={<Refer />} />
            <Route path="feedback" element={<Feedback />} />
            <Route path="interview" element={<Interview />} />
            <Route path="applications" element={<Applications />} />
            {/* /app/settings shipped, then became the SettingsModal. There is no
                catch-all 404, so without this the URL matches nothing and the
                router renders a blank page at a bookmark that used to work. */}
            <Route path="settings" element={<Navigate to="/app" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
