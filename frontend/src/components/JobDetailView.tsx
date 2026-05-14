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
  if (score >= 80) return "#5B5BFF";
  if (score >= 60) return "#f59e0b";
  return "#6b7280";
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
  const [applyUrl, setApplyUrl] = useState(job.url);
  const [description, setDescription] = useState(job.description || "");
  const [companyLogo, setCompanyLogo] = useState(job.company_logo || "");
  const [fetchingDetails, setFetchingDetails] = useState(false);
  const [structured, setStructured] = useState<any>(null);
  const [structuring, setStructuring] = useState(false);

  useEffect(() => {
    // Reset local state when job changes to avoid stale data from previous job
    setApplyUrl(job.url);
    setDescription(job.description || "");
    setCompanyLogo(job.company_logo || "");
    setBreakdown(null);
    setError("");
    setStructured(null);
    setStructuring(false);

    // Fetch actual job URL and description
    fetchJobDetails();

    // Immediately try to get structured description if we already have text
    if (job.description && job.description.length > 50) {
      fetchStructured();
    }

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

  useEffect(() => {
    // If description was fetched (didn't exist before), trigger structuring
    if (description && description.length > 50 && !structured && !job.description) {
      fetchStructured();
    }
  }, [description]);

  async function fetchStructured() {
    setStructuring(true);
    try {
      const res = await fetch(`${API_BASE}/jobs/${job.id}/structure-description`, { method: "POST" });
      const data = await res.json();
      if (data.sections && data.sections.length > 0) setStructured(data);
    } catch {
      // Silently fail — will show raw description
    } finally {
      setStructuring(false);
    }
  }

  async function fetchJobDetails() {
    // Use job.description directly to avoid stale closure from state
    if (job.description && job.description.length > 50) return; // Already have description
    setFetchingDetails(true);
    try {
      const res = await fetch(`${API_BASE}/jobs/${job.id}/fetch-details`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.apply_url) setApplyUrl(data.apply_url);
        if (data.description) setDescription(data.description);
        if (data.company_logo) setCompanyLogo(data.company_logo);
      }
    } catch {
      // Silently fail — keep original URL
    } finally {
      setFetchingDetails(false);
    }
  }

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
      {/* Close button */}
      {onClose && (
        <button className="btn-close-detail" onClick={onClose} aria-label="Close detail panel">
          <i className="fa-solid fa-xmark"></i>
        </button>
      )}

      {/* Header section */}
      <div className="job-detail-header-section">
        <div className="job-detail-company-row">
          {(() => {
            const cleaned = job.company.toLowerCase().replace(/[^a-z0-9]/g, "");
            let domain = "";
            if (companyLogo && companyLogo.includes("logo.clearbit.com/")) {
              domain = companyLogo.split("logo.clearbit.com/")[1] || "";
            } else if (companyLogo && companyLogo.includes("icon.horse/icon/")) {
              domain = companyLogo.split("icon.horse/icon/")[1] || "";
            }
            if (!domain) domain = cleaned.length >= 2 ? `${cleaned}.com` : "";
            const logoUrl = companyLogo && companyLogo.startsWith("http") && !companyLogo.includes("clearbit") && !companyLogo.includes("icon.horse") && !companyLogo.includes("google.com/s2") && !companyLogo.includes("hunter.io") && !companyLogo.includes("apistemic")
              ? companyLogo
              : domain ? `https://logos-api.apistemic.com/domain:${domain}?fallback=404` : null;
            return logoUrl ? (
              <img
                src={logoUrl}
                alt={`${job.company} logo`}
                className="detail-company-logo"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  const src = img.src;
                  if (src.includes("apistemic.com") && domain) {
                    img.src = `https://logos.hunter.io/${domain}`;
                  } else {
                    img.style.display = "none";
                    (img.nextElementSibling as HTMLElement)?.classList.remove("hidden-logo");
                  }
                }}
              />
            ) : null;
          })()}
          <div className={`detail-company-logo-placeholder ${(job.company_logo || job.company.length >= 2) ? "hidden-logo" : ""}`} aria-label={`${job.company} logo`}>
            {job.company.charAt(0).toUpperCase()}
          </div>
          <div className="detail-company-info">
            <span className="job-detail-company">{job.company}</span>
            <span className="job-detail-posted">{job.posted_date ? timeAgo(job.posted_date) : timeAgo(job.scraped_at)}</span>
          </div>
        </div>

        <h1 className="job-detail-title">{job.title}</h1>

        {/* Tags row */}
        <div className="job-detail-tags">
          {job.location && (
            <span className="detail-tag">
              <i className="fa-solid fa-location-dot"></i> {job.location}
            </span>
          )}
          {job.work_type && (
            <span className="detail-tag">
              <i className="fa-solid fa-laptop-house"></i> {formatWorkType(job.work_type)}
            </span>
          )}
          {job.country && (
            <span className="detail-tag">
              <i className="fa-solid fa-flag"></i> {formatCountry(job.country)}
            </span>
          )}
          {job.experience_level && (
            <span className="detail-tag detail-tag-highlight">
              <i className="fa-solid fa-graduation-cap"></i> {formatExperienceLevel(job.experience_level)}
            </span>
          )}
          {job.salary_range && (
            <span className="detail-tag detail-tag-salary">
              <i className="fa-solid fa-dollar-sign"></i> {job.salary_range}
            </span>
          )}
          {job.role_category && (
            <span className="detail-tag detail-tag-category">
              {job.role_category}
            </span>
          )}
          {job.source_platform && (
            <span className="detail-tag">
              {job.source_platform === "github" ? (
                <><i className="fa-brands fa-github"></i> GitHub</>
              ) : (
                <><i className="fa-brands fa-linkedin"></i> LinkedIn</>
              )}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="job-detail-actions">
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-apply-detail">
            <i className="fa-solid fa-paper-plane"></i> Apply with Autofill
          </a>
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-outline-detail">
            <i className="fa-solid fa-arrow-up-right-from-square"></i> View Original Post
          </a>
        </div>
      </div>

      {/* Content area */}
      <div className="job-detail-content">
        {/* Main content */}
        <div className="job-detail-main">
          <div className="job-detail-description">
            <h2 className="detail-section-title">Overview</h2>
            {fetchingDetails ? (
              <div className="description-loading">
                <div className="spinner" />
                <span>Loading job details...</span>
              </div>
            ) : structured ? (
              <div className="structured-description">
                {/* Skill tags */}
                {structured.skills && structured.skills.length > 0 && (
                  <div className="skill-tags">
                    {structured.skills.map((skill: string, i: number) => (
                      <span key={i} className="skill-tag">{skill}</span>
                    ))}
                  </div>
                )}
                {/* Sections */}
                {structured.sections.map((section: any, i: number) => (
                  <div key={i} className="desc-section">
                    <h3 className="desc-section-title">
                      <i className={`fa-solid fa-${section.icon || 'list'}`}></i> {section.title}
                    </h3>
                    {section.items && (
                      <ul className="desc-section-list">
                        {section.items.map((item: string, j: number) => (
                          <li key={j}>{item}</li>
                        ))}
                      </ul>
                    )}
                    {section.subsections && section.subsections.map((sub: any, k: number) => (
                      <div key={k} className="desc-subsection">
                        <h4 className="desc-subsection-title">{sub.title}</h4>
                        <ul className="desc-section-list">
                          {sub.items.map((item: string, j: number) => (
                            <li key={j}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : description ? (
              <div className="description-structuring">
                {structuring && (
                  <div className="description-structuring-indicator">
                    <div className="spinner" />
                    <span>Structuring job description...</span>
                  </div>
                )}
                <div className={`description-content ${structuring ? "description-faded" : ""}`} dangerouslySetInnerHTML={{ __html: description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n') }} />
              </div>
            ) : (
              <div className="description-empty">
                <div className="description-empty-icon">
                  <i className="fa-regular fa-file-lines"></i>
                </div>
                <p className="description-empty-title">No description available</p>
                <p className="description-empty-subtitle">
                  This job was sourced from a GitHub repository listing. Visit the original post for full details.
                </p>
              </div>
            )}
          </div>

          {job.applicant_count != null && job.applicant_count > 0 && (
            <div className="job-detail-meta-row">
              <i className="fa-solid fa-users"></i>
              <span>{job.applicant_count}+ applicants</span>
            </div>
          )}
        </div>

        {/* Sidebar: Match Score */}
        <div className="job-detail-sidebar">
          {loading && (
            <div className="match-loading-card">
              <div className="spinner" />
              <span>Analyzing match...</span>
            </div>
          )}

          {error && <div className="match-error-card">{error}</div>}

          {score > 0 && !loading && (
            <div className="match-score-card">
              <div className="match-circle-large">
                <svg viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#e5e7eb" strokeWidth="6" />
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
                <span className="breakdown-label">Skills</span>
                <div className="breakdown-bar">
                  <div
                    className="breakdown-fill"
                    style={{ width: `${breakdown.skill_score}%`, backgroundColor: getMatchColor(breakdown.skill_score) }}
                  />
                </div>
                <span className="breakdown-value">{breakdown.skill_score}%</span>
              </div>
              <div className="breakdown-item">
                <span className="breakdown-label">Industry</span>
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
