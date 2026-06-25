import { useState, useEffect, useRef } from "react";
import JobFilterBar, { JobFilters } from "../components/JobFilterBar";
import JobDetailView from "../components/JobDetailView";
import CustomResumeModal, { type AIJob } from "../components/CustomResumeModal";
import CoverLetterModal from "../components/CoverLetterModal";
import api from "../auth/api";



interface Job {
  id: number;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  match_score: number;
  match_summary: string;
  match_label: string;
  salary_range: string;
  company_size: string;
  status: string;
  easy_apply: boolean;
  ats_type: string;
  scraped_at: string;
  source_platform: string;
  saved: boolean;
  experience_score: number;
  skill_score: number;
  industry_score: number;
  applicant_count: number | null;
  company_logo: string;
  work_type: string;
  role_category: string;
  country: string;
  experience_level: string;
  posted_date: string | null;
}

interface Stats {
  total: number;
  applied: number;
  new: number;
  avg_match_score: number;
  saved_count: number;
}

interface Filters {
  source: string;
  min_match_score: number;
  experience_level: string;
}

// Company logo colors based on first letter
const LOGO_COLORS: Record<string, string> = {
  A: "#FF6B35", B: "#4ECDC4", C: "#45B7D1", D: "#96CEB4",
  E: "#FFEAA7", F: "#2D3436", G: "#4285F4", H: "#E17055",
  I: "#6C5CE7", J: "#00B894", K: "#FDCB6E", L: "#E84393",
  M: "#0984E3", N: "#E50914", O: "#FF9F43", P: "#6C5CE7",
  Q: "#00CEC9", R: "#D63031", S: "#C0392B", T: "#2ECC71",
  U: "#3498DB", V: "#1ABC9C", W: "#9B59B6", X: "#34495E",
  Y: "#F39C12", Z: "#1ABC9C",
};

function getLogoColor(company: string): string {
  const letter = company.charAt(0).toUpperCase();
  return LOGO_COLORS[letter] || "#6B7280";
}

// Known company → domain mappings for accurate logos
const COMPANY_DOMAINS: Record<string, string> = {
  "pwc canada": "pwc.com", "pwc": "pwc.com",
  "deloitte canada": "deloitte.com", "deloitte": "deloitte.com",
  "kpmg canada": "kpmg.com", "kpmg": "kpmg.com",
  "ey canada": "ey.com", "ey": "ey.com",
  "accenture canada": "accenture.com", "accenture": "accenture.com",
  "mckinsey": "mckinsey.com", "mckinsey (canada)": "mckinsey.com",
  "capgemini canada": "capgemini.com", "capgemini": "capgemini.com",
  "td bank": "td.com", "td": "td.com",
  "rbc": "rbc.com", "royal bank": "rbc.com",
  "cibc": "cibc.com",
  "bmo": "bmo.com", "bank of montreal": "bmo.com",
  "scotiabank": "scotiabank.com",
  "national bank": "nbc.ca", "national bank of canada": "nbc.ca",
  "cgi": "cgi.com",
  "manulife": "manulife.com",
  "sun life": "sunlife.com",
  "shopify": "shopify.com",
  "kinaxis": "kinaxis.com",
  "ciena": "ciena.com",
  "ross video": "rossvideo.com",
  "trend micro": "trendmicro.com",
  "magnet forensics": "magnetforensics.com",
  "ribbon communications": "ribboncommunications.com",
  "assent compliance": "assentcompliance.com",
  "you.i tv": "youi.tv",
  "electronic arts": "ea.com", "electronic arts (ea)": "ea.com",
  "capital one": "capitalone.com",
  "jp morgan": "jpmorgan.com", "jpmorgan": "jpmorgan.com",
  "goldman sachs": "goldmansachs.com",
  "two sigma": "twosigma.com",
  "de shaw": "deshaw.com",
  "jane street": "janestreet.com",
  "meta": "meta.com", "facebook": "meta.com",
  "google": "google.com", "alphabet": "google.com",
  "amazon": "amazon.com", "aws": "amazon.com",
  "apple": "apple.com",
  "microsoft": "microsoft.com",
  "netflix": "netflix.com",
  "uber": "uber.com",
  "airbnb": "airbnb.com",
  "stripe": "stripe.com",
  "openai": "openai.com",
  "anthropic": "anthropic.com",
  "nvidia": "nvidia.com",
  "databricks": "databricks.com",
  "snowflake": "snowflake.com",
  "salesforce": "salesforce.com",
  "oracle": "oracle.com",
  "adobe": "adobe.com",
  "intuit": "intuit.com",
  "spotify": "spotify.com",
  "twitter": "x.com",
  "snap": "snap.com", "snapchat": "snap.com",
  "discord": "discord.com",
  "figma": "figma.com",
  "notion": "notion.so",
  "bytedance": "bytedance.com", "tiktok": "tiktok.com",
  "bloomberg": "bloomberg.com",
  "palantir": "palantir.com",
  "coinbase": "coinbase.com",
  "robinhood": "robinhood.com",
  "doordash": "doordash.com",
  "roblox": "roblox.com",
  "tesla": "tesla.com",
  "spacex": "spacex.com",
  "wealthsimple": "wealthsimple.com",
  "clio": "clio.com",
  "fullscript": "fullscript.com",
  "solace": "solace.com",
  "calian": "calian.com",
  "ericsson": "ericsson.com",
  "blackberry": "blackberry.com",
  "nokia": "nokia.com",
  "mitel": "mitel.com",
  "coveo": "coveo.com",
  "huawei": "huawei.com", "huawei canada": "huawei.com",
  "fortinet": "fortinet.com",
  "mongodb": "mongodb.com",
};

