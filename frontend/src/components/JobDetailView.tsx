import { useState, useEffect, useRef } from "react";
import { resolveLogoUrl } from "../lib/companyLogo";
import {
  X,
  MapPin,
  House,
  Flag,
  GraduationCap,
  CurrencyDollar,
  GithubLogo,
  LinkedinLogo,
  PaperPlaneTilt,
  ArrowSquareOut,
  Users,
  ClipboardText,
  Star,
  Gift,
  Buildings,
  Code,
  ListBullets,
  Info,
  FileText,
  type Icon,
} from "@phosphor-icons/react";
import api from "../auth/api";

// Maps the client-side parser's icon keys to Phosphor icon components
const SECTION_ICONS: Record<string, Icon> = {
  "clipboard-list": ClipboardText,
  "graduation-cap": GraduationCap,
  star: Star,
  gift: Gift,
  building: Buildings,
  code: Code,
  list: ListBullets,
  "info-circle": Info,
};

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
  company_domain?: string;
  company_url?: string;
  work_type?: string;
  role_category?: string;
  country?: string;
  experience_level?: string;
  posted_date?: string | null;
}

function getMatchColor(score: number): string {
  if (score >= 80) return "#533afd";
  if (score >= 60) return "#f59e0b";
  return "#64748d";
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
  /** "apply" when arriving from an email "APPLY NOW" deep-link — surfaces the CTA. */
  autoAction?: string | null;
  /** Called once the autoAction has been handled so it doesn't re-fire. */
  onConsumeAutoAction?: () => void;
}

/**
 * Fast client-side parser that structures job descriptions into sections
 * using regex/heuristics. No AI call needed — instant results.
 */
