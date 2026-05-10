import { useState } from "react";

const MOCK_JOBS = [
  {
    id: 1,
    title: "Full Stack Developer",
    company: "TechNova",
    industry: "SaaS · Series B",
    location: "Toronto, ON",
    workMode: "Hybrid",
    type: "Full-time",
    level: "Mid Level",
    salary: "CA$95K - CA$120K/yr",
    posted: "2 hours ago",
    applicants: "50+ applicants",
    matchScore: 91,
    matchLabel: "STRONG MATCH",
    connection: "1 school alumnus works here",
  },
  {
    id: 2,
    title: "Backend Engineer",
    company: "DataStream",
    industry: "Data Analytics · Growth Stage",
    location: "Vancouver, BC",
    workMode: "Remote",
    type: "Full-time",
    level: "Entry, Mid Level",
    salary: "CA$85K - CA$105K/yr",
    posted: "5 hours ago",
    applicants: "120+ applicants",
    matchScore: 72,
    matchLabel: "GOOD MATCH",
    connection: null,
  },
  {
    id: 3,
    title: "Software Engineer Intern",
    company: "CloudBase",
    industry: "Cloud Infrastructure · Startup",
    location: "Ottawa, ON",
    workMode: "Onsite",
    type: "Internship",
    level: "Intern",
    salary: "$22/hr - $28/hr",
    posted: "8 hours ago",
    applicants: "30 applicants",
    matchScore: 85,
    matchLabel: "STRONG MATCH",
    connection: "2 former colleagues work here",
  },
  {
    id: 4,
    title: "React Developer",
    company: "FinEdge",
    industry: "Fintech · Public Company",
    location: "Montreal, QC",
    workMode: "Hybrid",
    type: "Full-time",
    level: "Senior",
    salary: "CA$110K - CA$140K/yr",
    posted: "12 hours ago",
    applicants: "200+ applicants",
    matchScore: 58,
    matchLabel: "FAIR MATCH",
    connection: null,
  },
];

const FILTERS = [
  { label: "Canada", active: true },
  { label: "Full Stack Engineer", count: 4, active: true },
  { label: "Remote", count: 2, active: true },
  { label: "Full-time", count: 2, active: true },
];

const TABS = [
  { label: "Recommended", count: null },
  { label: "Liked", count: 0 },
  { label: "Applied", count: 12 },
  { label: "External", count: 3 },
];

function MatchBadge({ score, label }: { score: number; label: string }) {
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
  const [activeTab, setActiveTab] = useState("Recommended");

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
          <div className="header-right">
            <input type="text" placeholder="Search by title or company" className="search-input" />
          </div>
        </div>
        <div className="filter-row">
          {FILTERS.map((f) => (
            <button key={f.label} className={`filter-pill ${f.active ? "active" : ""}`}>
              {f.label}
              {f.count && <span className="filter-count">+{f.count}</span>}
              <span className="filter-arrow">▾</span>
            </button>
          ))}
          <button className="filter-pill outline">Past 24 hours ▾</button>
          <button className="filter-pill outline">Industry ▾</button>
          <button className="filter-pill accent">••• All Filters</button>
        </div>
      </header>

      <div className="jobs-content">
        <div className="jobs-list">
          {MOCK_JOBS.map((job) => (
            <div key={job.id} className="job-card">
              <div className="job-card-body">
                <div className="job-card-top">
                  <span className="job-posted">{job.posted}</span>
                  {job.connection && <span className="job-connection">{job.connection}</span>}
                </div>
                <h2 className="job-title">{job.title}</h2>
                <p className="job-company">{job.company} / <span>{job.industry}</span></p>
                <div className="job-meta">
                  <span>{job.location}</span>
                  <span>{job.type}</span>
                  <span>{job.salary}</span>
                </div>
                <div className="job-meta secondary">
                  <span>{job.workMode}</span>
                  <span>{job.level}</span>
                </div>
                <div className="job-footer">
                  <span className="job-applicants">{job.applicants}</span>
                  <div className="job-actions">
                    <button className="btn-outline">Ask AI</button>
                    <button className="btn-primary">Apply Now</button>
                  </div>
                </div>
              </div>
              <MatchBadge score={job.matchScore} label={job.matchLabel} />
            </div>
          ))}
        </div>

        <aside className="jobs-sidebar">
          <div className="sidebar-card">
            <div className="user-badge">F</div>
            <span className="user-name">Fahad</span>
            <span className="plan-badge">Pro Plan</span>
          </div>
          <div className="sidebar-card">
            <h3>Your Saved Filters</h3>
            <div className="saved-filter">
              <div className="saved-filter-bar"></div>
              <span>Full Stack Engineer + 2 roles, CA</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
