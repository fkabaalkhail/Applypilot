import { NavLink, Outlet } from "react-router-dom";
import { UserButton, useUser } from "@clerk/clerk-react";

export default function App() {
  const { user } = useUser();

  return (
    <div className="app-layout">
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <img src="/logo-icon.png" alt="Tailrd" className="sidebar-logo-img" />
          <span className="logo-text">Tailrd</span>
        </div>

        {/* Menu Section */}
        <div className="sidebar-section">
          <span className="sidebar-section-label">MENU</span>
          <nav className="sidebar-nav">
            <NavLink to="/app" end className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                  <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                  <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                </svg>
              </span>
              <span className="nav-label">Dashboard</span>
            </NavLink>
            <NavLink to="/app/resume" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </span>
              <span className="nav-label">Resume</span>
            </NavLink>
            <NavLink to="/app/applications" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                  <path d="M9 14l2 2 4-4"/>
                </svg>
              </span>
              <span className="nav-label">Applications</span>
            </NavLink>
            <NavLink to="/app/profile" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
              </span>
              <span className="nav-label">Profile</span>
            </NavLink>
          </nav>
        </div>

        {/* General Section */}
        <div className="sidebar-section sidebar-section-bottom">
          <span className="sidebar-section-label">GENERAL</span>
          <nav className="sidebar-nav">
            <NavLink to="/app/settings" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </span>
              <span className="nav-label">Settings</span>
            </NavLink>
          </nav>
        </div>

        {/* User Profile at Bottom */}
        <div className="sidebar-user">
          <UserButton afterSignOutUrl="/" />
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">{user?.firstName || "User"}</span>
            <span className="sidebar-user-email">{user?.primaryEmailAddress?.emailAddress || ""}</span>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