function parseDescriptionClientSide(rawDesc: string): any | null {
  // Clean HTML tags and decode entities
  let text = rawDesc
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Section header patterns
  const sectionPatterns = [
    { regex: /(?:^|\n)\s*(?:key\s+)?responsibilities?\s*[:\-]?\s*\n/i, title: "Responsibilities", icon: "clipboard-list" },
    { regex: /(?:^|\n)\s*(?:what you(?:'ll| will) do|your role|the role|about the role|job duties|duties)\s*[:\-]?\s*\n/i, title: "Responsibilities", icon: "clipboard-list" },
    { regex: /(?:^|\n)\s*(?:requirements?|qualifications?|what we(?:'re| are) looking for|who you are|must have|minimum qualifications?)\s*[:\-]?\s*\n/i, title: "Qualifications", icon: "graduation-cap" },
    { regex: /(?:^|\n)\s*(?:required skills?|required experience|basic qualifications?)\s*[:\-]?\s*\n/i, title: "Required Qualifications", icon: "graduation-cap" },
    { regex: /(?:^|\n)\s*(?:preferred|nice to have|bonus|preferred qualifications?|desired)\s*[:\-]?\s*\n/i, title: "Preferred Qualifications", icon: "star" },
    { regex: /(?:^|\n)\s*(?:benefits?|perks?|what we offer|compensation|why join us|why work here)\s*[:\-]?\s*\n/i, title: "Benefits", icon: "gift" },
    { regex: /(?:^|\n)\s*(?:about (?:us|the (?:company|team))|who we are|company overview)\s*[:\-]?\s*\n/i, title: "About the Company", icon: "building" },
    { regex: /(?:^|\n)\s*(?:tech(?:nology)? stack|technologies|tools)\s*[:\-]?\s*\n/i, title: "Tech Stack", icon: "code" },
  ];

  // Find all section boundaries
  const sections: { title: string; icon: string; start: number; end?: number }[] = [];

  for (const pattern of sectionPatterns) {
    const match = text.match(pattern.regex);
    if (match && match.index !== undefined) {
      const start = match.index + match[0].length;
      // Avoid duplicate section titles
      if (!sections.find(s => s.title === pattern.title && Math.abs(s.start - start) < 50)) {
        sections.push({ title: pattern.title, icon: pattern.icon, start });
      }
    }
  }

  // If we found fewer than 2 sections, try a simpler bullet-point based approach
  if (sections.length < 2) {
    // Try to split by bullet points into a single "Description" section
    const bullets = text.split("\n")
      .map(l => l.replace(/^[\s•\-\*·▪►●○◦‣⁃]+/, "").trim())
      .filter(l => l.length > 10 && l.length < 300);

    if (bullets.length >= 3) {
      // Extract skills from the text
      const skills = extractSkills(text);
      return {
        sections: [{ title: "Job Description", icon: "list", items: bullets.slice(0, 20) }],
        skills,
      };
    }
    return null; // Can't parse, show raw
  }

  // Sort sections by position
  sections.sort((a, b) => a.start - b.start);

  // Set end boundaries
  for (let i = 0; i < sections.length; i++) {
    sections[i].end = i < sections.length - 1 ? sections[i + 1].start : text.length;
  }

  // Extract items from each section
  const result: any[] = [];
  for (const section of sections) {
    const sectionText = text.slice(section.start, section.end);
    const items = sectionText.split("\n")
      .map(l => l.replace(/^[\s•\-\*·▪►●○◦‣⁃\d.)+]+/, "").trim())
      .filter(l => l.length > 5 && l.length < 500);

    if (items.length > 0) {
      result.push({ title: section.title, icon: section.icon, items: items.slice(0, 15) });
    }
  }

  if (result.length === 0) return null;

  // Also add intro text (before first section) if meaningful
  const introEnd = sections[0].start;
  if (introEnd > 50) {
    const introText = text.slice(0, introEnd).trim();
    const introLines = introText.split("\n").map(l => l.trim()).filter(l => l.length > 10);
    if (introLines.length > 0 && introLines.length <= 5) {
      result.unshift({ title: "Overview", icon: "info-circle", items: introLines });
    }
  }

  const skills = extractSkills(text);
  return { sections: result, skills };
}

function extractSkills(text: string): string[] {
  const knownSkills = [
    "Python", "Java", "JavaScript", "TypeScript", "C++", "C#", "Go", "Rust", "Ruby", "PHP", "Swift", "Kotlin",
    "React", "Angular", "Vue", "Node.js", "Django", "Flask", "Spring", "Express", "Next.js",
    "AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "Jenkins", "CI/CD",
    "SQL", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "DynamoDB", "Cassandra",
    "REST", "GraphQL", "gRPC", "Microservices", "Kafka", "RabbitMQ",
    "Machine Learning", "Deep Learning", "TensorFlow", "PyTorch", "NLP",
    "Git", "Linux", "Agile", "Scrum", "Jira",
    "HTML", "CSS", "Tailwind", "SASS",
    "Figma", "Sketch",
    "Spark", "Hadoop", "Airflow", "dbt", "Snowflake", "BigQuery",
    "iOS", "Android", "React Native", "Flutter",
  ];

  const found: string[] = [];
  const lowerText = text.toLowerCase();
  for (const skill of knownSkills) {
    if (lowerText.includes(skill.toLowerCase())) {
      found.push(skill);
    }
    if (found.length >= 12) break;
  }
  return found;
}

export default function JobDetailView({ job, onClose, autoAction, onConsumeAutoAction }: Props) {
  const [breakdown, setBreakdown] = useState<MatchBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [applyUrl, setApplyUrl] = useState(job.url);
  const applyRef = useRef<HTMLAnchorElement>(null);
  const [description, setDescription] = useState(job.description || "");
  const [companyLogo, setCompanyLogo] = useState(job.company_logo || "");
  const [fetchingDetails, setFetchingDetails] = useState(false);
  const [structured, setStructured] = useState<any>(null);

  // When opened from an email "APPLY NOW" deep-link (?action=apply), bring the
  // apply CTA into view and flash it so applying is one obvious click rather
  // than a hunt through the panel.
  useEffect(() => {
    if (autoAction !== "apply") return;
    const el = applyRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cta-flash");
      el.focus({ preventScroll: true });
      window.setTimeout(() => el.classList.remove("cta-flash"), 2400);
    }
    onConsumeAutoAction?.();
  }, [autoAction, onConsumeAutoAction]);

  useEffect(() => {
    let cancelled = false;

    setApplyUrl(job.url);
    setDescription(job.description || "");
    setCompanyLogo(job.company_logo || "");
    setBreakdown(null);
    setError("");
    setStructured(null);

    if (job.description && job.description.length > 50) {
      const parsed = parseDescriptionClientSide(job.description);
      if (parsed) setStructured(parsed);
    }

    if (job.match_score > 0 && job.experience_score > 0) {
      setBreakdown({
        experience_score: job.experience_score,
        skill_score: job.skill_score,
        industry_score: job.industry_score,
        overall_score: job.match_score,
        match_label: job.match_label || getMatchLabel(job.match_score),
      });
    }

    (async () => {
      const fetchedDescription = await fetchJobDetails();
      if (cancelled) return;

      const effectiveDescription = fetchedDescription || job.description || "";
      if (effectiveDescription.length > 50) {
        const parsed = parseDescriptionClientSide(effectiveDescription);
        if (parsed) setStructured(parsed);
      }

      if (job.match_score === 0 && effectiveDescription.length > 50) {
        triggerAnalysis();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job.id]);

  useEffect(() => {
    if (description && description.length > 50 && !structured) {
      const parsed = parseDescriptionClientSide(description);
      if (parsed) setStructured(parsed);
    }
  }, [description]);

  async function fetchJobDetails(): Promise<string> {
    if (job.description && job.description.length > 50) return job.description;
    setFetchingDetails(true);
    try {
      const { data } = await api.post(`/jobs/${job.id}/fetch-details`);
      if (data.apply_url) setApplyUrl(data.apply_url);
      if (data.description) setDescription(data.description);
      if (data.company_logo) setCompanyLogo(data.company_logo);
      return data.description || "";
    } catch {
      // Keep original URL if fetch fails
    } finally {
      setFetchingDetails(false);
    }
    return "";
  }

  async function triggerAnalysis() {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.post<MatchBreakdown>(`/ai/match-breakdown/${job.id}`);
      setBreakdown(data);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 503) {
        setError("AI analysis unavailable. Connect Gemini or Ollama to enable match scoring.");
      } else if (status === 422) {
        setError("Could not fetch a job description to analyze. Try opening the apply link directly.");
      } else if (status) {
        setError("Failed to analyze job match.");
      } else {
        setError("Failed to connect to the server.");
      }
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
          <X size={18} weight="bold" />
        </button>
      )}

      {/* Header section */}
      <div className="job-detail-header-section">
        <div className="job-detail-company-row">
          {(() => {
            const logoUrl = resolveLogoUrl({
              company: job.company,
              company_logo: companyLogo || job.company_logo,
              company_domain: job.company_domain,
              company_url: job.company_url,
            });
            return logoUrl ? (
              <img
                src={logoUrl}
                alt={`${job.company} logo`}
                className="detail-company-logo"
                loading="lazy"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  img.style.display = "none";
                  (img.nextElementSibling as HTMLElement)?.classList.remove("hidden-logo");
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
              <MapPin size={14} weight="duotone" /> {job.location}
            </span>
          )}
          {job.work_type && (
            <span className="detail-tag">
              <House size={14} weight="duotone" /> {formatWorkType(job.work_type)}
            </span>
          )}
          {job.country && (
            <span className="detail-tag">
              <Flag size={14} weight="duotone" /> {formatCountry(job.country)}
            </span>
          )}
          {job.experience_level && (
            <span className="detail-tag detail-tag-highlight">
              <GraduationCap size={14} weight="duotone" /> {formatExperienceLevel(job.experience_level)}
            </span>
          )}
          {job.salary_range && (
            <span className="detail-tag detail-tag-salary">
              <CurrencyDollar size={14} weight="duotone" /> {job.salary_range}
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
                <><GithubLogo size={14} weight="fill" /> GitHub</>
              ) : (
                <><LinkedinLogo size={14} weight="fill" /> LinkedIn</>
              )}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="job-detail-actions">
          <a ref={applyRef} href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-apply-detail">
            <PaperPlaneTilt size={16} weight="fill" /> Apply with Autofill
          </a>
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-outline-detail">
            <ArrowSquareOut size={16} weight="bold" /> View Original Post
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
                {structured.sections.map((section: any, i: number) => {
                  const SectionIcon = SECTION_ICONS[section.icon] || ListBullets;
                  return (
                  <div key={i} className="desc-section">
                    <h3 className="desc-section-title">
                      <SectionIcon size={16} weight="duotone" /> {section.title}
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
                  );
                })}
              </div>
            ) : description ? (
              <div className="description-content" dangerouslySetInnerHTML={{ __html: description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n') }} />
            ) : fetchingDetails ? (
              <div className="description-empty">
                <div className="description-empty-icon">
                  <FileText size={32} weight="duotone" />
                </div>
                <p className="description-empty-title">Fetching job description…</p>
                <p className="description-empty-subtitle">
                  Pulling details from the company apply page.
                </p>
              </div>
            ) : (
              <div className="description-empty">
                <div className="description-empty-icon">
                  <FileText size={32} weight="duotone" />
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
              <Users size={15} weight="duotone" />
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