function getCompanyLogoUrl(company: string, companyLogo: string): string | null {
  // If we have a direct URL (LinkedIn CDN, etc.), use it
  if (companyLogo && companyLogo.startsWith("http") && !companyLogo.includes("clearbit") && !companyLogo.includes("icon.horse") && !companyLogo.includes("google.com/s2") && !companyLogo.includes("apistemic") && !companyLogo.includes("hunter.io")) {
    return companyLogo;
  }
  // Check known domain mapping first
  const lowerCompany = company.toLowerCase().trim();
  let domain = COMPANY_DOMAINS[lowerCompany] || "";

  // If not in mapping, try extracting from stored logo URL
  if (!domain && companyLogo) {
    if (companyLogo.includes("logo.clearbit.com/")) {
      domain = companyLogo.split("logo.clearbit.com/")[1] || "";
    } else if (companyLogo.includes("icon.horse/icon/")) {
      domain = companyLogo.split("icon.horse/icon/")[1] || "";
    } else if (companyLogo.includes("apistemic.com/domain:")) {
      const match = companyLogo.match(/domain:([^?]+)/);
      if (match) domain = match[1];
    }
  }

  // Fallback: guess domain from company name
  if (!domain) {
    // Remove common suffixes like "Inc.", "Ltd.", "Corp.", "Canada", etc.
    const cleaned = lowerCompany
      .replace(/\s*(inc\.?|ltd\.?|corp\.?|llc|canada|usa|us|uk|group|technologies|solutions)\s*/gi, "")
      .replace(/[^a-z0-9]/g, "");
    if (cleaned.length < 2) return null;
    domain = `${cleaned}.com`;
  }

  return `https://logos-api.apistemic.com/domain:${domain}?fallback=404`;
}

