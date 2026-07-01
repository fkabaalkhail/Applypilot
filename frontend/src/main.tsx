import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { SetupRoute } from "./auth/SetupRoute";
import App from "./App";
import Landing from "./pages/Landing";
import Jobs from "./pages/Jobs";
import JobsList from "./pages/JobsList";
import Applications from "./pages/Applications";
import Resume from "./pages/Resume";
import ResumeDetail from "./pages/ResumeDetail";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";
import Feedback from "./pages/Feedback";
import Refer from "./pages/Refer";
import Interview from "./pages/Interview";
import SignInPage from "./pages/SignIn";
import SignUpPage from "./pages/SignUp";
import VerifyEmailPage from "./pages/VerifyEmail";
import DemoApply from "./pages/DemoApply";
import ExtensionConnect from "./pages/ExtensionConnect";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/sign-in/*" element={<SignInPage />} />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/extension/connect" element={<ExtensionConnect />} />
          <Route path="/list" element={<JobsList />} />
          <Route path="/demo-apply" element={<DemoApply />} />
          <Route path="/setup" element={<SetupRoute />} />
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
            <Route path="settings" element={<Settings />} />
            <Route path="refer" element={<Refer />} />
            <Route path="feedback" element={<Feedback />} />
            <Route path="interview" element={<Interview />} />
            <Route path="applications" element={<Applications />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
