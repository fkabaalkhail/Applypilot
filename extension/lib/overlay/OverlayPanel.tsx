/**
 * OverlayPanel — floating overlay shown on job listing pages.
 * Displays match score and quick-action buttons.
 */

import { useEffect, useState } from "react"

interface MatchScoreData {
  overallScore: number
  label: string
  experienceScore: number
  skillScore: number
  industryScore: number
}

type PanelState = "idle" | "loading" | "filling" | "complete" | "error"

export function OverlayPanel() {
  const [matchScore, setMatchScore] = useState<MatchScoreData | null>(null)
  const [panelState, setPanelState] = useState<PanelState>("idle")
  const [minimized, setMinimized] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    // Request match score from background worker when panel mounts
    fetchMatchScore()

    // Listen for progress updates from the fill flow
    const listener = (message: { type: string; payload?: unknown }) => {
      if (message.type === "FILL_PROGRESS") {
        setPanelState("filling")
      } else if (message.type === "FILL_COMPLETE") {
        setPanelState("complete")
      } else if (message.type === "FILL_ERROR") {
        setPanelState("error")
        setErrorMessage((message.payload as { error?: string })?.error || "Fill failed")
      } else if (message.type === "MATCH_SCORE_RESULT") {
        setMatchScore(message.payload as MatchScoreData)
        setPanelState("idle")
      }
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const fetchMatchScore = () => {
    setPanelState("loading")
    const jobUrl = window.location.href
    chrome.runtime.sendMessage(
      { type: "GET_MATCH_SCORE", payload: { url: jobUrl } },
      (response) => {
        if (response?.success && response.data) {
          setMatchScore(response.data)
          setPanelState("idle")
        } else {
          setPanelState("idle")
        }
      }
    )
  }

  const handleApply = () => {
    setPanelState("filling")
    chrome.runtime.sendMessage(
      { type: "FILL_FORM", payload: { url: window.location.href } },
      (response) => {
        if (!response?.success) {
          setPanelState("error")
          setErrorMessage(response?.error || "Failed to start fill")
        }
      }
    )
  }

  if (minimized) {
    return (
      <div style={styles.minimizedContainer}>
        <button onClick={() => setMinimized(false)} style={styles.minimizedButton}>
          ⚡
        </button>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>⚡ ApplyPilot</span>
        <button onClick={() => setMinimized(true)} style={styles.minimizeBtn}>
          −
        </button>
      </div>

      {/* Match Score */}
      {panelState === "loading" && (
        <div style={styles.loadingSection}>
          <span style={styles.spinner}>⏳</span> Analyzing match...
        </div>
      )}

      {matchScore && (
        <div style={styles.scoreSection}>
          <div style={styles.scoreCircle}>
            <span style={styles.scoreValue}>{matchScore.overallScore}%</span>
          </div>
          <div style={styles.scoreDetails}>
            <span style={styles.scoreLabel}>{matchScore.label}</span>
            <div style={styles.breakdownRow}>
              <span>Experience: {matchScore.experienceScore}%</span>
            </div>
            <div style={styles.breakdownRow}>
              <span>Skills: {matchScore.skillScore}%</span>
            </div>
            <div style={styles.breakdownRow}>
              <span>Industry: {matchScore.industryScore}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Status Messages */}
      {panelState === "filling" && (
        <div style={styles.statusFilling}>Filling form...</div>
      )}
      {panelState === "complete" && (
        <div style={styles.statusComplete}>✓ Form filled successfully</div>
      )}
      {panelState === "error" && (
        <div style={styles.statusError}>{errorMessage}</div>
      )}

      {/* Action Buttons */}
      <div style={styles.actions}>
        <button
          onClick={handleApply}
          disabled={panelState === "filling"}
          style={{
            ...styles.applyButton,
            opacity: panelState === "filling" ? 0.6 : 1
          }}
        >
          {panelState === "filling" ? "Filling..." : "Apply"}
        </button>
        <button onClick={fetchMatchScore} style={styles.secondaryButton}>
          Refresh Score
        </button>
      </div>
    </div>
  )
}

/** Inline styles for the overlay (avoids CSS conflicts with host page) */
const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    top: "80px",
    right: "20px",
    width: "280px",
    background: "#1f2937",
    borderRadius: "12px",
    padding: "16px",
    boxShadow: "0 10px 40px rgba(0, 0, 0, 0.4)",
    zIndex: 2147483647,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#f9fafb",
    fontSize: "13px"
  },
  minimizedContainer: {
    position: "fixed",
    top: "80px",
    right: "20px",
    zIndex: 2147483647
  },
  minimizedButton: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    background: "#7c3aed",
    border: "none",
    color: "#fff",
    fontSize: "18px",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(124, 58, 237, 0.4)"
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "12px"
  },
  logo: {
    fontWeight: "700",
    fontSize: "14px",
    color: "#a78bfa"
  },
  minimizeBtn: {
    background: "none",
    border: "none",
    color: "#9ca3af",
    fontSize: "18px",
    cursor: "pointer",
    padding: "0 4px"
  },
  loadingSection: {
    textAlign: "center",
    padding: "12px 0",
    color: "#9ca3af"
  },
  spinner: {
    marginRight: "6px"
  },
  scoreSection: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px"
  },
  scoreCircle: {
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #7c3aed, #a78bfa)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0
  },
  scoreValue: {
    fontWeight: "700",
    fontSize: "15px",
    color: "#fff"
  },
  scoreDetails: {
    flex: 1
  },
  scoreLabel: {
    fontWeight: "600",
    fontSize: "12px",
    color: "#a78bfa",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px"
  },
  breakdownRow: {
    fontSize: "11px",
    color: "#9ca3af",
    marginTop: "2px"
  },
  statusFilling: {
    textAlign: "center",
    padding: "8px",
    background: "#374151",
    borderRadius: "6px",
    marginBottom: "12px",
    color: "#a78bfa"
  },
  statusComplete: {
    textAlign: "center",
    padding: "8px",
    background: "#064e3b",
    borderRadius: "6px",
    marginBottom: "12px",
    color: "#6ee7b7"
  },
  statusError: {
    textAlign: "center",
    padding: "8px",
    background: "#7f1d1d",
    borderRadius: "6px",
    marginBottom: "12px",
    color: "#fca5a5"
  },
  actions: {
    display: "flex",
    gap: "8px"
  },
  applyButton: {
    flex: 1,
    padding: "8px 12px",
    background: "#7c3aed",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontWeight: "600",
    fontSize: "13px",
    cursor: "pointer"
  },
  secondaryButton: {
    padding: "8px 12px",
    background: "#374151",
    color: "#d1d5db",
    border: "none",
    borderRadius: "6px",
    fontSize: "12px",
    cursor: "pointer"
  }
}

export default OverlayPanel