// On error: try Hunter.io, then hide
function handleLogoError(e: React.SyntheticEvent<HTMLImageElement>, company: string, _companyLogo: string) {
  const img = e.target as HTMLImageElement;
  const src = img.src;
  const lowerCompany = company.toLowerCase().trim();
  const knownDomain = COMPANY_DOMAINS[lowerCompany];
  const cleaned = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const domain = knownDomain || (cleaned.length >= 2 ? `${cleaned}.com` : "");

  if (src.includes("apistemic.com") && domain) {
    // Try hunter.io as second attempt
    img.src = `https://logos.hunter.io/${domain}`;
  } else if (src.includes("hunter.io") && domain) {
    // Try Google favicon as last resort
    img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } else {
    // All failed — hide the img, letter initial will show through
    img.style.display = "none";
  }
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 0) return "Today"; // future date (timezone issue)
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  // For older dates, show the actual date
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const FILTER_STORAGE_KEY = "job-aggregator-filters";

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, applied: 0, new: 0, avg_match_score: 0, saved_count: 0 });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("Recommended");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = 50;
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [rewriteJob, setRewriteJob] = useState<AIJob | null>(null);
  const [coverJob, setCoverJob] = useState<AIJob | null>(null);
  const [filtersVisible, setFiltersVisible] = useState(true);

  const jobsListRef = useRef<HTMLDivElement>(null);
  const prevSelectedJobRef = useRef<Job | null>(null);

  const [filters] = useState<Filters>({
    source: "",
    min_match_score: 0,
    experience_level: "",
  });

  const [aggFilters, setAggFilters] = useState<JobFilters>(() => {
    try {
      const saved = localStorage.getItem(FILTER_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          country: parsed.country || "",
          location: Array.isArray(parsed.location)
            ? parsed.location
            : typeof parsed.location === "string" && parsed.location
              ? [parsed.location]
              : [],
          work_type: Array.isArray(parsed.work_type) ? parsed.work_type : [],
          role_category: Array.isArray(parsed.role_category) ? parsed.role_category : [],
          experience_level: Array.isArray(parsed.experience_level) ? parsed.experience_level : parsed.experience_level ? [parsed.experience_level] : [],
          date_posted: parsed.date_posted || "",
        };
      }
    } catch {
      // Ignore parse errors, use defaults
    }
    return { country: "", location: [], work_type: [], role_category: [], experience_level: [], date_posted: "" };
  });

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(aggFilters));
    } catch {
      // Ignore storage errors (e.g., quota exceeded)
    }
  }, [aggFilters]);

  // Close detail panel on Escape key press
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && selectedJob) {
        setSelectedJob(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedJob]);

  // Restore focus to job list when detail panel closes
  useEffect(() => {
    if (prevSelectedJobRef.current && !selectedJob) {
      jobsListRef.current?.focus();
    }
    prevSelectedJobRef.current = selectedJob;
  }, [selectedJob]);

  useEffect(() => {
    fetchJobs();
    fetchStats();
  }, [page, activeTab, filters, aggFilters, search]);

  async function fetchJobs() {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));

    if (activeTab === "Saved" || activeTab === "Liked") params.set("saved", "1");
    if (activeTab === "Recommended") params.set("sort", "match");
    if (filters.source) params.set("source", filters.source);
    if (filters.min_match_score > 0) params.set("min_score", String(filters.min_match_score));
    if (search.trim()) params.set("search", search.trim());

    if (aggFilters.country) params.set("country", aggFilters.country);
    if (aggFilters.location.length > 0) {
      const locationParam = aggFilters.location.map(c => c.trim()).filter(c => c.length > 0).join(",");
      if (locationParam) params.set("location", locationParam);
    }
    if (aggFilters.work_type.length > 0) params.set("work_type", aggFilters.work_type.join(","));
    if (aggFilters.role_category.length > 0) params.set("role_category", aggFilters.role_category.join(","));
    if (aggFilters.experience_level.length > 0) params.set("experience_level", aggFilters.experience_level.join(","));
    if (aggFilters.date_posted) params.set("date_posted", aggFilters.date_posted);

    try {
      const res = await api.get("/jobs", { params });
      setJobs(res.data);
      setHasMore(res.data.length === pageSize);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await api.get("/jobs/stats");
      setStats(res.data);
    } catch {
      // Silently fail
    }
  }

  async function toggleSave(job: Job) {
    const endpoint = job.saved
      ? `/jobs/${job.id}/unsave`
      : `/jobs/${job.id}/save`;

    try {
      await api.post(endpoint);
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, saved: !j.saved } : j))
      );
      fetchStats();
    } catch {
      // Silently fail
    }
  }

  const TABS = [
    { label: "Recommended", count: null },
    { label: "Liked", count: stats.saved_count },
    { label: "Applied", count: stats.applied },
    { label: "New", count: stats.new },
  ];

  const filteredJobs = jobs.filter((j) => {
    if (activeTab === "Applied") return j.status === "applied";
    if (activeTab === "New") return j.status === "new";
    if (activeTab === "Liked") return j.saved;
    return true;
  });

  // Auto-close detail panel when selected job is filtered out
  useEffect(() => {
    if (selectedJob && !filteredJobs.some((j) => j.id === selectedJob.id)) {
      setSelectedJob(null);
    }
  }, [filteredJobs, selectedJob]);

  return (
    <div className="jobs-page">
      {/* Header Bar */}
      <header className="jobs-header">
        <h1>Jobs</h1>
        <div className="header-right">
          <div className="search-wrapper">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              placeholder="Search by title or company"
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </header>

      {/* Tabs + Filter Bar */}
      <div className="jobs-toolbar">
        <div className="jobs-toolbar-top">
          <div className="jobs-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.label}
                className={`tab-btn ${activeTab === tab.label ? "active" : ""}`}
                onClick={() => { setActiveTab(tab.label); setPage(1); }}
              >
                {tab.label}
                {tab.count !== null && tab.count > 0 && (
                  <span className="tab-count">{tab.count}</span>
                )}
              </button>
            ))}
          </div>
          <button
            className="filter-toggle-btn"
            onClick={() => setFiltersVisible(!filtersVisible)}
            aria-label={filtersVisible ? "Hide filters" : "Show filters"}
          >
            <i className="fa-solid fa-sliders"></i>
            {filtersVisible ? "Hide Filters" : "Show Filters"}
          </button>
        </div>
        {filtersVisible && (
          <JobFilterBar
            filters={aggFilters}
            onChange={(newFilters) => { setAggFilters(newFilters); setPage(1); }}
            totalCount={stats.total}
          />
        )}
      </div>

      {/* Content Area: Job Feed + Detail Panel */}
      <div className={`jobs-content-area${selectedJob ? " has-detail" : ""}`}>
        {/* Job Feed */}
        <div className="jobs-feed" ref={jobsListRef} tabIndex={-1}>
          {loading && <p className="loading-text">Loading jobs...</p>}
          {!loading && filteredJobs.length === 0 && (
            <p className="empty-text">No jobs found. Start the scraper or adjust your filters.</p>
          )}

          {filteredJobs.map((job) => (
            <div key={job.id} className={`job-card${selectedJob?.id === job.id ? " selected" : ""}`} onClick={() => setSelectedJob(job)} style={{ cursor: "pointer" }}>
              <div className="job-card-body">
                {/* Header: Logo + Info + Bookmark */}
                <div className="job-card-header">
                  <div className="company-logo-wrapper">
                    <div
                      className="company-logo"
                      style={{ backgroundColor: getLogoColor(job.company) }}
                    >
                      {job.company.charAt(0).toUpperCase()}
                    </div>
                    {(() => {
                      const logoUrl = getCompanyLogoUrl(job.company, job.company_logo);
                      return logoUrl ? (
                        <img
                          src={logoUrl}
                          alt=""
                          className="company-logo-img-overlay"
                          onError={(e) => handleLogoError(e, job.company, job.company_logo)}
                        />
                      ) : null;
                    })()}
                  </div>
                  <div className="job-card-info">
                    <div className="job-card-badges">
                      <span className="badge-time">
                        <i className="fa-regular fa-clock"></i> {job.posted_date ? timeAgo(job.posted_date) : timeAgo(job.scraped_at)}
                      </span>
                    </div>
                    <h2 className="job-title">{job.title}</h2>
                    <p className="job-company">
                      {job.company}
                      <span className="company-meta"> · {job.company_size || "Technology"}</span>
                    </p>
                  </div>
                  <button
                    className={`btn-bookmark ${job.saved ? "saved" : ""}`}
                    onClick={(e) => { e.stopPropagation(); toggleSave(job); }}
                    aria-label={job.saved ? "Unsave job" : "Save job"}
                  >
                    <i className={job.saved ? "fa-solid fa-bookmark" : "fa-regular fa-bookmark"}></i>
                  </button>
                </div>

                {/* Details Grid */}
                <div className="job-details-grid">
                  <div className="job-detail-item">
                    <i className="fa-solid fa-location-dot"></i>
                    <span>{job.location || "Remote"}</span>
                  </div>
                  <div className="job-detail-item">
                    <i className="fa-solid fa-briefcase"></i>
                    <span>Full-time</span>
                  </div>
                  <div className="job-detail-item">
                    <i className="fa-solid fa-laptop-house"></i>
                    <span>{job.work_type === "remote" ? "Remote" : job.work_type === "hybrid" ? "Hybrid" : "On Site"}</span>
                  </div>
                  <div className="job-detail-item">
                    <i className="fa-solid fa-graduation-cap"></i>
                    <span>{job.experience_level === "internship" ? "Internship" : "Entry, New Grad"}</span>
                  </div>
                  {job.salary_range && !job.salary_range.startsWith("{") && (
                    <div className="job-detail-item">
                      <i className="fa-solid fa-sack-dollar"></i>
                      <span className="salary">{job.salary_range}</span>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="job-card-footer" onClick={(e) => e.stopPropagation()}>
                  <span className="applicant-text">
                    {job.applicant_count
                      ? <><i className="fa-solid fa-users"></i> {job.applicant_count}+ applicants</>
                      : ""}
                  </span>
                  <div className="job-actions">
                    <button className="btn-icon" title="Not interested">
                      <i className="fa-solid fa-thumbs-down"></i>
                    </button>
                    <button className="btn-icon" title="Share">
                      <i className="fa-solid fa-share-nodes"></i>
                    </button>
                    <button
                      className="btn-ai"
                      onClick={(e) => { e.stopPropagation(); setRewriteJob({ id: job.id, title: job.title, company: job.company, url: job.url }); }}
                    >
                      <i className="fa-solid fa-wand-magic-sparkles"></i> Custom Resume
                    </button>
                    <button
                      className="btn-ai"
                      onClick={(e) => { e.stopPropagation(); setCoverJob({ id: job.id, title: job.title, company: job.company, url: job.url }); }}
                    >
                      <i className="fa-solid fa-envelope"></i> Cover Letter
                    </button>
                    <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-apply">APPLY WITH AUTOFILL</a>
                  </div>
                </div>
              </div>

              {/* Match Score Badge */}
              {job.match_score > 0 && (
                <div className="match-score-badge">
                  <div className="match-circle-sm">
                    <svg viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="#e8e0f0" strokeWidth="8" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="#7c3aed" strokeWidth="8"
                        strokeDasharray={`${job.match_score * 2.51} 251`}
                        strokeLinecap="round"
                        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
                      />
                    </svg>
                    <span className="match-pct">{job.match_score}<small>%</small></span>
                  </div>
                  <span className="match-label-sm">
                    {job.match_score >= 80 ? "STRONG" : job.match_score >= 60 ? "GOOD" : "FAIR"} MATCH
                  </span>
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          {!loading && filteredJobs.length > 0 && (
            <div className="pagination">
              <button
                className="btn-outline"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <i className="fa-solid fa-chevron-left"></i> Previous
              </button>
              <span className="page-indicator">Page {page}</span>
              <button
                className="btn-outline"
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <i className="fa-solid fa-chevron-right"></i>
              </button>
            </div>
          )}
        </div>

        {/* Inline Job Detail Panel */}
        {selectedJob && (
          <div className="job-detail-inline">
            <JobDetailView job={selectedJob} onClose={() => setSelectedJob(null)} />
          </div>
        )}
      </div>

      {rewriteJob && <CustomResumeModal job={rewriteJob} onClose={() => setRewriteJob(null)} />}
      {coverJob && <CoverLetterModal job={coverJob} onClose={() => setCoverJob(null)} />}
    </div>
  );
}
