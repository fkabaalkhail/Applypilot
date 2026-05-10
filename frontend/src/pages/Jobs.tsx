import { useState, useEffect } from "react";

const API_BASE = "";

interface Job {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  match_score: number;
  match_summary: string;
  salary_range: string;
  company_size: string;
  status: string;
  easy_apply: boolean;
  ats_type: string;
  scraped_at: string;
}

interface Stats {
  total: number;
  applied: number;
  new: number;
}

function MatchBadge({ score }: { score: number }) {
  const label = score >= 80 ? "STRONG MATCH" : score >= 60 ? "GOOD MATCH" : "FAIR MATCH";
  const color = score >= 80 ? "var(--accent)" : score >= 60 ? "var(--accent-muted)" : "var(--text-muted)";
  return (
    <div className="match-badge">
      <div className="match-circle">
        <svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" fill="none" stroke="var(--bg-dark)" strokeWidth="6" />
          <circle
            cx="50" cy="50" r="42"
            fill="none" stroke={color} strokeWidth="6"
            strokeDasharray={`${score * 2.64} 264`}
            strokeLinecap="round"
            transform="rotate(-90 50 50)"
          />
        </svg>
        <span className="match-number">{score}<small>%</small></span>
      </div>
      <span className="match-label">{label}</span>
    </div>
  );
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, applied: 0, new: 0 });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("Recommended");

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/jobs?page_size=50`).then((r) => r.ok ? r.json() : []),
      fetch(`${API_BASE}/jobs/stats`).then((r) => r.ok ? r.json() : { total: 0, applied: 0, new: 0 }),
    ])
      .then(([jobsData, statsData]) => {
        setJobs(jobsData);
        setStats(statsData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const TABS = [
    { label: "Recommended", count: null },
    { label: "Applied", count: stats.applied },
    { label: "New", count: stats.new },
  ];

  const filteredJobs = jobs.filter((j) => {
    if (activeTab === "Applied") return j.status === "applied";
    if (activeTab === "New") return j.status === "new";
    return true;
  });

  return (
    <div className="jobs-page">
      <header className="jobs-header">
        <div className="jobs-title-row">
          <h1>JOBS</h1>
          <div className="jobs-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.label}
                className={`tab-btn ${activeTab === tab.label ? "active" : ""}`}
                onClick={() => setActiveTab(tab.label)}
              >
                {tab.label}
                {tab.count !== null && <span className="tab-count">{tab.count}</span>}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="jobs-content">
        <div className="jobs-list">
          {loading && <p className="loading-text">Loading jobs...</p>}
          {!loading && filteredJobs.length === 0 && (
            <p className="empty-text">No jobs found. Start the scraper or check your backend.</p>
          )}
          {filteredJobs.map((job) => (
            <div key={job.id} className="job-card">
              <div className="job-card-body">
                <h2 className="job-title">{job.title}</h2>
                <p className="job-company">{job.company}</p>
                <div className="job-meta">
                  <span>{job.location}</span>
                  {job.salary_range && <span>{job.salary_range}</span>}
                  {job.ats_type && <span className="ats-badge">{job.ats_type}</span>}
                </div>
                {job.match_summary && (
                  <p className="job-summary">{job.match_summary}</p>
                )}
                <div className="job-footer">
                  <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-outline">
                    View
                  </a>
                </div>
              </div>
              {job.match_score > 0 && <MatchBadge score={job.match_score} />}
            </div>
          ))}
        </div>

        <aside className="jobs-sidebar">
          <div className="sidebar-card">
            <h3>Stats</h3>
            <div className="stat-row"><span>Total Jobs</span><strong>{stats.total}</strong></div>
            <div className="stat-row"><span>Applied</span><strong>{stats.applied}</strong></div>
            <div className="stat-row"><span>New</span><strong>{stats.new}</strong></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
