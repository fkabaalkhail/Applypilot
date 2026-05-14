import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useAuthFetch } from "../hooks/useAuthFetch";
import ResumePreview from "../components/ResumePreview";
import "../resume.css";

/* ===== TypeScript Interfaces ===== */

interface ExperienceItem {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface EducationItem {
  school: string;
  degree: string;
  start_date: string;
  end_date: string;
  gpa: string;
  achievements: string[];
  coursework: string[];
}

interface ProjectItem {
  name: string;
  link: string;
  organization: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface ResumeProfile {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  other_link: string;
  skills: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  projects: ProjectItem[];
  technologies: Record<string, string[]>;
}

interface AnalysisReport {
  overall_grade: string;
  urgent_fix_count: number;
  critical_fix_count: number;
  optional_fix_count: number;
  summary: string;
  highlights: string[];
}

interface ResumeDetailData {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  profile: ResumeProfile;
  analysis_report: AnalysisReport | null;
  created_at: string;
  updated_at: string;
}

/* ===== Toast Component ===== */

interface ToastProps {
  message: string;
  type: "success" | "error";
}

function Toast({ message, type }: ToastProps) {
  return (
    <div
      style={{
        position: "fixed",
        top: "1.5rem",
        right: "1.5rem",
        padding: "0.75rem 1.25rem",
        borderRadius: "8px",
        fontSize: "0.875rem",
        fontWeight: 600,
        color: type === "success" ? "#166534" : "#991b1b",
        background: type === "success" ? "#dcfce7" : "#fee2e2",
        border: `1px solid ${type === "success" ? "#86efac" : "#fca5a5"}`,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        zIndex: 9999,
      }}
    >
      {message}
    </div>
  );
}

/* ===== Main Component ===== */

export default function ResumeDetail() {
  const { id } = useParams<{ id: string }>();
  const [resume, setResume] = useState<ResumeDetailData | null>(null);
  const [profile, setProfile] = useState<ResumeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastProps | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisReport, setAnalysisReport] = useState<AnalysisReport | null>(null);
  const authFetch = useAuthFetch();

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    async function fetchResume() {
      try {
        setLoading(true);
        setError(null);
        const res = await authFetch(`/resumes/${id}`);
        if (!res.ok) {
          throw new Error(`Failed to load resume (status ${res.status})`);
        }
        const data: ResumeDetailData = await res.json();
        setResume(data);
        setProfile({ ...data.profile });
        setAnalysisReport(data.analysis_report || null);
      } catch (err: any) {
        setError(err.message || "Could not load resume.");
      } finally {
        setLoading(false);
      }
    }
    if (id) fetchResume();
  }, [id, authFetch]);

  const handleSave = useCallback(async () => {
    if (!profile || !id) return;
    setSaving(true);
    try {
      const res = await authFetch(`/resumes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.detail || `Save failed (status ${res.status})`);
      }
      showToast("Resume saved successfully!", "success");
    } catch (err: any) {
      showToast(err.message || "Failed to save resume.", "error");
    } finally {
      setSaving(false);
    }
  }, [profile, id, showToast, authFetch]);

  const handleAnalyze = useCallback(async () => {
    if (!id) return;
    setAnalyzing(true);
    try {
      const res = await authFetch(`/resumes/${id}/analyze`, { method: "POST" });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.detail || "Analysis could not be completed");
      }
      const report: AnalysisReport = await res.json();
      setAnalysisReport(report);
      setResume((prev) => prev ? { ...prev, analysis_report: report } : prev);
    } catch (err: any) {
      showToast(err.message || "Analysis could not be completed", "error");
    } finally {
      setAnalyzing(false);
    }
  }, [id, showToast, authFetch]);

  const handleSetPrimary = useCallback(async () => {
    if (!id) return;
    try {
      const res = await authFetch(`/resumes/${id}/primary`, { method: "PUT" });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.detail || "Failed to set as primary");
      }
      setResume((prev) => prev ? { ...prev, is_primary: true } : prev);
      showToast("Resume set as primary!", "success");
    } catch (err: any) {
      showToast(err.message || "Failed to set as primary.", "error");
    }
  }, [id, showToast, authFetch]);

  const getGradeClass = (grade: string): string => {
    switch (grade) {
      case "EXCELLENT": return "grade-excellent";
      case "GOOD": return "grade-good";
      case "FAIR": return "grade-fair";
      default: return "grade-fair";
    }
  };

  /* ===== Profile Field Updaters ===== */

  const updateField = useCallback((field: keyof ResumeProfile, value: string) => {
    setProfile((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  const updateEducation = useCallback((index: number, field: keyof EducationItem, value: string | string[]) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const education = [...prev.education];
      education[index] = { ...education[index], [field]: value };
      return { ...prev, education };
    });
  }, []);

  const updateExperience = useCallback((index: number, field: keyof ExperienceItem, value: string | string[]) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const experience = [...prev.experience];
      experience[index] = { ...experience[index], [field]: value };
      return { ...prev, experience };
    });
  }, []);

  const updateExperienceBullet = useCallback((expIndex: number, bulletIndex: number, value: string) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const experience = [...prev.experience];
      const bullets = [...experience[expIndex].bullets];
      bullets[bulletIndex] = value;
      experience[expIndex] = { ...experience[expIndex], bullets };
      return { ...prev, experience };
    });
  }, []);

  const addExperienceBullet = useCallback((expIndex: number) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const experience = [...prev.experience];
      const bullets = [...experience[expIndex].bullets, ""];
      experience[expIndex] = { ...experience[expIndex], bullets };
      return { ...prev, experience };
    });
  }, []);

  const updateProject = useCallback((index: number, field: keyof ProjectItem, value: string | string[]) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const projects = [...prev.projects];
      projects[index] = { ...projects[index], [field]: value };
      return { ...prev, projects };
    });
  }, []);

  const updateProjectBullet = useCallback((projIndex: number, bulletIndex: number, value: string) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const projects = [...prev.projects];
      const bullets = [...projects[projIndex].bullets];
      bullets[bulletIndex] = value;
      projects[projIndex] = { ...projects[projIndex], bullets };
      return { ...prev, projects };
    });
  }, []);

  const addProjectBullet = useCallback((projIndex: number) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const projects = [...prev.projects];
      const bullets = [...projects[projIndex].bullets, ""];
      projects[projIndex] = { ...projects[projIndex], bullets };
      return { ...prev, projects };
    });
  }, []);

  const addEducation = useCallback(() => {
    setProfile((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        education: [
          ...prev.education,
          { school: "", degree: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] },
        ],
      };
    });
  }, []);

  const addExperience = useCallback(() => {
    setProfile((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        experience: [
          ...prev.experience,
          { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [] },
        ],
      };
    });
  }, []);

  const addProject = useCallback(() => {
    setProfile((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        projects: [
          ...prev.projects,
          { name: "", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [] },
        ],
      };
    });
  }, []);

  /* ===== Render ===== */

  if (loading) {
    return (
      <div className="resume-detail">
        <div className="settings-loading">Loading resume...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="resume-detail">
        <div className="settings-error">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!profile || !resume) return null;

  return (
    <div className="resume-detail">
      {toast && <Toast message={toast.message} type={toast.type} />}

      <div className="resume-detail-header">
        <h1>{resume.name}</h1>
        {resume.is_primary && <span className="badge-primary">PRIMARY</span>}
      </div>

      <div className="resume-detail-split">
        {/* Left: Editor */}
        <div className="resume-detail-editor">

      {/* Analysis Report Section */}
      <div className="section-card" data-testid="analysis-report-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, border: "none", paddingBottom: 0 }}>Analysis</h3>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {resume.is_primary ? (
              <span className="badge-primary">PRIMARY</span>
            ) : (
              <button className="btn-pill" type="button" onClick={handleSetPrimary}>
                Set as Primary
              </button>
            )}
            <button
              className="btn-pill btn-pill-accent"
              type="button"
              onClick={handleAnalyze}
              disabled={analyzing}
            >
              {analyzing ? "Analyzing..." : "Analyze"}
            </button>
          </div>
        </div>

        {analyzing && (
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: "80%" }} />
          </div>
        )}

        {analysisReport && !analyzing && (
          <div className="analysis-report">
            <span className={`grade-badge ${getGradeClass(analysisReport.overall_grade)}`}>
              {analysisReport.overall_grade}
            </span>

            <div className="analysis-counts">
              <span className="analysis-count-item">
                <strong>{analysisReport.urgent_fix_count}</strong> Urgent
              </span>
              <span className="analysis-count-item">
                <strong>{analysisReport.critical_fix_count}</strong> Critical
              </span>
              <span className="analysis-count-item">
                <strong>{analysisReport.optional_fix_count}</strong> Optional
              </span>
            </div>

            <p className="analysis-summary">{analysisReport.summary}</p>

            <ul className="analysis-highlights">
              {analysisReport.highlights.map((highlight, i) => (
                <li key={i}>{highlight}</li>
              ))}
            </ul>

            <button
              className="btn-pill btn-pill-accent"
              type="button"
              onClick={() => document.querySelector('.section-card')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Begin Improvements Now
            </button>
          </div>
        )}
      </div>

      {/* Header Section Card */}
      <div className="section-card">
        <h3>Personal Information</h3>
        <div className="field-grid">
          <div>
            <label>Full Name</label>
            <input
              type="text"
              value={profile.name}
              onChange={(e) => updateField("name", e.target.value)}
            />
          </div>
          <div>
            <label>Email</label>
            <input
              type="email"
              value={profile.email}
              onChange={(e) => updateField("email", e.target.value)}
            />
          </div>
          <div>
            <label>Phone</label>
            <input
              type="tel"
              value={profile.phone}
              onChange={(e) => updateField("phone", e.target.value)}
            />
          </div>
          <div>
            <label>Location</label>
            <input
              type="text"
              value={profile.location}
              onChange={(e) => updateField("location", e.target.value)}
            />
          </div>
          <div>
            <label>LinkedIn URL</label>
            <input
              type="url"
              value={profile.linkedin_url}
              onChange={(e) => updateField("linkedin_url", e.target.value)}
            />
          </div>
          <div>
            <label>GitHub URL</label>
            <input
              type="url"
              value={profile.github_url}
              onChange={(e) => updateField("github_url", e.target.value)}
            />
          </div>
          <div>
            <label>Other Link</label>
            <input
              type="url"
              value={profile.other_link}
              onChange={(e) => updateField("other_link", e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Education Section Card */}
      <div className="section-card">
        <h3>Education</h3>
        {profile.education.map((edu, i) => (
          <div key={i} style={{ marginBottom: "1.25rem", paddingBottom: "1rem", borderBottom: i < profile.education.length - 1 ? "1px solid var(--border-light, #eee)" : "none" }}>
            <div className="field-grid">
              <div>
                <label>School</label>
                <input
                  type="text"
                  value={edu.school}
                  onChange={(e) => updateEducation(i, "school", e.target.value)}
                />
              </div>
              <div>
                <label>Degree</label>
                <input
                  type="text"
                  value={edu.degree}
                  onChange={(e) => updateEducation(i, "degree", e.target.value)}
                />
              </div>
              <div>
                <label>Start Date</label>
                <input
                  type="text"
                  value={edu.start_date}
                  onChange={(e) => updateEducation(i, "start_date", e.target.value)}
                />
              </div>
              <div>
                <label>End Date</label>
                <input
                  type="text"
                  value={edu.end_date}
                  onChange={(e) => updateEducation(i, "end_date", e.target.value)}
                />
              </div>
              <div>
                <label>GPA</label>
                <input
                  type="text"
                  value={edu.gpa}
                  onChange={(e) => updateEducation(i, "gpa", e.target.value)}
                />
              </div>
            </div>
            <div>
              <label>Achievements</label>
              {edu.achievements.map((ach, j) => (
                <input
                  key={j}
                  type="text"
                  value={ach}
                  onChange={(e) => {
                    const achievements = [...edu.achievements];
                    achievements[j] = e.target.value;
                    updateEducation(i, "achievements", achievements);
                  }}
                />
              ))}
              <button
                className="btn-pill"
                type="button"
                onClick={() => updateEducation(i, "achievements", [...edu.achievements, ""])}
              >
                + Achievement
              </button>
            </div>
            <div style={{ marginTop: "0.5rem" }}>
              <label>Coursework</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.5rem" }}>
                {edu.coursework.map((course, j) => (
                  <span key={j} className="skill-tag">{course}</span>
                ))}
              </div>
              <input
                type="text"
                placeholder="Add coursework (press Enter)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      updateEducation(i, "coursework", [...edu.coursework, val]);
                      (e.target as HTMLInputElement).value = "";
                    }
                  }
                }}
              />
            </div>
          </div>
        ))}
        <button className="btn-pill" type="button" onClick={addEducation}>
          + Add Education
        </button>
      </div>

      {/* Experience Section Card */}
      <div className="section-card">
        <h3>Experience</h3>
        {profile.experience.map((exp, i) => (
          <div key={i} style={{ marginBottom: "1.25rem", paddingBottom: "1rem", borderBottom: i < profile.experience.length - 1 ? "1px solid var(--border-light, #eee)" : "none" }}>
            <div className="field-grid">
              <div>
                <label>Company</label>
                <input
                  type="text"
                  value={exp.company}
                  onChange={(e) => updateExperience(i, "company", e.target.value)}
                />
              </div>
              <div>
                <label>Title</label>
                <input
                  type="text"
                  value={exp.title}
                  onChange={(e) => updateExperience(i, "title", e.target.value)}
                />
              </div>
              <div>
                <label>Location</label>
                <input
                  type="text"
                  value={exp.location}
                  onChange={(e) => updateExperience(i, "location", e.target.value)}
                />
              </div>
              <div>
                <label>Start Date</label>
                <input
                  type="text"
                  value={exp.start_date}
                  onChange={(e) => updateExperience(i, "start_date", e.target.value)}
                />
              </div>
              <div>
                <label>End Date</label>
                <input
                  type="text"
                  value={exp.end_date}
                  onChange={(e) => updateExperience(i, "end_date", e.target.value)}
                />
              </div>
            </div>
            <div>
              <label>Bullet Points</label>
              {exp.bullets.map((bullet, j) => (
                <input
                  key={j}
                  type="text"
                  value={bullet}
                  onChange={(e) => updateExperienceBullet(i, j, e.target.value)}
                />
              ))}
              <button
                className="btn-pill"
                type="button"
                onClick={() => addExperienceBullet(i)}
              >
                + Bullet Points
              </button>
            </div>
          </div>
        ))}
        <button className="btn-pill" type="button" onClick={addExperience}>
          + Add Experience
        </button>
      </div>

      {/* Projects Section Card */}
      <div className="section-card">
        <h3>Projects</h3>
        {profile.projects.map((proj, i) => (
          <div key={i} style={{ marginBottom: "1.25rem", paddingBottom: "1rem", borderBottom: i < profile.projects.length - 1 ? "1px solid var(--border-light, #eee)" : "none" }}>
            <div className="field-grid">
              <div>
                <label>Project Name</label>
                <input
                  type="text"
                  value={proj.name}
                  onChange={(e) => updateProject(i, "name", e.target.value)}
                />
              </div>
              <div>
                <label>Link</label>
                <input
                  type="url"
                  value={proj.link}
                  onChange={(e) => updateProject(i, "link", e.target.value)}
                />
              </div>
              <div>
                <label>Organization</label>
                <input
                  type="text"
                  value={proj.organization}
                  onChange={(e) => updateProject(i, "organization", e.target.value)}
                />
              </div>
              <div>
                <label>Location</label>
                <input
                  type="text"
                  value={proj.location}
                  onChange={(e) => updateProject(i, "location", e.target.value)}
                />
              </div>
              <div>
                <label>Start Date</label>
                <input
                  type="text"
                  value={proj.start_date}
                  onChange={(e) => updateProject(i, "start_date", e.target.value)}
                />
              </div>
              <div>
                <label>End Date</label>
                <input
                  type="text"
                  value={proj.end_date}
                  onChange={(e) => updateProject(i, "end_date", e.target.value)}
                />
              </div>
            </div>
            <div>
              <label>Bullet Points</label>
              {proj.bullets.map((bullet, j) => (
                <input
                  key={j}
                  type="text"
                  value={bullet}
                  onChange={(e) => updateProjectBullet(i, j, e.target.value)}
                />
              ))}
              <button
                className="btn-pill"
                type="button"
                onClick={() => addProjectBullet(i)}
              >
                + Bullet Points
              </button>
            </div>
          </div>
        ))}
        <button className="btn-pill" type="button" onClick={addProject}>
          + Add Project
        </button>
      </div>

      {/* Technologies Section Card */}
      <div className="section-card">
        <h3>Technologies</h3>
        {Object.entries(profile.technologies).map(([category, skills]) => (
          <div key={category} style={{ marginBottom: "1rem" }}>
            <label>{category}</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.5rem" }}>
              {skills.map((skill, j) => (
                <span
                  key={j}
                  className={`skill-tag category-${category.toLowerCase()}`}
                >
                  {skill}
                </span>
              ))}
            </div>
            <input
              type="text"
              placeholder={`Add ${category} skill (press Enter)`}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    setProfile((prev) => {
                      if (!prev) return prev;
                      const technologies = { ...prev.technologies };
                      technologies[category] = [...(technologies[category] || []), val];
                      return { ...prev, technologies };
                    });
                    (e.target as HTMLInputElement).value = "";
                  }
                }
              }}
            />
          </div>
        ))}
        <button
          className="btn-pill"
          type="button"
          onClick={() => {
            const categoryName = prompt("Enter category name:");
            if (categoryName && categoryName.trim()) {
              setProfile((prev) => {
                if (!prev) return prev;
                const technologies = { ...prev.technologies };
                if (!technologies[categoryName.trim()]) {
                  technologies[categoryName.trim()] = [];
                }
                return { ...prev, technologies };
              });
            }
          }}
        >
          + Add Category
        </button>
      </div>

      {/* Save Footer */}
      <div className="save-footer">
        <button
          className="btn-pill btn-pill-accent"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

        </div>
        {/* Right: Live Preview */}
        <div className="resume-detail-preview">
          <ResumePreview profile={profile} originalProfile={resume.profile} />
        </div>
      </div>
    </div>
  );
}
