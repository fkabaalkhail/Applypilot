import { NavLink, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <img src="/logo-icon.png" alt="Resumate" className="sidebar-logo-img" />
          <span className="logo-text">Resumate</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/app" end className="nav-item">
            <span className="nav-icon">💼</span>
            <span>Jobs</span>
          </NavLink>
          <NavLink to="/app/resume" className="nav-item">
            <span className="nav-icon">📄</span>
            <span>Resume</span>
          </NavLink>
          <NavLink to="/app/profile" className="nav-item">
            <span className="nav-icon">👤</span>
            <span>Profile</span>
          </NavLink>
          <NavLink to="/app/applications" className="nav-item">
            <span className="nav-icon">📋</span>
            <span>Applied</span>
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <NavLink to="/app/settings" className="nav-item">
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
