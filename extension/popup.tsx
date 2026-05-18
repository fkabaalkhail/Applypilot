import { useEffect, useState } from "react"

import "./style.css"

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

  useEffect(() => {
    chrome.storage.local.get("userProfile", (data) => {
      if (data.userProfile) {
        setProfile(data.userProfile)
        const fields = Object.values(data.userProfile) as string[]
        const filled = fields.filter((f) => f && f.trim().length > 0).length
        setCompletion(Math.round((filled / fields.length) * 100))
      }
    })
  }, [])

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
          profile: {
            ...profile,
            full_name: `${profile.first_name} ${profile.last_name}`.trim()
          },
          sessionId: Date.now().toString()
        }
      })
      setResult(resp?.success ? "Fields filled!" : "No fields found on this page")
    } catch {
      setResult("Navigate to a job application page first")
    }
    setFilling(false)
  }

  if (view === "info") {
    return (
      <div style={{ width: 340, padding: 16, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setView("main")} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}>←</button>
          <strong>Your Autofill Info</strong>
        </div>
        {Object.entries(profile).map(([key, val]) => (
          <div key={key} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", display: "block", marginBottom: 2 }}>
              {key.replace(/_/g, " ")}
            </label>
            <input
              type="text"
              value={val}
              onChange={(e) => saveProfile({ ...profile, [key]: e.target.value })}
              style={{ width: "100%", padding: "6px 8px", border: "1.5px solid #e5e7eb", borderRadius: 6, fontSize: 13 }}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ width: 340, fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #f0f0f0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, overflow: "hidden" }}><img src={chrome.runtime.getURL("assets/icon.png")} style={{ width: "100%", height: "100%", objectFit: "contain" }} /></div>
          <strong style={{ fontSize: 15 }}>Tailrd</strong>
        </div>
        <button onClick={() => window.open("https://www.tailrd.ca/app", "_blank")} style={{ background: "none", border: "none", fontSize: 12, color: "#6366f1", cursor: "pointer", fontWeight: 500 }}>
          Open Dashboard →
        </button>
      </div>

      {/* Add Job */}
      <div style={{ padding: "16px 14px", textAlign: "center", background: "#fafafa" }}>
        <button style={{ padding: "8px 20px", background: "#1a1a2e", color: "#fff", border: "none", borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          + Add This Job In One Click
        </button>
        <p style={{ marginTop: 6, fontSize: 11, color: "#9ca3af" }}>See your match score and tailor your resume</p>
      </div>

      {/* Autofill */}
      <div style={{ padding: "12px 14px" }}>
        <button
          onClick={handleAutofill}
          disabled={filling}
          style={{ width: "100%", padding: 12, background: "#6366f1", color: "#fff", border: "none", borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: filling ? "wait" : "pointer", opacity: filling ? 0.7 : 1 }}
        >
          {filling ? "Filling..." : "Autofill"}
        </button>
        {result && (
          <p style={{ marginTop: 8, fontSize: 12, textAlign: "center", color: result.includes("filled") ? "#16a34a" : "#dc2626" }}>{result}</p>
        )}
      </div>

      {/* Generate Resume */}
      <div style={{ padding: "0 14px 12px" }}>
        <button
          onClick={async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            // Open Tailrd dashboard with the current job URL so it can tailor the resume
            const jobUrl = encodeURIComponent(tab?.url || "")
            window.open(`https://www.tailrd.ca/app/resume?tailor=${jobUrl}`, "_blank")
          }}
          style={{ width: "100%", padding: 10, background: "none", border: "2px solid #6366f1", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#6366f1", cursor: "pointer" }}
        >
          Generate A Resume For This Job
        </button>
      </div>

      {/* Menu */}
      <div style={{ borderTop: "1px solid #f0f0f0" }}>
        <button onClick={() => setView("info")} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Your Autofill Information</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {completion < 100 && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ef4444" }}></span>}
            <span style={{ color: "#9ca3af" }}>›</span>
          </span>
        </button>
        <button onClick={() => window.open("https://www.tailrd.ca/app/resume", "_blank")} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left", borderTop: "1px solid #f0f0f0" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Your Resume</span>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>Uses your primary resume for autofill</span>
          </div>
          <span style={{ color: "#9ca3af" }}>›</span>
        </button>
      </div>

      {/* Completion */}
      <div style={{ padding: "10px 14px", borderTop: "1px solid #f0f0f0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
          <span>Completion</span>
          <span style={{ fontWeight: 600, color: "#1a1a2e" }}>{completion}%</span>
        </div>
        <div style={{ height: 4, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${completion}%`, background: "#6366f1", borderRadius: 4 }}></div>
        </div>
      </div>
    </div>
  )
}

export default IndexPopup
