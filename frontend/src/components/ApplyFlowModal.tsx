import { useState } from "react";

const API_BASE = "";

interface Job {
  id: number;
  title: string;
  company: string;
  url: string;
  match_score: number;
  match_label: string;
}

interface Props {
  job: Job;
  hasTailoredResume: boolean;
  hasCoverLetter: boolean;
  onClose: () => void;
  onComplete: () => void;
}

type FlowStatus = "checklist" | "applying" | "complete" | "error";

interface ProgressUpdate {
  step: string;
  percentage: number;
  message: string;
}

export default function ApplyFlowModal({ job, hasTailoredResume, hasCoverLetter, onClose, onComplete }: Props) {
  const [status, setStatus] = useState<FlowStatus>("checklist");
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setStatus("applying");
    setError("");

    try {
      const res = await fetch(`${API_BASE}/apply/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });

      if (!res.ok) {
        setStatus("error");
        setError("Failed to initiate apply flow.");
        return;
      }

      const session = await res.json();

      // Open job URL in new tab
      window.open(job.url, "_blank");

      // Listen for progress updates from extension
      if (typeof (window as any).chrome !== "undefined" && (window as any).chrome.runtime) {
        (window as any).chrome.runtime.onMessage.addListener((message: ProgressUpdate) => {
          if (message.step === "complete") {
            setStatus("complete");
            onComplete();
          } else {
            setProgress(message);
          }
        });
      }

      // Poll for progress updates as fallback
      pollProgress(session.session_id);
    } catch {
      setStatus("error");
      setError("Failed to connect to the server.");
    }
  }

  async function pollProgress(sessionId: string) {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`${API_BASE}/apply/${sessionId}/progress`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === "complete") {
            setStatus("complete");
            onComplete();
            return;
          }
          setProgress(data);
        }
      } catch {
        // Continue polling
      }
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content apply-flow-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Apply to {job.company}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {status === "checklist" && (
          <div className="apply-checklist">
            <h3>{job.title}</h3>
            <ul className="checklist-items">
              <li className={`checklist-item ${hasTailoredResume ? "ready" : "pending"}`}>
                <span className="checklist-icon">{hasTailoredResume ? "✅" : "⚠️"}</span>
                <span>Resume: {hasTailoredResume ? "Tailored version ready" : "Using original resume"}</span>
              </li>
              <li className={`checklist-item ${hasCoverLetter ? "ready" : "pending"}`}>
                <span className="checklist-icon">{hasCoverLetter ? "✅" : "⚠️"}</span>
                <span>Cover Letter: {hasCoverLetter ? "Ready" : "Not generated"}</span>
              </li>
              <li className="checklist-item ready">
                <span className="checklist-icon">✅</span>
                <span>Match Score: {job.match_score}% ({job.match_label || "FAIR MATCH"})</span>
              </li>
            </ul>
            <div className="apply-actions">
              <button className="btn-primary" onClick={handleConfirm}>
                Confirm & Apply
              </button>
              <button className="btn-outline" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {status === "applying" && (
          <div className="apply-progress">
            <div className="spinner" />
            <p className="progress-message">
              {progress ? progress.message : "Opening application page..."}
            </p>
            {progress && (
              <div className="progress-bar-container">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
            )}
          </div>
        )}

        {status === "complete" && (
          <div className="apply-complete">
            <span className="complete-icon">🎉</span>
            <h3>Application Submitted!</h3>
            <p>Your application to {job.company} has been submitted successfully.</p>
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="apply-error">
            <span className="error-icon">❌</span>
            <p>{error}</p>
            <div className="apply-actions">
              <button className="btn-primary" onClick={handleConfirm}>
                Retry
              </button>
              <button className="btn-outline" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
