/**
 * Dashboard — rich job cards with company logos, match scores, requirements.
 * Styled like Simplify's job cards.
 */

import { useState, useEffect, useCallback } from "react";
import {
  fetchJobs, scrapeJobs, applyToJob, fetchQuestions,
  answerQuestion, resumeApply, fetchStats, fetch2FAQuestion,
  startAutopilot, stopAutopilot, fetchAutopilotStatus,
  fetchRecentApplications, fetchConnectionRequests,
  type ScrapedJob, type PendingQuestion, type Stats,
  type AutopilotStatus, type RecentApplication, type ConnectionRequest,
} from "../api";

function MatchBar({ score, met, total }: { score: number; met: number; total: number }) {
  if (score === 0 && total === 0) return null;
  const color = score >= 90 ? "#2a9d8f" : score >= 75 ? "#4361ee" : score >= 50 ? "#f4a261" : "#e63946";
  const label = score >= 90 ? "Great fit" : score >= 75 ? "Good fit" : score >= 50 ? "Fair" : "Low match";
  const bg = score >= 90 ? "#d4edda" : score >= 75 ? "#dbe4ff" : score >= 50 ? "#fff3cd" : "#f8d7da";
  const trackColor = score >= 90 ? "#b7e4c7" : score >= 75 ? "#c3d0f5" : score >= 50 ? "#ffe8a3" : "#f1aeb5";
  return (
    <div style={{ background: bg, borderRadius: "8px", padding: "0.5rem 0.75rem", marginTop: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ color, fontWeight: 600, fontSize: "0.85rem" }}>{label}</span>
          <span style={{ fontSize: "0.8rem", color: "#555" }}>{met}/{total} requirements fully met</span>
        </div>
        <span style={{ color, fontWeight: 700, fontSize: "0.9rem" }}>{score}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Match score: ${score}% — ${label}`}
        style={{ width: "100%", height: 6, borderRadius: 3, background: trackColor, overflow: "hidden" }}
      >
        <div style={{ width: `${score}%`, height: "100%", borderRadius: 3, background: color, transition: "width 0.3s ease" }} />
      </div>
    </div>
  );
}

function AutopilotPanel() {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [recent, setRecent] = useState<RecentApplication[]>([]);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await fetchAutopilotStatus()); } catch { /* */ }
    try { setRecent(await fetchRecentApplications()); } catch { /* */ }
  }, []);

  useEffect(() => {
    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, [load]);

  const handleToggle = async () => {
    if (!status) return;
    setToggling(true);
    try {
      if (status.running) {
        await stopAutopilot();
      } else {
        await startAutopilot();
      }
      setTimeout(load, 1000);
    } catch { /* */ }
    setToggling(false);
  };

  const running = status?.running ?? false;

  return (
    <div className="stat-card" style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "1rem" }}>🤖 Autopilot</h3>
          <span style={{ fontSize: "0.8rem", color: running ? "#155724" : "#666" }}>
            {running ? "Running — applying to matching jobs" : "Paused"}
          </span>
        </div>
        <button
          className={`btn ${running ? "btn-danger" : "btn-primary"}`}
          onClick={handleToggle}
          disabled={toggling}
          style={{ padding: "0.4rem 1rem", fontSize: "0.85rem" }}
        >
          {toggling ? "..." : running ? "Stop" : "Start"}
        </button>
      </div>

      {status && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
          <div style={{ textAlign: "center", padding: "0.5rem", background: "#f5f7fa", borderRadius: "8px" }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{status.applied_today}</div>
            <div style={{ fontSize: "0.75rem", color: "#666" }}>Today</div>
          </div>
          <div style={{ textAlign: "center", padding: "0.5rem", background: "#f5f7fa", borderRadius: "8px" }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{status.applied_this_week}</div>
            <div style={{ fontSize: "0.75rem", color: "#666" }}>This Week</div>
          </div>
          <div style={{ textAlign: "center", padding: "0.5rem", background: "#f5f7fa", borderRadius: "8px" }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{status.total_interviews}</div>
            <div style={{ fontSize: "0.75rem", color: "#666" }}>Interviews</div>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <div style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.5rem" }}>Recently Applied</div>
          <div style={{ display: "flex", gap: "0.5rem", overflowX: "auto", paddingBottom: "0.25rem" }}>
            {recent.map((app) => (
              <div key={app.id} style={{ minWidth: 140, background: "#f5f7fa", borderRadius: "8px", padding: "0.5rem 0.6rem", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.2rem" }}>
                  {app.company_logo ? (
                    <img src={app.company_logo.replace("https://media.licdn.com/", "/img-proxy/")} alt="" style={{ width: 16, height: 16, borderRadius: "3px" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  ) : (
                    <span style={{ width: 16, height: 16, borderRadius: "3px", background: "#ddd", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.6rem", color: "#999" }}>{app.company.charAt(0)}</span>
                  )}
                  <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.company}</span>
                </div>
                <div style={{ fontSize: "0.7rem", color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.title}</div>
                <div style={{ fontSize: "0.65rem", color: "#aaa", marginTop: "0.15rem" }}>{new Date(app.applied_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionRequestsList() {
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const load = async () => {
      try { setRequests(await fetchConnectionRequests()); } catch { /* */ }
    };
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, []);

  if (requests.length === 0) return null;

  return (
    <div className="stat-card" style={{ marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>🤝 Connection Requests ({requests.length})</h3>
        <span style={{ fontSize: "0.8rem", color: "#4361ee" }}>{expanded ? "Hide ▲" : "Show ▼"}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: "0.75rem" }}>
          {requests.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "0.6rem 0", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{r.contact_name}</div>
                <div style={{ fontSize: "0.8rem", color: "#555" }}>{r.contact_title} at {r.company}</div>
                {r.role_applied && <div style={{ fontSize: "0.75rem", color: "#888" }}>Re: {r.role_applied}</div>}
                {r.message_sent && <div style={{ fontSize: "0.75rem", color: "#aaa", marginTop: "0.2rem", fontStyle: "italic" }}>"{r.message_sent.slice(0, 80)}{r.message_sent.length > 80 ? "..." : ""}"</div>}
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: "0.5rem" }}>
                <span className={`badge badge-${r.status === "accepted" ? "applied" : r.status === "pending" ? "skipped" : "interviewing"}`}>{r.status}</span>
                <div style={{ fontSize: "0.7rem", color: "#aaa", marginTop: "0.2rem" }}>{new Date(r.sent_at).toLocaleDateString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onApply, onQuestions, applying }: {
  job: ScrapedJob; onApply: (id: number) => void;
  onQuestions: (id: number) => void; applying: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const details = job.requirements_detail || [];
  const hasDetails = job.match_summary || details.length > 0 || job.company_description || job.description;
  const logoUrl = job.company_logo?.replace("https://media.licdn.com/", "/img-proxy/") || "";
  const showLogo = logoUrl && !logoError;

  return (
    <div style={{ background: "#fff", borderRadius: "12px", padding: "1.25rem", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginBottom: "1rem" }}>
      {/* Header with logo */}
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
        {/* Company logo */}
        <div style={{ width: 48, height: 48, borderRadius: "8px", background: "#f0f0f0", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {showLogo ? (
            <img src={logoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setLogoError(true)} />
          ) : (
            <span style={{ fontSize: "1.2rem", color: "#999" }}>{job.company.charAt(0)}</span>
          )}
        </div>

        {/* Title + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: "1rem", color: "#4361ee", lineHeight: 1.3 }}>{job.title}</h3>
          <div style={{ fontSize: "0.85rem", color: "#555", marginTop: "0.15rem" }}>
            {job.company}
          </div>
          <div style={{ fontSize: "0.8rem", color: "#888", marginTop: "0.1rem" }}>
            {job.location}
            {job.salary_range && ` · ${job.salary_range}`}
            {job.ats_type && (
              <span style={{
                marginLeft: "0.5rem", padding: "0.1rem 0.4rem", borderRadius: "4px",
                fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase",
                background: job.ats_type === "easy_apply" ? "#d4edda" : job.ats_type === "greenhouse" ? "#d1ecf1" : job.ats_type === "lever" ? "#e2d9f3" : "#f0f0f0",
                color: job.ats_type === "easy_apply" ? "#155724" : job.ats_type === "greenhouse" ? "#0c5460" : job.ats_type === "lever" ? "#5a3d8a" : "#666",
              }}>
                {job.ats_type === "easy_apply" ? "Easy Apply" : job.ats_type}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
          {job.status === "new" && (
            <button
              className="btn btn-primary"
              style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem" }}
              onClick={() => onApply(job.id)}
              disabled={applying}
            >
              {applying ? "Applying..." : "⚡ Auto Apply"}
            </button>
          )}
          {job.status === "waiting_answer" && (
            <button className="btn" style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem", background: "#e76f51", color: "#fff" }} onClick={() => onQuestions(job.id)}>
              Answer Questions
            </button>
          )}
          {job.status === "applied" && (
            <span className="badge badge-applied" style={{ alignSelf: "center" }}>Applied ✓</span>
          )}
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn" style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem", background: "#f0f0f0", color: "#333", textDecoration: "none" }}>
            View →
          </a>
        </div>
      </div>

      {/* Match bar */}
      <MatchBar score={job.match_score} met={job.requirements_met} total={job.requirements_total} />

      {/* Expandable details */}
      {hasDetails && (
        <>
          <div style={{ marginTop: "0.6rem", cursor: "pointer", fontSize: "0.8rem", color: "#4361ee", userSelect: "none" }} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide details ▲" : "Show details ▼"}
          </div>

          {expanded && (
            <div style={{ marginTop: "0.75rem" }}>
              {/* Summary */}
              {job.match_summary && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.25rem" }}>Summary</div>
                  <p style={{ fontSize: "0.85rem", color: "#555", margin: 0, lineHeight: 1.5 }}>{job.match_summary}</p>
                </div>
              )}

              {/* Job Description */}
              {job.description && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.25rem" }}>Job Description</div>
                  <p style={{ fontSize: "0.8rem", color: "#666", margin: 0, lineHeight: 1.6, maxHeight: "200px", overflow: "auto" }}>{job.description}</p>
                </div>
              )}

              {/* Requirements */}
              {details.length > 0 && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>
                    Required · {job.requirements_met} fully met
                  </div>
                  {details.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "flex-start", fontSize: "0.8rem", marginBottom: "0.2rem" }}>
                      <span style={{ flexShrink: 0 }}>{r.met ? "✅" : "⚪"}</span>
                      <span style={{ color: r.met ? "#333" : "#999" }}>{r.requirement}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Company info */}
              {(job.company_description || job.company_size) && (
                <div style={{ padding: "0.75rem", background: "#f9f9f9", borderRadius: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                    {showLogo && <img src={logoUrl} alt="" style={{ width: 20, height: 20, borderRadius: "4px" }} />}
                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{job.company}</span>
                    {job.company_size && <span style={{ fontSize: "0.75rem", color: "#888" }}>· {job.company_size}</span>}
                  </div>
                  {job.company_description && (
                    <p style={{ fontSize: "0.8rem", color: "#666", margin: 0, lineHeight: 1.5 }}>{job.company_description}</p>
                  )}
                </div>
              )}

              <div style={{ fontSize: "0.75rem", color: "#aaa", marginTop: "0.5rem" }}>Summarized by AI</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<ScrapedJob[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scraping, setScraping] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [questionJobId, setQuestionJobId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [sortBy, setSortBy] = useState<"newest" | "best">("best");
  const [atsFilter, setAtsFilter] = useState("");
  const [tfaQuestion, setTfaQuestion] = useState<PendingQuestion | null>(null);
  const [tfaCode, setTfaCode] = useState("");

  const loadJobs = useCallback(async () => {
    try { setJobs(await fetchJobs()); } catch { /* */ }
  }, []);
  const loadStats = useCallback(async () => {
    try { setStats(await fetchStats()); } catch { /* */ }
  }, []);

  // Poll for 2FA verification code requests
  useEffect(() => {
    const check2FA = async () => {
      try {
        const qs = await fetch2FAQuestion();
        setTfaQuestion(qs.length > 0 ? qs[0] : null);
      } catch { /* */ }
    };
    check2FA();
    const i = setInterval(check2FA, 5000);
    return () => clearInterval(i);
  }, []);

  const handleSubmit2FA = async () => {
    if (!tfaQuestion || !tfaCode.trim()) return;
    await answerQuestion(tfaQuestion.id, tfaCode.trim());
    setTfaQuestion(null);
    setTfaCode("");
  };

  useEffect(() => {
    loadJobs(); loadStats();
    const i = setInterval(() => { loadJobs(); loadStats(); }, 15000);
    return () => clearInterval(i);
  }, [loadJobs, loadStats]);

  const filtered = atsFilter ? jobs.filter((j) => j.ats_type === atsFilter) : jobs;
  const atsTypes = [...new Set(jobs.map((j) => j.ats_type).filter(Boolean))].sort();
  const atsLabels: Record<string, string> = { easy_apply: "Easy Apply", greenhouse: "Greenhouse", lever: "Lever", workday: "Workday", external: "External" };
  const sorted = [...filtered].sort((a, b) =>
    sortBy === "best" ? b.match_score - a.match_score
      : new Date(b.scraped_at).getTime() - new Date(a.scraped_at).getTime()
  );

  const handleScrape = async () => {
    setScraping(true);
    try {
      await scrapeJobs();
      setTimeout(loadJobs, 5000);
      setTimeout(loadJobs, 15000);
      setTimeout(loadJobs, 30000);
      setTimeout(loadJobs, 60000);
    } catch { /* */ }
    setTimeout(() => setScraping(false), 60000);
  };

  const handleApply = async (jobId: number) => {
    setApplyingId(jobId);
    try {
      await applyToJob(jobId);
      const poll = setInterval(async () => {
        const updated = await fetchJobs();
        setJobs(updated);
        const job = updated.find((j) => j.id === jobId);
        if (job && ["applied", "waiting_answer", "failed", "skipped"].includes(job.status)) {
          clearInterval(poll);
          setApplyingId(null);
          if (job.status === "waiting_answer") openQuestions(jobId);
        }
      }, 3000);
      setTimeout(() => { clearInterval(poll); setApplyingId(null); }, 120000);
    } catch { setApplyingId(null); }
  };

  const openQuestions = async (jobId: number) => {
    setQuestionJobId(jobId);
    setQuestions(await fetchQuestions(jobId));
    setAnswers({});
  };

  const handleSubmitAnswers = async () => {
    if (!questionJobId) return;
    for (const q of questions) {
      if (answers[q.id]) await answerQuestion(q.id, answers[q.id]);
    }
    await resumeApply(questionJobId);
    setQuestionJobId(null);
    setQuestions([]);
    setTimeout(loadJobs, 5000);
  };

  return (
    <div style={{ paddingTop: "1.5rem" }}>
      {stats && (
        <div className="stats-row">
          <div className="stat-card"><h3>Total Applied</h3><div className="value">{stats.total}</div></div>
          <div className="stat-card"><h3>This Week</h3><div className="value">{stats.this_week}</div></div>
          <div className="stat-card"><h3>Jobs Found</h3><div className="value">{jobs.length}</div></div>
          <div className="stat-card"><h3>Needs Answers</h3><div className="value">{jobs.filter((j) => j.status === "waiting_answer").length}</div></div>
        </div>
      )}

      <AutopilotPanel />
      <ConnectionRequestsList />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn btn-primary" onClick={handleScrape} disabled={scraping}>
            {scraping ? "Searching..." : "🔍 Find Jobs"}
          </button>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <select value={atsFilter} onChange={(e) => setAtsFilter(e.target.value)} style={{ padding: "0.3rem 0.5rem", borderRadius: "6px", border: "1px solid #ddd" }}>
            <option value="">All Types</option>
            {atsTypes.map((t) => (
              <option key={t} value={t}>{atsLabels[t] || t}</option>
            ))}
          </select>
          <span style={{ fontSize: "0.85rem", color: "#666" }}>Sort:</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "newest" | "best")} style={{ padding: "0.3rem 0.5rem", borderRadius: "6px", border: "1px solid #ddd" }}>
            <option value="best">Best Match</option>
            <option value="newest">Newest</option>
          </select>
          <span style={{ fontSize: "0.85rem", color: "#888" }}>{filtered.length} jobs</span>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#999" }}>
          No jobs yet. Click "Find Jobs" to search LinkedIn.
        </div>
      ) : (
        sorted.map((job) => (
          <JobCard key={job.id} job={job} onApply={handleApply} onQuestions={openQuestions} applying={applyingId === job.id} />
        ))
      )}

      {/* Questions modal */}
      {questionJobId && questions.length > 0 && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setQuestionJobId(null)}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "2rem", maxWidth: "550px", width: "90%", maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: "0.5rem" }}>🤖 The bot needs your help</h3>
            <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: "1rem" }}>Answer these questions so the bot can continue the application.</p>
            {questions.map((q) => (
              <div key={q.id} style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontWeight: 600, marginBottom: "0.3rem", fontSize: "0.9rem" }}>{q.question}</label>
                {q.field_type === "select" || q.field_type === "radio" ? (
                  <select value={answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ddd" }}>
                    <option value="">Select...</option>
                    {q.options.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
                  </select>
                ) : (
                  <input type="text" value={answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} style={{ width: "100%", padding: "0.5rem", borderRadius: "6px", border: "1px solid #ddd" }} />
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn btn-primary" onClick={handleSubmitAnswers}>Submit & Resume</button>
              <button className="btn" style={{ background: "#e0e0e0" }} onClick={() => setQuestionJobId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* 2FA verification code modal */}
      {tfaQuestion && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "2rem", maxWidth: "420px", width: "90%", textAlign: "center" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🔐</div>
            <h3 style={{ marginBottom: "0.5rem" }}>LinkedIn Verification</h3>
            <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: "1.25rem" }}>
              LinkedIn sent a verification code to your email. Enter it below so the bot can continue.
            </p>
            <input
              type="text"
              value={tfaCode}
              onChange={(e) => setTfaCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit2FA()}
              placeholder="Enter code"
              autoFocus
              style={{ width: "100%", padding: "0.75rem", borderRadius: "8px", border: "1px solid #ddd", fontSize: "1.2rem", textAlign: "center", letterSpacing: "0.3rem", marginBottom: "1rem" }}
            />
            <button className="btn btn-primary" onClick={handleSubmit2FA} style={{ width: "100%", padding: "0.75rem" }}>
              Verify
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
