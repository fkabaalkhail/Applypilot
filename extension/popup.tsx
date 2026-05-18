import { useEffect, useState } from "react"
import "./style.css"

const API_BASE = "https://www.tailrd.ca"

interface UserProfile {
  first_name: string
  last_name: string
  email: string
  phone: string
  location: string
  linkedin_url: string
  github_url: string
  resume_name: string
}

type View = "main" | "autofill-info" | "settings"

function IndexPopup() {
  const [view, setView] = useState<View>("main")
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [filling, setFilling] = useState(false)
  const [fillResult, setFillResult] = useState<{ filled: number; failed: number } | null>(null)
  const [completion, setCompletion] = useState(0)

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    try {
      // Try to load from local storage first
      const stored = await chrome.storage.local.get("userProfile")
      if (stored.userProfile) {
        setProfile(stored.userProfile)
        calculateCompletion(stored.userProfile)
      }
    } catch {
      // No stored profile
    } finally {
      setLoading(false)
    }
  }

  function calculateCompletion(p: UserProfile) {
    const fields = [p.first_name, p.last_name, p.email, p.phone, p.location, p.linkedin_url, p.resume_name]
    const filled = fields.filter(f => f && f.trim().length > 0).length
    setCompletion(Math.round((filled / fields.length) * 100))
  }

  async function handleAutofill() {
    setFilling(true)
    setFillResult(null)

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error("No active tab")

      const profileData: Record<string, string> = {
        first_name: profile?.first_name || "",
        last_name: profile?.last_name || "",
        full_name: `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim(),
        email: profile?.email || "",
        phone: profile?.phone || "",
        location: profile?.location || "",
        linkedin: profile?.linkedin_url || "",
        github: profile?.github_url || "",
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "START_FILL",
        payload: { profile: profileData, sessionId: Date.now().toString() }
      })

      if (response?.success) {
        setFillResult({ filled: response.filledCount || 1, failed: response.failedCount || 0 })
      } else {
        setFillResult({ filled: 0, failed: 1 })
      }
    } catch (err) {
      setFillResult({ filled: 0, failed: 1 })
    } finally {
      setFilling(false)
    }
  }

  async function handleAddJob() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.url || !tab?.title) return

      // Save job to Tailrd dashboard
      await fetch(`${API_BASE}/jobs/save-external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: tab.url, title: tab.title })
      })
    } catch {
      // Silently fail
    }
  }

  async function saveProfile(updated: UserProfile) {
    setProfile(updated)
    calculateCompletion(updated)
    await chrome.storage.local.set({ userProfile: updated })
  }

  if (loading) {
    return (
      <div className="popup-container">
        <div className="popup-loading">Loading...</div>
      </div>
    )
  }

  // Autofill Info View
  if (view === "autofill-info") {
    return (
      <div className="popup-container">
        <div className="popup-header">
          <button className="back-btn" onClick={() => setView("main")}>←</button>
          <span className="header-title">Your Autofill Information</span>
        </div>
        <div className="info-form">
          <div className="form-field">
            <label>First Name</label>
            <input
              type="text"
              value={profile?.first_name || ""}
              onChange={e => saveProfile({ ...profile!, first_name: e.target.value })}
              placeholder="Fahad"
            />
          </div>
          <div className="form-field">
            <label>Last Name</label>
            <input
              type="text"
              value={profile?.last_name || ""}
              onChange={e => saveProfile({ ...profile!, last_name: e.target.value })}
              placeholder="Aba-Alkhail"
            />
          </div>
          <div className="form-field">
            <label>Email</label>
            <input
              type="email"
              value={profile?.email || ""}
              onChange={e => saveProfile({ ...profile!, email: e.target.value })}
              placeholder="fahadabraar@gmail.com"
            />
          </div>
          <div className="form-field">
            <label>Phone</label>
            <input
              type="tel"
              value={profile?.phone || ""}
              onChange={e => saveProfile({ ...profile!, phone: e.target.value })}
              placeholder="6133168025"
            />
          </div>
          <div className="form-field">
            <label>Location</label>
            <input
              type="text"
              value={profile?.location || ""}
              onChange={e => saveProfile({ ...profile!, location: e.target.value })}
              placeholder="Ottawa, Ontario, Canada"
            />
          </div>
          <div className="form-field">
            <label>LinkedIn URL</label>
            <input
              type="url"
              value={profile?.linkedin_url || ""}
              onChange={e => saveProfile({ ...profile!, linkedin_url: e.target.value })}
              placeholder="https://linkedin.com/in/..."
            />
          </div>
          <div className="form-field">
            <label>GitHub URL</label>
            <input
              type="url"
              value={profile?.github_url || ""}
              onChange={e => saveProfile({ ...profile!, github_url: e.target.value })}
              placeholder="https://github.com/..."
            />
          </div>
        </div>
      </div>
    )
  }

  // Main View
  return (
    <div className="popup-container">
      {/* Header */}
      <div className="popup-header-main">
        <div className="logo-section">
          <img src="https://www.tailrd.ca/logo-icon.png" alt="Tailrd" className="logo-img" />
          <span className="logo-text">Tailrd</span>
        </div>
        <div className="header-actions">
          <button className="icon-btn" title="Settings" onClick={() => window.open("https://www.tailrd.ca/app/settings", "_blank")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </div>

      {/* Add Job CTA */}
      <div className="add-job-section">
        <button className="add-job-btn" onClick={handleAddJob}>
          <span>+ Add This Job In One Click</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
        </button>
        <p className="add-job-subtitle">See your match score and tailor your resume</p>
      </div>

      {/* Autofill Button */}
      <button
        className={`autofill-btn ${filling ? "filling" : ""}`}
        onClick={handleAutofill}
        disabled={filling || !profile}
      >
        {filling ? "Filling..." : "Autofill"}
      </button>

      {/* Fill Result */}
      {fillResult && (
        <div className={`fill-result ${fillResult.filled > 0 ? "success" : "error"}`}>
          {fillResult.filled > 0
            ? `Filled ${fillResult.filled} field${fillResult.filled > 1 ? "s" : ""} successfully`
            : "No fields could be filled on this page"}
        </div>
      )}

      {/* Menu Items */}
      <div className="menu-items">
        <button className="menu-item" onClick={() => setView("autofill-info")}>
          <div className="menu-item-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>Your Autofill Information</span>
          </div>
          <div className="menu-item-right">
            {completion < 100 && <span className="incomplete-dot"></span>}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </button>

        <button className="menu-item" onClick={() => window.open("https://www.tailrd.ca/app/resume", "_blank")}>
          <div className="menu-item-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <div className="menu-item-text">
              <span>Upload Resume</span>
              {profile?.resume_name && <span className="menu-item-sub">{profile.resume_name}</span>}
            </div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      {/* Completion */}
      <div className="completion-section">
        <div className="completion-header">
          <span>Completion</span>
          <span className="completion-pct">{completion}%</span>
        </div>
        <div className="completion-bar">
          <div className="completion-fill" style={{ width: `${completion}%` }}></div>
        </div>
      </div>
    </div>
  )
}

export default IndexPopup
