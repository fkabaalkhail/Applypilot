import { useEffect, useState } from "react"

import "./style.css"

interface JobInfo {
  title: string
  company: string
  logo: string
  matchScore: number
  postedAgo: string
  applicants: string
  url: string
}

function IndexPopup() {
  const [view, setView] = useState<"main" | "info">("main")
  const [profile, setProfile] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    location: "",
    linkedin_url: "",
    github_url: ""
  })
  const [filling, setFilling] = useState(false)
  const [result, setResult] = useState("")
  const [completion, setCompletion] = useState(0)
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null)
  const [logoLoaded, setLogoLoaded] = useState(false)

  useEffect(() => {
    // Load profile
    chrome.storage.local.get("userProfile", (data) => {
      if (data.userProfile) {
        setProfile(data.userProfile)
        const fields = Object.values(data.userProfile) as string[]
        const filled = fields.filter((f) => f && f.trim().length > 0).length
        setCompletion(Math.round((filled / fields.length) * 100))
      }
    })

    // Detect current job from page
    detectCurrentJob()
  }, [])

  async function detectCurrentJob() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.url) return

      const url = tab.url
      let company = ""
      let title = tab.title || ""

      // Extract company from URL patterns
      if (url.includes("greenhouse.io")) {
        const match = url.match(/boards\.greenhouse\.io\/([^/]+)/)
        if (match) company = match[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      } else if (url.includes("lever.co")) {
        const match = url.match(/jobs\.lever\.co\/([^/]+)/)
        if (match) company = match[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      } else if (url.includes("linkedin.com/jobs")) {
        // Try to get from page title: "Title at Company | LinkedIn"
        const titleMatch = title.match(/(.+?)\s+at\s+(.+?)\s*[\|–]/)
        if (titleMatch) {
          title = titleMatch[1]
          company = titleMatch[2]
        }
      } else if (url.includes("myworkdayjobs.com")) {
        const match = url.match(/([^.]+)\.myworkdayjobs\.com/)
        if (match) company = match[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      } else if (url.includes("ashbyhq.com")) {
        const match = url.match(/jobs\.ashbyhq\.com\/([^/]+)/)
        if (match) company = match[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      }

      // Clean up title (remove " | Company" suffixes)
      title = title.replace(/\s*[\|–\-]\s*(LinkedIn|Greenhouse|Lever|Workday).*$/i, "").trim()
      if (title.length > 60) title = title.slice(0, 57) + "..."

      if (company || title) {
        const cleaned = company.toLowerCase().replace(/[^a-z0-9]/g, "")
        setJobInfo({
          title: title || "Job Application",
          company: company || "Company",
          logo: cleaned.length >= 2 ? `https://logos-api.apistemic.com/domain:${cleaned}.com?fallback=404` : "",
          matchScore: 0,
          postedAgo: "",
          applicants: "",
          url: url
        })
      }
    } catch {
      // Can't detect job — that's fine
    }
  }

  function saveProfile(updated: typeof profile) {
    setProfile(updated)
    chrome.storage.local.set({ userProfile: updated })
    const fields = Object.values(updated) as string[]
    const filled = fields.filter((f) => f && f.trim().length > 0).length
    setCompletion(Math.round((filled / fields.length) * 100))
  }

  async function handleAutofill() {
    setFilling(true)
    setResult("")
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) throw new Error("No tab")
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "START_FILL",
        payload: {
          profile: { ...profile, full_name: `${profile.first_name} ${profile.last_name}`.trim() },
          sessionId: Date.now().toString()
        }
      })
      setResult(resp?.success ? "Fields filled!" : "No fields found on this page")
    } catch {
      setResult("Navigate to a job application page first")
    }
    setFilling(false)
  }

  // Autofill Info View
  if (view === "info") {
    return (
      <div className="popup-container">
        <div className="popup-nav">
          <button className="nav-back" onClick={() => setView("main")}>←</button>
          <span className="nav-title">Your Autofill Info</span>
        </div>
        <div className="info-form">
          {Object.entries(profile).map(([key, val]) => (
            <div key={key} className="field">
              <label>{key.replace(/_/g, " ")}</label>
              <input
                type="text"
                value={val}
                onChange={(e) => saveProfile({ ...profile, [key]: e.target.value })}
                placeholder={key === "email" ? "you@email.com" : ""}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Main View
  return (
    <div className="popup-container">
      {/* Header */}
      <div className="popup-header">
        <div className="header-logo">
          <img src={chrome.runtime.getURL("assets/icon.png")} alt="" className="logo-icon" />
          <span className="logo-name">Tailrd</span>
        </div>
        <div className="header-right">
          <button className="header-btn" onClick={() => window.open("https://www.tailrd.ca/app", "_blank")}>
            Dashboard
          </button>
        </div>
      </div>

      {/* Job Card */}
      {jobInfo && (
        <div className="job-card">
          <div className="job-card-top">
            <div className="job-card-logo-wrap">
              {jobInfo.logo && (
                <img
                  src={jobInfo.logo}
                  alt=""
                  className="job-card-logo"
                  onLoad={() => setLogoLoaded(true)}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none"
                    setLogoLoaded(false)
                  }}
                />
              )}
              {!logoLoaded && (
                <div className="job-card-logo-fallback">{jobInfo.company.charAt(0)}</div>
              )}
            </div>
            <div className="job-card-company-info">
              <span className="job-card-company">{jobInfo.company}</span>
            </div>
            {jobInfo.matchScore > 0 && (
              <div className="job-card-match">{jobInfo.matchScore}%</div>
            )}
          </div>
          <h3 className="job-card-title">{jobInfo.title}</h3>
          {(jobInfo.postedAgo || jobInfo.applicants) && (
            <p className="job-card-meta">{[jobInfo.postedAgo, jobInfo.applicants].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      )}

      {/* Autofill Button */}
      <button className="autofill-btn" onClick={handleAutofill} disabled={filling}>
        {filling ? "Filling..." : "Autofill"}
      </button>
      {result && <p className={`fill-result ${result.includes("filled") ? "success" : "error"}`}>{result}</p>}

      {/* Menu Items */}
      <div className="menu-section">
        <button className="menu-item" onClick={() => setView("info")}>
          <div className="menu-item-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>Your Autofill Information</span>
          </div>
          <div className="menu-item-right">
            {completion < 100 && <span className="dot-red"></span>}
            <span className="chevron">›</span>
          </div>
        </button>

        <button className="menu-item" onClick={() => window.open("https://www.tailrd.ca/app/resume", "_blank")}>
          <div className="menu-item-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>Upload Resume</span>
          </div>
          <span className="chevron">›</span>
        </button>

        {/* Generate Custom Resume */}
        <div className="generate-section">
          <button
            className="generate-btn"
            onClick={async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              const jobUrl = encodeURIComponent(tab?.url || "")
              window.open(`https://www.tailrd.ca/app?generate=${jobUrl}`, "_blank")
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
            Generate Custom Resume
          </button>
        </div>
      </div>

      {/* Completion */}
      <div className="completion">
        <div className="completion-row">
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
