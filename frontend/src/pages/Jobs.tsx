import { useState, useEffect, useRef } from "react";
import JobFilterBar, { JobFilters } from "../components/JobFilterBar";
import JobDetailView from "../components/JobDetailView";
import CustomResumeModal, { type AIJob } from "../components/CustomResumeModal";
import CoverLetterModal from "../components/CoverLetterModal";
import api from "../auth/api";
import { useApplyTracking } from "../context/ApplyTracking";
import { resolveLogoUrl, avatarColor } from "../lib/companyLogo";
import {
  MagnifyingGlass,
  Sliders,
  Clock,
  BookmarkSimple,
  MapPin,
  Briefcase,
  House,
  GraduationCap,
  Money,
  Users,
  ThumbsDown,
  ShareNetwork,
  MagicWand,
  Envelope,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react";



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
  company_domain?: string;
  company_url?: string;
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

// Logo + letter-avatar resolution is centralized in lib/companyLogo.
function getLogoColor(company: string): string {
  return avatarColor(company);
}

// On error: fall back to the letter avatar (no broken-image flashes, no
// cascade of third-party providers). The placeholder sits behind the <img>.
function handleLogoError(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.target as HTMLImageElement).style.display = "none";
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
  const [activeTab, setActiveTab] = useState("All");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = 50;
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rewriteJob, setRewriteJob] = useState<AIJob | null>(null);
  const [coverJob, setCoverJob] = useState<AIJob | null>(null);
  const [filtersVisible, setFiltersVisible] = useState(true);
  const { registerApplyClick } = useApplyTracking();

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

  // Open a specific job when arriving from a match-alert email (?job=<id>).
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const jobIdParam = params.get("job");
    if (!jobIdParam) return;
    deepLinkHandledRef.current = true;
    const jobId = Number(jobIdParam);
    (async () => {
      try {
        if (Number.isFinite(jobId)) {
          const res = await api.get(`/jobs/${jobId}`);
          setSelectedJob(res.data);
        }
      } catch {
        // Job not found or not accessible — fall back to the list.
      } finally {
        // Strip the param so refreshes don't re-open the panel.
        params.delete("job");
        const qs = params.toString();
        window.history.replaceState(
          {},
          "",
          window.location.pathname + (qs ? `?${qs}` : ""),
        );
      }
    })();
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchStats();
  }, [page, activeTab, filters, aggFilters, search]);

  async function fetchJobs() {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));

    if (activeTab === "Liked") params.set("saved", "1");
    if (activeTab === "All") params.set("sort", "match");
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

  // Auto-dismiss the save error after a few seconds.
  useEffect(() => {
    if (!saveError) return;
    const t = setTimeout(() => setSaveError(null), 4000);
    return () => clearTimeout(t);
  }, [saveError]);

  async function toggleSave(job: Job) {
    const next = !job.saved;
    const endpoint = next ? `/jobs/${job.id}/save` : `/jobs/${job.id}/unsave`;

    // Optimistic: flip the bookmark immediately so it feels responsive.
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, saved: next } : j))
    );

    try {
      await api.post(endpoint);
      fetchStats();
    } catch (err) {
      // Revert the optimistic change and tell the user it didn't stick.
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, saved: !next } : j))
      );
      const status = (err as { response?: { status?: number } })?.response?.status;
      setSaveError(
        status === 403
          ? "Verify your email to save jobs."
          : "Couldn't save the job. Please try again."
      );
    }
  }

  const TABS = [
    { label: "All", count: null },
    { label: "Liked", count: stats.saved_count },
  ];

  const filteredJobs = jobs.filter((j) => {
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
      {saveError && (
        <div className="toast toast-error" role="alert" style={{ margin: "0 0 12px" }}>
          {saveError}
        </div>
      )}
      {/* Header Bar */}
      <header className="jobs-header">
        <h1>Jobs</h1>
        <div className="header-right">
          <div className="search-wrapper">
            <MagnifyingGlass size={16} weight="bold" />
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
            <Sliders size={15} weight="bold" />
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
                      const logoUrl = resolveLogoUrl(job);
                      return logoUrl ? (
                        <img
                          src={logoUrl}
                          alt=""
                          className="company-logo-img-overlay"
                          loading="lazy"
                          onError={handleLogoError}
                        />
                      ) : null;
                    })()}
                  </div>
                  <div className="job-card-info">
                    <div className="job-card-badges">
                      <span className="badge-time">
                        <Clock size={13} weight="duotone" /> {job.posted_date ? timeAgo(job.posted_date) : timeAgo(job.scraped_at)}
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
                    <BookmarkSimple size={20} weight={job.saved ? "fill" : "regular"} />
                  </button>
                </div>

                {/* Details Grid */}
                <div className="job-details-grid">
                  <div className="job-detail-item">
                    <MapPin size={15} weight="duotone" />
                    <span>{job.location || "Remote"}</span>
                  </div>
                  <div className="job-detail-item">
                    <Briefcase size={15} weight="duotone" />
                    <span>Full-time</span>
                  </div>
                  <div className="job-detail-item">
                    <House size={15} weight="duotone" />
                    <span>{job.work_type === "remote" ? "Remote" : job.work_type === "hybrid" ? "Hybrid" : "On Site"}</span>
                  </div>
                  <div className="job-detail-item">
                    <GraduationCap size={15} weight="duotone" />
                    <span>{job.experience_level === "internship" ? "Internship" : "Entry, New Grad"}</span>
                  </div>
                  {job.salary_range && !job.salary_range.startsWith("{") && (
                    <div className="job-detail-item">
                      <Money size={15} weight="duotone" />
                      <span className="salary">{job.salary_range}</span>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="job-card-footer" onClick={(e) => e.stopPropagation()}>
                  <span className="applicant-text">
                    {job.applicant_count
                      ? <><Users size={14} weight="duotone" /> {job.applicant_count}+ applicants</>
                      : ""}
                  </span>
                  <div className="job-actions">
                    <button className="btn-icon" title="Not interested">
                      <ThumbsDown size={15} weight="bold" />
                    </button>
                    <button className="btn-icon" title="Share">
                      <ShareNetwork size={15} weight="bold" />
                    </button>
                    <button
                      className="btn-ai"
                      onClick={(e) => { e.stopPropagation(); setRewriteJob({ id: job.id, title: job.title, company: job.company, url: job.url }); }}
                    >
                      <MagicWand size={15} weight="fill" /> Custom Resume
                    </button>
                    <button
                      className="btn-ai"
                      onClick={(e) => { e.stopPropagation(); setCoverJob({ id: job.id, title: job.title, company: job.company, url: job.url }); }}
                    >
                      <Envelope size={15} weight="fill" /> Cover Letter
                    </button>
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-apply"
                      onClick={() => registerApplyClick({ id: job.id, title: job.title, company: job.company })}
                    >
                      APPLY WITH AUTOFILL
                    </a>
                  </div>
                </div>
              </div>

              {/* Match Score Badge */}
              {job.match_score > 0 && (
                <div className="match-score-badge">
                  <div className="match-circle-sm">
                    <svg viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="#e3e8ee" strokeWidth="8" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="#533afd" strokeWidth="8"
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
                <CaretLeft size={14} weight="bold" /> Previous
              </button>
              <span className="page-indicator">Page {page}</span>
              <button
                className="btn-outline"
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <CaretRight size={14} weight="bold" />
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
