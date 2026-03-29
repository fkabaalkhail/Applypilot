/**
 * Bot Runner page — scrape jobs with live SSE log stream.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { scrapeJobs, approveSubmit, cancelSubmit } from "../api";

type BotStatus = "idle" | "running" | "done" | "error" | "waiting";

interface PauseReview {
  task_id: string;
  screenshot_url: string;
  job_title: string;
  company: string;
}

interface PendingInfo {
  job_id: number;
  count: number;
  job_title: string;
  company: string;
}

export default function Running() {
  const [status, setStatus] = useState<BotStatus>("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [pauseReview, setPauseReview] = useState<PauseReview | null>(null);
  const [pendingInfo, setPendingInfo] = useState<PendingInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<BotStatus>("idle");

  const updateStatus = useCallback((s: BotStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const handleScrape = async () => {
    setLogs([]);
    updateStatus("running");
    setPauseReview(null);
    setPendingInfo(null);
    try {
      const { task_id } = await scrapeJobs();
      setTaskId(task_id);
    } catch {
      updateStatus("error");
      setLogs((prev) => [...prev, "Failed to start scrape"]);
    }
  };

  // SSE log stream
  useEffect(() => {
    if (!taskId) return;

    const es = new EventSource(`/api/jobs/logs/${taskId}`);

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const msg: string = parsed.message;

        if (msg === "__DONE__") {
          updateStatus("done");
          setPauseReview(null);
          setPendingInfo(null);
          es.close();
          return;
        }
        if (msg === "__ERROR__") {
          updateStatus("error");
          setPauseReview(null);
          setPendingInfo(null);
          es.close();
          return;
        }
        if (msg === "__WAITING__") {
          updateStatus("waiting");
          if (parsed.pause_review) {
            setPendingInfo(null);
            setPauseReview({
              task_id: taskId,
              screenshot_url: parsed.pause_review.screenshot_url || "",
              job_title: parsed.pause_review.job_title || "",
              company: parsed.pause_review.company || "",
            });
          } else if (parsed.pending_questions) {
            setPauseReview(null);
            setPendingInfo({
              job_id: parsed.pending_questions.job_id,
              count: parsed.pending_questions.count,
              job_title: parsed.pending_questions.job_title || "",
              company: parsed.pending_questions.company || "",
            });
          }
          return;
        }

        // Regular log message — if we were waiting, the bot resumed
        if (statusRef.current === "waiting") {
          updateStatus("running");
          setPauseReview(null);
          setPendingInfo(null);
        }

        setLogs((prev) => [...prev, msg]);
      } catch {
        setLogs((prev) => [...prev, event.data]);
      }
    };

    es.onerror = () => {
      updateStatus("error");
      es.close();
    };

    return () => es.close();
  }, [taskId, updateStatus]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const handleApprove = async () => {
    if (!taskId) return;
    setSubmitting(true);
    try {
      await approveSubmit(taskId);
      setPauseReview(null);
      // Status will return to "running" when the bot resumes logging
    } catch { /* */ }
    setSubmitting(false);
  };

  const handleCancel = async () => {
    if (!taskId) return;
    setSubmitting(true);
    try {
      await cancelSubmit(taskId);
      setPauseReview(null);
      // Status will return to "running" when the bot resumes logging
    } catch { /* */ }
    setSubmitting(false);
  };

  return (
    <div style={{ paddingTop: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Bot Runner</h2>
        <span className={`badge badge-${status === "running" ? "interviewing" : status === "done" ? "applied" : status === "error" ? "failed" : status === "waiting" ? "skipped" : "skipped"}`}>
          {status}
        </span>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <button className="btn btn-primary" onClick={handleScrape} disabled={status === "running"}>
          {status === "running" ? "Scraping..." : "🔍 Scrape Jobs"}
        </button>
      </div>

      {/* Pause-before-submit review panel */}
      {pauseReview && (
        <div style={{ background: "#fff", borderRadius: "12px", padding: "1.25rem", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", marginBottom: "1rem", border: "2px solid #f4a261" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "1.2rem" }}>⏸️</span>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>Review & Submit</h3>
          </div>
          {(pauseReview.job_title || pauseReview.company) && (
            <p style={{ fontSize: "0.9rem", color: "#333", marginBottom: "0.75rem" }}>
              {pauseReview.job_title}{pauseReview.company ? ` at ${pauseReview.company}` : ""}
            </p>
          )}
          {pauseReview.screenshot_url && (
            <div style={{ marginBottom: "0.75rem", borderRadius: "8px", overflow: "hidden", border: "1px solid #eee" }}>
              <img
                src={pauseReview.screenshot_url}
                alt="Pre-submit screenshot"
                style={{ width: "100%", display: "block" }}
              />
            </div>
          )}
          <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: "0.75rem" }}>
            The bot has filled out the application and is waiting for your approval before submitting.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary" onClick={handleApprove} disabled={submitting}>
              {submitting ? "..." : "✅ Approve & Submit"}
            </button>
            <button className="btn btn-danger" onClick={handleCancel} disabled={submitting}>
              {submitting ? "..." : "❌ Cancel & Discard"}
            </button>
          </div>
        </div>
      )}

      {/* Pending questions waiting panel */}
      {pendingInfo && (
        <div style={{ background: "#fff", borderRadius: "12px", padding: "1.25rem", boxShadow: "0 2px 8px rgba(0,0,0,0.12)", marginBottom: "1rem", border: "2px solid #457b9d" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "1.2rem" }}>❓</span>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>Waiting for Answers</h3>
          </div>
          {(pendingInfo.job_title || pendingInfo.company) && (
            <p style={{ fontSize: "0.9rem", color: "#333", marginBottom: "0.5rem" }}>
              {pendingInfo.job_title}{pendingInfo.company ? ` at ${pendingInfo.company}` : ""}
            </p>
          )}
          <p style={{ fontSize: "0.85rem", color: "#666" }}>
            The bot encountered {pendingInfo.count} question{pendingInfo.count > 1 ? "s" : ""} it couldn't answer automatically.
            Please answer them on the Dashboard to continue.
          </p>
        </div>
      )}

      <div className="log-stream" ref={logRef} role="log" aria-live="polite">
        {logs.length === 0 ? (
          <span style={{ opacity: 0.5 }}>Waiting for logs...</span>
        ) : (
          logs.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}
