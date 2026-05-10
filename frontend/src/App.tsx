import { NavLink, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">ApplyPilot</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" className="nav-item">
            <span className="nav-icon">💼</span>
            <span>Jobs</span>
          </NavLink>
          <NavLink to="/resume" className="nav-item">
            <span className="nav-icon">📄</span>
            <span>Resume</span>
          </NavLink>
          <NavLink to="/profile" className="nav-item">
            <span className="nav-icon">👤</span>
            <span>Profile</span>
          </NavLink>
          <NavLink to="/agent" className="nav-item">
            <span className="nav-icon">🤖</span>
            <span>Agent</span>
          </NavLink>
          <NavLink to="/applications" className="nav-item">
            <span className="nav-icon">📋</span>
            <span>Applied</span>
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <NavLink to="/settings" className="nav-item">
            <span className="nav-icon">⚙️</span>
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
