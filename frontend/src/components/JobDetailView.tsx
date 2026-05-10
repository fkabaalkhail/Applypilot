import { useState, useEffect } from "react";

const API_BASE = "";

interface MatchBreakdown {
  experience_score: number;
  skill_score: number;
  industry_score: number;
  overall_score: number;
  match_label: string;
}

interface Job {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  match_score: number;
  match_label: string;
  experience_score: number;
  skill_score: number;
  industry_score: number;
  applicant_count: number | null;
  source_platform: string;
  scraped_at: string;
  salary_range: string;
  status: string;
  company_logo?: string;
  work_type?: string;
  role_category?: string;
  country?: string;
  experience_level?: string;
  posted_date?: string | null;
}

function getMatchColor(score: number): string {
  if (score >= 80) return "var(--accent)";
  if (score >= 60) return "var(--accent-muted)";
  return "var(--text-muted)";
}

function getMatchLabel(score: number): string {
  if (score >= 80) return "STRONG MATCH";
  if (score >= 60) return "GOOD MATCH";
  return "FAIR MATCH";
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatWorkType(wt: string): string {
  if (wt === "remote") return "Remote";
  if (wt === "hybrid") return "Hybrid";
  if (wt === "onsite") return "On Site";
  return wt;
}

function formatCountry(c: string): string {
  if (c === "US") return "USA";
  if (c === "CA") return "Canada";
  return c;
}

function formatExperienceLevel(level: string): string {
  if (level === "new_grad") return "New Grad";
  if (level === "internship") return "Internship";
  return level;
}

interface Props {
  job: Job;
  onClose?: () => void;
}

export default function JobDetailView({ job, onClose }: Props) {
  const [breakdown, setBreakdown] = useState<MatchBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (job.match_score > 0 && job.experience_score > 0) {
      setBreakdown({
        experience_score: job.experience_score,
        skill_score: job.skill_score,
        industry_score: job.industry_score,
        overall_score: job.match_score,
        match_label: job.match_label || getMatchLabel(job.match_score),
      });
    } else if (job.match_score === 0) {
      triggerAnalysis();
    }
  }, [job.id]);

  async function triggerAnalysis() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/ai/match-breakdown/${job.id}`, { method: "POST" });
      if (!res.ok) {
        if (res.status === 503) {
          setError("AI analysis unavailable. Connect Gemini or Ollama to enable match scoring.");
        } else {
          setError("Failed to analyze job match.");
        }
        return;
      }
      const data: MatchBreakdown = await res.json();
      setBreakdown(data);
    } catch {
      setError("Failed to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  const score = breakdown?.overall_score ?? job.match_score;
  const label = breakdown?.match_label ?? getMatchLabel(score);
  const color = getMatchColor(score);

  return (
    <div className="job-detail-view">
      {/* Top bar with close and actions */}
      <div className="job-detail-topbar">
        {onClose && (
          <button className="btn-close-detail" onClick={onClose} aria-label="Close detail view">
            <i className="fa-solid fa-xmark"></i>
          </button>
        )}
        <div className="job-detail-topbar-meta">
          {job.role_category && <span className="tag tag-category">{job.role_category}</span>}
          {job.applicant_count != null && job.applicant_count > 0 && (
            <span className="tag tag-applicants">{job.applicant_count}+ applicants</span>
          )}
        </div>
        <div className="job-detail-topbar-actions">
          <button className="btn-icon" title="Share"><i className="fa-solid fa-share-nodes"></i></button>
          <button className="btn-icon" title="Report"><i className="fa-solid fa-flag"></i></button>
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-apply-detail">
            APPLY WITH AUTOFILL <i className="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        </div>
      </div>

      <div className="job-detail-content">
        {/* Left: Overview */}
        <div className="job-detail-main">
          {/* Company header */}
          <div className="job-detail-company-row">
            {job.company_logo ? (
              <img src={job.company_logo} alt={`${job.company} logo`} className="detail-company-logo" />
            ) : (
              <div className="detail-company-logo-placeholder" aria-label={`${job.company} logo`}>
                {job.company.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="detail-company-info">
              <span className="job-detail-company">{job.company}</span>
              <span className="job-detail-posted">{timeAgo(job.scraped_at)}</span>
            </div>
          </div>

          <h1 className="job-detail-title">{job.title}</h1>

          {/* Tags row */}
          <div className="job-detail-tags">
            {job.location && (
              <span className="tag"><i className="fa-solid fa-location-dot"></i> {job.location}</span>
            )}
            {job.work_type && (
              <span className="tag"><i className="fa-solid fa-laptop-house"></i> {formatWorkType(job.work_type)}</span>
            )}
            {job.country && (
              <span className="tag"><i className="fa-solid fa-flag"></i> {formatCountry(job.country)}</span>
            )}
            {job.experience_level && (
              <span className="tag"><i className="fa-solid fa-graduation-cap"></i> {formatExperienceLevel(job.experience_level)}</span>
            )}
            {job.salary_range && (
              <span className="tag"><i className="fa-solid fa-dollar-sign"></i> {job.salary_range}</span>
            )}
            {job.source_platform && (
              <span className="tag">
                {job.source_platform === "github" ? (
                  <><i className="fa-brands fa-github"></i> GitHub</>
                ) : (
                  <><i className="fa-brands fa-linkedin"></i> LinkedIn</>
                )}
              </span>
            )}
          </div>

          {/* Description */}
          <div className="job-detail-description">
            <h2>Overview</h2>
            {job.description ? (
              <div className="description-content">{job.description}</div>
            ) : (
              <div className="description-empty">
                <p>Job description not available from the source repository.</p>
                <p>Click below to view the full posting on the original site.</p>
              </div>
            )}
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outline btn-original-post"
            >
              <i className="fa-solid fa-arrow-up-right-from-square"></i> Original Job Post
            </a>
          </div>
        </div>

        {/* Right: Match Score Panel */}
        <div className="job-detail-sidebar">
          {loading && (
            <div className="match-loading">
              <div className="spinner" />
              <span>Analyzing match...</span>
            </div>
          )}

          {error && <div className="match-error">{error}</div>}

          {score > 0 && !loading && (
            <div className="match-score-card">
              <div className="match-circle-large">
                <svg viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" strokeWidth="6" />
                  <circle
                    cx="50" cy="50" r="42"
                    fill="none" stroke={color} strokeWidth="6"
                    strokeDasharray={`${score * 2.64} 264`}
                    strokeLinecap="round"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <span className="match-number-large">{score}<small>%</small></span>
              </div>
              <span className="match-label-large" style={{ color }}>{label}</span>
            </div>
          )}

          {breakdown && (
            <div className="match-breakdown">
              <h3>Match Breakdown</h3>
              <div className="breakdown-item">
                <span className="breakdown-label">Experience</span>
                <div className="breakdown-bar">
                  <div
                    className="breakdown-fill"
                    style={{ width: `${breakdown.experience_score}%`, backgroundColor: getMatchColor(breakdown.experience_score) }}
                  />
                </div>
                <span className="breakdown-value">{breakdown.experience_score}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Skill Match</span>
                <div className="breakdown-bar">
                  <div
                    className="breakdown-fill"
                    style={{ width: `${breakdown.skill_score}%`, backgroundColor: getMatchColor(breakdown.skill_score) }}
                  />
                </div>
                <span className="breakdown-value">{breakdown.skill_score}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Industry Exp.</span>
                <div className="breakdown-bar">
                  <div
                    className="breakdown-fill"
                    style={{ width: `${breakdown.industry_score}%`, backgroundColor: getMatchColor(breakdown.industry_score) }}
                  />
                </div>
                <span className="breakdown-value">{breakdown.industry_score}%</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
