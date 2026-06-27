import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./auth/useAuth";
import { useState } from "react";
import {
  SquaresFour,
  FileText,
  ListChecks,
  UserCircle,
  ChatCircleDots,
  Gift,
  Question,
  GearSix,
  SignOut,
  CaretLeft,
  CaretRight,
  X,
  Check,
  Copy,
  LinkedinLogo,
  XLogo,
} from "@phosphor-icons/react";

export default function App() {
  const { user, logout } = useAuth();
  const [showReferModal, setShowReferModal] = useState(false);
  const [referCopied, setReferCopied] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const referralCode = user?.id?.toString().slice(-8) || "tailrd";
  const referralLink = `https://www.tailrd.ca?ref=${referralCode}`;

  const copyReferLink = () => {
    navigator.clipboard.writeText(referralLink);
    setReferCopied(true);
    setTimeout(() => setReferCopied(false), 2000);
  };

  return (
    <div className={`app-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <img src="/logo-icon.png" alt="Tailrd" className="sidebar-logo-img" />
          <span className="logo-text">Tailrd</span>
        </div>

        {/* Collapse Toggle */}
        <button
          className="sidebar-collapse-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <CaretRight size={16} weight="bold" />
          ) : (
            <CaretLeft size={16} weight="bold" />
          )}
        </button>

        {/* Menu Section */}
        <div className="sidebar-section">
          <span className="sidebar-section-label">MENU</span>
          <nav className="sidebar-nav">
            <NavLink to="/app" end className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <SquaresFour size={20} weight="duotone" />
              </span>
              <span className="nav-label">Dashboard</span>
            </NavLink>
            <NavLink to="/app/resume" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <FileText size={20} weight="duotone" />
              </span>
              <span className="nav-label">Resume</span>
            </NavLink>
            <NavLink to="/app/applications" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <ListChecks size={20} weight="duotone" />
              </span>
              <span className="nav-label">Applications</span>
            </NavLink>
            <NavLink to="/app/profile" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <UserCircle size={20} weight="duotone" />
              </span>
              <span className="nav-label">Profile</span>
            </NavLink>
            <NavLink to="/app/interview" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <ChatCircleDots size={20} weight="duotone" />
              </span>
              <span className="nav-label">Interview</span>
            </NavLink>
          </nav>
        </div>

        {/* General Section */}
        <div className="sidebar-section sidebar-section-bottom">
          <span className="sidebar-section-label">GENERAL</span>
          <nav className="sidebar-nav">
            <button className="nav-item" onClick={() => setShowReferModal(true)}>
              <span className="nav-icon">
                <Gift size={20} weight="duotone" />
              </span>
              <span className="nav-label">Refer & Earn</span>
            </button>
            <NavLink to="/app/feedback" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <Question size={20} weight="duotone" />
              </span>
              <span className="nav-label">Feedback</span>
            </NavLink>
            <NavLink to="/app/settings" className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">
                <GearSix size={20} weight="duotone" />
              </span>
              <span className="nav-label">Settings</span>
            </NavLink>
          </nav>
        </div>

        {/* User Profile at Bottom */}
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">
            {user?.profile_image_url ? (
              <img src={user.profile_image_url} alt="" className="sidebar-avatar-img" />
            ) : (
              <span className="sidebar-avatar-initials">
                {(user?.first_name?.[0] || user?.email?.[0] || "U").toUpperCase()}
              </span>
            )}
          </div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">{user?.first_name || "User"}</span>
            <span className="sidebar-user-email">{user?.email || ""}</span>
          </div>
          <button className="sidebar-logout-btn" onClick={logout} title="Sign out" aria-label="Sign out">
            <SignOut size={18} weight="bold" />
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>

      {/* Refer & Earn Modal */}
      {showReferModal && (
        <div className="modal-overlay" onClick={() => setShowReferModal(false)}>
          <div className="modal-content refer-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowReferModal(false)}>
              <X size={20} weight="bold" />
            </button>
            <div className="refer-modal-icon">
              <Gift size={32} weight="duotone" />
            </div>
            <h2>Invite Friends & Earn Credits</h2>
            <p>Share Tailrd with friends. When they sign up and upload their resume, you both earn +5 AI analysis credits.</p>

            <div className="refer-modal-steps">
              <div className="refer-modal-step">
                <span className="refer-step-num">1</span>
                <span>Share your link</span>
              </div>
              <div className="refer-modal-step">
                <span className="refer-step-num">2</span>
                <span>Friend signs up</span>
              </div>
              <div className="refer-modal-step">
                <span className="refer-step-num">3</span>
                <span>Both earn credits</span>
              </div>
            </div>

            <div className="refer-modal-link">
              <input type="text" readOnly value={referralLink} className="refer-link-input" />
              <button className="refer-copy-btn" onClick={copyReferLink}>
                {referCopied ? <><Check size={15} weight="bold" /> Copied</> : <><Copy size={15} weight="bold" /> Copy</>}
              </button>
            </div>

            <div className="refer-modal-share">
              <button className="refer-share-btn refer-share-linkedin" onClick={() => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(referralLink)}`, "_blank")}>
                <LinkedinLogo size={16} weight="fill" /> LinkedIn
              </button>
              <button className="refer-share-btn refer-share-twitter" onClick={() => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent("Check out Tailrd - AI-powered job search for interns and new grads!")}&url=${encodeURIComponent(referralLink)}`, "_blank")}>
                <XLogo size={16} weight="fill" /> Twitter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
