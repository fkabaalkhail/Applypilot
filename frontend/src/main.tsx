import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import Landing from "./pages/Landing";
import Jobs from "./pages/Jobs";
import JobsList from "./pages/JobsList";
import Resume from "./pages/Resume";
import ResumeDetail from "./pages/ResumeDetail";
import Profile from "./pages/Profile";
import Settings from "./pages/Settings";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/list" element={<JobsList />} />
        <Route path="/app" element={<App />}>
          <Route index element={<Jobs />} />
          <Route path="resume" element={<Resume />} />
          <Route path="resume/:id" element={<ResumeDetail />} />
          <Route path="profile" element={<Profile />} />
          <Route path="settings" element={<Settings />} />
          <Route path="applications" element={<div className="page-stub"><h1>📋 Applications</h1><p>Track your applied jobs. Coming soon.</p></div>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
