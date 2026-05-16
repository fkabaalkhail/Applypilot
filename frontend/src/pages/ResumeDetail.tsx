import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import api from "../auth/api";
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

type EditingSection = "personal" | "education" | "experience" | "projects" | "technologies" | null;

/* ===== Toast Component ===== */

interface ToastProps {
  message: string;
  type: "success" | "error";
}

function Toast({ message, type }: ToastProps) {
  return (
    <div className={`profile-toast profile-toast-${type}`}>
      {message}
    </div>
  );
}

/* ===== Pencil Icon ===== */

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
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
  const [showPreview, setShowPreview] = useState(false);
  const [editingSection, setEditingSection] = useState<EditingSection>(null);

  /* ===== Toast helper ===== */

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  /* ===== Export handler ===== */

  const handleExport = useCallback(() => {
    if (!profile) return;
    let text = `${profile.name}\n${profile.email} | ${profile.phone} | ${profile.location}\n`;
    if (profile.linkedin_url) text += `LinkedIn: ${profile.linkedin_url}\n`;
    if (profile.github_url) text += `GitHub: ${profile.github_url}\n`;
    text += "\n--- EDUCATION ---\n";
    for (const edu of profile.education) {
      text += `${edu.school} | ${edu.degree} | ${edu.start_date} - ${edu.end_date}\n`;
      if (edu.gpa) text += `GPA: ${edu.gpa}\n`;
    }
    text += "\n--- EXPERIENCE ---\n";
    for (const exp of profile.experience) {
      text += `${exp.title} | ${exp.company} | ${exp.location} | ${exp.start_date} - ${exp.end_date || "Present"}\n`;
      for (const b of exp.bullets) { if (b.trim()) text += `• ${b}\n`; }
      text += "\n";
    }
    text += "--- SKILLS ---\n";
    text += profile.skills.join(", ") + "\n";
    text += "\n--- PROJECTS ---\n";
    for (const proj of profile.projects) {
      text += `${proj.name}${proj.organization ? ` | ${proj.organization}` : ""}\n`;
      for (const b of proj.bullets) { if (b.trim()) text += `• ${b}\n`; }
      text += "\n";
    }
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${profile.name || "resume"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [profile]);

  /* ===== Fetch resume ===== */

  useEffect(() => {
    async function fetchResume() {
      try {
        setLoading(true);
        setError(null);
        const res = await api.get(`/resumes/${id}`);
        const data: ResumeDetailData = res.data;
        setResume(data);
        setProfile({ ...data.profile });
        setAnalysisReport(data.analysis_report || null);
      } catch (err: any) {
        setError(err.response?.data?.detail || err.message || "Could not load resume.");
      } finally {
        setLoading(false);
      }
    }
    if (id) fetchResume();
  }, [id]);

  /* ===== Save ===== */

  const handleSave = useCallback(async () => {
    if (!profile || !id) return;
    setSaving(true);
    try {
      await api.put(`/resumes/${id}`, { profile });
      setEditingSection(null);
      showToast("Resume saved successfully!", "success");
    } catch (err: any) {
      showToast(err.response?.data?.detail || err.message || "Failed to save resume.", "error");
    } finally {
      setSaving(false);
    }
  }, [profile, id, showToast]);

  /* ===== Analyze ===== */

  const handleAnalyze = useCallback(async () => {
    if (!id) return;
    setAnalyzing(true);
    try {
      const res = await api.post(`/resumes/${id}/analyze`);
      const report: AnalysisReport = res.data;
      setAnalysisReport(report);
      setResume((prev) => prev ? { ...prev, analysis_report: report } : prev);
    } catch (err: any) {
      showToast(err.response?.data?.detail || err.message || "Analysis could not be completed", "error");
    } finally {
      setAnalyzing(false);
    }
  }, [id, showToast]);

  /* ===== Set Primary ===== */

  const handleSetPrimary = useCallback(async () => {
    if (!id) return;
    try {
      await api.put(`/resumes/${id}/primary`);
      setResume((prev) => prev ? { ...prev, is_primary: true } : prev);
      showToast("Resume set as primary!", "success");
    } catch (err: any) {
      showToast(err.response?.data?.detail || err.message || "Failed to set as primary.", "error");
    }
  }, [id, showToast]);

  /* ===== Grade helper ===== */

  const getGradeClass = (grade: string): string => {
    switch (grade) {
      case "EXCELLENT": return "grade-excellent";
      case "GOOD": return "grade-good";
      case "FAIR": return "grade-fair";
      default: return "grade-fair";
    }
  };

  /* ===== Section edit toggle ===== */

  function toggleEdit(section: EditingSection) {
    setEditingSection((prev) => (prev === section ? null : section));
  }

  /* ===== Loading / Error states ===== */

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

  /* ===== Render ===== */

  return (
    <div className="resume-detail">
      {toast && <Toast message={toast.message} type={toast.type} />}

      {/* Header */}
      <div className="resume-detail-top-header">
        <div className="resume-detail-title-row">
          <div>
            <h1 className="resume-detail-name">{resume.name}</h1>
            {resume.is_primary && <span className="badge-primary"><i className="fa-solid fa-star"></i> Primary</span>}
          </div>
          <div className="resume-detail-actions">
            <button className="btn-secondary" onClick={() => setShowPreview(true)}>
              <i className="fa-solid fa-eye"></i> Preview
            </button>
            <button className="btn-secondary" onClick={handleExport}>
              <i className="fa-solid fa-download"></i> Export
            </button>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {showPreview && (
        <div className="preview-modal-overlay" onClick={() => setShowPreview(false)}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <button className="preview-modal-close" onClick={() => setShowPreview(false)}>×</button>
            <ResumePreview profile={profile} originalProfile={resume.profile} />
          </div>
        </div>
      )}

      {/* Analysis Section */}
      <section className="resume-section-card" data-testid="analysis-report-section">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-chart-line"></i> Analysis</h2>
          <div className="resume-section-actions">
            {resume.is_primary ? (
              <span className="badge-primary"><i className="fa-solid fa-star"></i> Primary</span>
            ) : (
              <button className="btn-secondary" type="button" onClick={handleSetPrimary}>
                Set as Primary
              </button>
            )}
            <button
              className="btn-primary"
              type="button"
              onClick={handleAnalyze}
              disabled={analyzing}
            >
              {analyzing ? "Analyzing..." : "Run Analysis"}
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
          </div>
        )}
      </section>

      {/* Personal Information */}
      <section className="resume-section-card">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-user"></i> Personal Information</h2>
          <button className="btn-secondary" onClick={() => toggleEdit("personal")} aria-label="Edit personal info">
            <PencilIcon /> {editingSection === "personal" ? "Done" : "Edit"}
          </button>
        </div>
        {editingSection === "personal" ? (
          <div className="profile-form-grid">
            <div className="profile-form-group">
              <label>Full Name</label>
              <input type="text" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>Email</label>
              <input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>Phone</label>
              <input type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>Location</label>
              <input type="text" value={profile.location} onChange={(e) => setProfile({ ...profile, location: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>LinkedIn URL</label>
              <input type="url" value={profile.linkedin_url} onChange={(e) => setProfile({ ...profile, linkedin_url: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>GitHub URL</label>
              <input type="url" value={profile.github_url} onChange={(e) => setProfile({ ...profile, github_url: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>Other Link</label>
              <input type="url" value={profile.other_link} onChange={(e) => setProfile({ ...profile, other_link: e.target.value })} />
            </div>
          </div>
        ) : (
          <div className="profile-info-grid">
            <InfoRow label="Full Name" value={profile.name} />
            <InfoRow label="Email" value={profile.email} />
            <InfoRow label="Phone" value={profile.phone} />
            <InfoRow label="Location" value={profile.location} />
            <InfoRow label="LinkedIn" value={profile.linkedin_url} />
            <InfoRow label="GitHub" value={profile.github_url} />
            <InfoRow label="Other Link" value={profile.other_link} />
          </div>
        )}
      </section>

      {/* Education */}
      <section className="resume-section-card">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-graduation-cap"></i> Education</h2>
          <button className="btn-secondary" onClick={() => toggleEdit("education")} aria-label="Edit education">
            <PencilIcon /> {editingSection === "education" ? "Done" : "Edit"}
          </button>
        </div>
        {editingSection === "education" ? (
          <EducationEditor
            items={profile.education}
            onChange={(education) => setProfile({ ...profile, education })}
          />
        ) : (
          <div className="profile-timeline">
            {profile.education.length === 0 && <p className="profile-empty-text">No education added yet.</p>}
            {profile.education.map((edu, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <strong>{edu.school}</strong>
                  <span>{edu.degree}{edu.gpa ? ` — GPA: ${edu.gpa}` : ""}</span>
                  <span className="profile-timeline-date">{edu.start_date} → {edu.end_date || "Present"}</span>
                  {edu.achievements.length > 0 && (
                    <ul className="profile-bullets">
                      {edu.achievements.map((a, j) => <li key={j}>{a}</li>)}
                    </ul>
                  )}
                  {edu.coursework.length > 0 && (
                    <div className="profile-tags" style={{ marginTop: "0.5rem" }}>
                      {edu.coursework.map((c, j) => (
                        <span key={j} className="profile-tag">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Experience */}
      <section className="resume-section-card">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-briefcase"></i> Experience</h2>
          <button className="btn-secondary" onClick={() => toggleEdit("experience")} aria-label="Edit experience">
            <PencilIcon /> {editingSection === "experience" ? "Done" : "Edit"}
          </button>
        </div>
        {editingSection === "experience" ? (
          <ExperienceEditor
            items={profile.experience}
            onChange={(experience) => setProfile({ ...profile, experience })}
          />
        ) : (
          <div className="profile-timeline">
            {profile.experience.length === 0 && <p className="profile-empty-text">No experience added yet.</p>}
            {profile.experience.map((exp, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <span className="profile-timeline-date">{exp.start_date} → {exp.end_date || "Present"}</span>
                  <strong>{exp.company}</strong> — {exp.title}
                  {exp.location && <span className="profile-timeline-location">{exp.location}</span>}
                  {exp.bullets.length > 0 && (
                    <ul className="profile-bullets">
                      {exp.bullets.map((b, j) => <li key={j}>{b}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Projects */}
      <section className="resume-section-card">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-code"></i> Projects</h2>
          <button className="btn-secondary" onClick={() => toggleEdit("projects")} aria-label="Edit projects">
            <PencilIcon /> {editingSection === "projects" ? "Done" : "Edit"}
          </button>
        </div>
        {editingSection === "projects" ? (
          <ProjectsEditor
            items={profile.projects}
            onChange={(projects) => setProfile({ ...profile, projects })}
          />
        ) : (
          <div className="profile-timeline">
            {profile.projects.length === 0 && <p className="profile-empty-text">No projects added yet.</p>}
            {profile.projects.map((proj, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <strong>{proj.name}</strong>
                  {proj.organization && <span> — {proj.organization}</span>}
                  {proj.link && <a href={proj.link} target="_blank" rel="noopener noreferrer" className="profile-link">{proj.link}</a>}
                  <span className="profile-timeline-date">{proj.start_date} → {proj.end_date || "Present"}</span>
                  {proj.location && <span className="profile-timeline-location">{proj.location}</span>}
                  {proj.bullets.length > 0 && (
                    <ul className="profile-bullets">
                      {proj.bullets.map((b, j) => <li key={j}>{b}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Technologies */}
      <section className="resume-section-card">
        <div className="resume-section-header">
          <h2><i className="fa-solid fa-microchip"></i> Technologies</h2>
          <button className="btn-secondary" onClick={() => toggleEdit("technologies")} aria-label="Edit technologies">
            <PencilIcon /> {editingSection === "technologies" ? "Done" : "Edit"}
          </button>
        </div>
        {editingSection === "technologies" ? (
          <TechnologiesEditor
            technologies={profile.technologies}
            onChange={(technologies) => setProfile({ ...profile, technologies })}
          />
        ) : (
          <div className="profile-tech-categories">
            {Object.keys(profile.technologies).length === 0 && <p className="profile-empty-text">No technologies added yet.</p>}
            {Object.entries(profile.technologies).map(([category, items]) => (
              <div key={category} className="profile-tech-category">
                <span className="profile-tech-label">{category}</span>
                <div className="profile-tags">
                  {items.map((item, i) => (
                    <span key={i} className="profile-tag">{item}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ===== Sub-Components ===== */

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="profile-info-row">
      <span className="profile-info-label">{label}</span>
      <span className="profile-info-value">{value}</span>
    </div>
  );
}

/* ===== Experience Editor ===== */

function ExperienceEditor({ items, onChange }: { items: ExperienceItem[]; onChange: (items: ExperienceItem[]) => void }) {
  function update(index: number, field: keyof ExperienceItem, value: string | string[]) {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  }

  function addItem() {
    onChange([...items, { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [] }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="profile-editor-list">
      {items.map((item, i) => (
        <div key={i} className="profile-editor-card">
          <div className="profile-editor-card-header">
            <span>Experience #{i + 1}</span>
            <button className="profile-remove-btn" onClick={() => removeItem(i)} aria-label="Remove experience">×</button>
          </div>
          <div className="profile-form-grid">
            <div className="profile-form-group">
              <label>Company</label>
              <input type="text" value={item.company} onChange={(e) => update(i, "company", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Title</label>
              <input type="text" value={item.title} onChange={(e) => update(i, "title", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Location</label>
              <input type="text" value={item.location} onChange={(e) => update(i, "location", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Start Date</label>
              <input type="text" value={item.start_date} onChange={(e) => update(i, "start_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
            <div className="profile-form-group">
              <label>End Date</label>
              <input type="text" value={item.end_date} onChange={(e) => update(i, "end_date", e.target.value)} placeholder="YYYY-MM or Present" />
            </div>
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Bullet Points (one per line)</label>
            <textarea
              rows={4}
              value={item.bullets.join("\n")}
              onChange={(e) => update(i, "bullets", e.target.value.split("\n"))}
            />
          </div>
        </div>
      ))}
      <button className="profile-add-btn" onClick={addItem}>+ Add Experience</button>
    </div>
  );
}

/* ===== Education Editor ===== */

function EducationEditor({ items, onChange }: { items: EducationItem[]; onChange: (items: EducationItem[]) => void }) {
  function update(index: number, field: keyof EducationItem, value: string | string[]) {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  }

  function addItem() {
    onChange([...items, { school: "", degree: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="profile-editor-list">
      {items.map((item, i) => (
        <div key={i} className="profile-editor-card">
          <div className="profile-editor-card-header">
            <span>Education #{i + 1}</span>
            <button className="profile-remove-btn" onClick={() => removeItem(i)} aria-label="Remove education">×</button>
          </div>
          <div className="profile-form-grid">
            <div className="profile-form-group">
              <label>School</label>
              <input type="text" value={item.school} onChange={(e) => update(i, "school", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Degree</label>
              <input type="text" value={item.degree} onChange={(e) => update(i, "degree", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>GPA</label>
              <input type="text" value={item.gpa} onChange={(e) => update(i, "gpa", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Start Date</label>
              <input type="text" value={item.start_date} onChange={(e) => update(i, "start_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
            <div className="profile-form-group">
              <label>End Date</label>
              <input type="text" value={item.end_date} onChange={(e) => update(i, "end_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Achievements (one per line)</label>
            <textarea
              rows={3}
              value={item.achievements.join("\n")}
              onChange={(e) => update(i, "achievements", e.target.value.split("\n"))}
            />
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Coursework (one per line)</label>
            <textarea
              rows={3}
              value={item.coursework.join("\n")}
              onChange={(e) => update(i, "coursework", e.target.value.split("\n"))}
            />
          </div>
        </div>
      ))}
      <button className="profile-add-btn" onClick={addItem}>+ Add Education</button>
    </div>
  );
}

/* ===== Projects Editor ===== */

function ProjectsEditor({ items, onChange }: { items: ProjectItem[]; onChange: (items: ProjectItem[]) => void }) {
  function update(index: number, field: keyof ProjectItem, value: string | string[]) {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  }

  function addItem() {
    onChange([...items, { name: "", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [] }]);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="profile-editor-list">
      {items.map((item, i) => (
        <div key={i} className="profile-editor-card">
          <div className="profile-editor-card-header">
            <span>Project #{i + 1}</span>
            <button className="profile-remove-btn" onClick={() => removeItem(i)} aria-label="Remove project">×</button>
          </div>
          <div className="profile-form-grid">
            <div className="profile-form-group">
              <label>Name</label>
              <input type="text" value={item.name} onChange={(e) => update(i, "name", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Organization</label>
              <input type="text" value={item.organization} onChange={(e) => update(i, "organization", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Link</label>
              <input type="url" value={item.link} onChange={(e) => update(i, "link", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Location</label>
              <input type="text" value={item.location} onChange={(e) => update(i, "location", e.target.value)} />
            </div>
            <div className="profile-form-group">
              <label>Start Date</label>
              <input type="text" value={item.start_date} onChange={(e) => update(i, "start_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
            <div className="profile-form-group">
              <label>End Date</label>
              <input type="text" value={item.end_date} onChange={(e) => update(i, "end_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Bullet Points (one per line)</label>
            <textarea
              rows={4}
              value={item.bullets.join("\n")}
              onChange={(e) => update(i, "bullets", e.target.value.split("\n"))}
            />
          </div>
        </div>
      ))}
      <button className="profile-add-btn" onClick={addItem}>+ Add Project</button>
    </div>
  );
}

/* ===== Technologies Editor ===== */

function TechnologiesEditor({ technologies, onChange }: { technologies: Record<string, string[]>; onChange: (t: Record<string, string[]>) => void }) {
  function updateCategory(category: string, value: string) {
    const updated = { ...technologies, [category]: value.split(",").map((s) => s.trim()).filter(Boolean) };
    onChange(updated);
  }

  function removeCategory(category: string) {
    const updated = { ...technologies };
    delete updated[category];
    onChange(updated);
  }

  function addCategory() {
    const name = prompt("Category name:");
    if (name && name.trim() && !technologies[name.trim()]) {
      onChange({ ...technologies, [name.trim()]: [] });
    }
  }

  return (
    <div className="profile-editor-list">
      {Object.entries(technologies).map(([category, items]) => (
        <div key={category} className="profile-editor-card">
          <div className="profile-editor-card-header">
            <span>{category}</span>
            <button className="profile-remove-btn" onClick={() => removeCategory(category)} aria-label={`Remove ${category}`}>×</button>
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Items (comma-separated)</label>
            <input type="text" value={items.join(", ")} onChange={(e) => updateCategory(category, e.target.value)} />
          </div>
        </div>
      ))}
      <button className="profile-add-btn" onClick={addCategory}>+ Add Category</button>
    </div>
  );
}
