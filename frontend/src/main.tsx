import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react";
import App from "./App";
import Landing from "./pages/Landing";
import Jobs from "./pages/Jobs";
import JobsList from "./pages/JobsList";
import Resume from "./pages/Resume";
import ResumeDetail from "./pages/ResumeDetail";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";
import Feedback from "./pages/Feedback";
import Refer from "./pages/Refer";
import Interview from "./pages/Interview";
import SignInPage from "./pages/SignIn";
import SignUpPage from "./pages/SignUp";
import "./index.css";

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "";

if (!CLERK_PUBLISHABLE_KEY) {
  console.error("Missing VITE_CLERK_PUBLISHABLE_KEY — auth will not work. Check your .env file.");
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/sign-in/*" element={<SignInPage />} />
          <Route path="/sign-up/*" element={<SignUpPage />} />
          <Route path="/list" element={<JobsList />} />
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
            <Route path="applications" element={<div className="page-stub"><h1>📋 Applications</h1><p>Track your applied jobs. Coming soon.</p></div>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ClerkProvider>
  </React.StrictMode>
);
