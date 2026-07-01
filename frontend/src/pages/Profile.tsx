import { useState, useEffect } from "react";
import api from "../auth/api";
import { PageIntro } from "../onboarding";

// ─── TypeScript Interfaces ───────────────────────────────────────────────────

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

interface ResumeListItem {
  id: number;
  name: string;
  is_primary: boolean;
  status: string;
}

type EditingSection = "personal" | "experience" | "education" | "skills" | "projects" | "technologies" | null;

// ─── Helper: empty profile ───────────────────────────────────────────────────

function emptyProfile(): ResumeProfile {
  return {
    name: "",
    email: "",
    phone: "",
    location: "",
    linkedin_url: "",
    github_url: "",
    other_link: "",
    skills: [],
    experience: [],
    education: [],
    projects: [],
    technologies: {},
  };
}

// ─── Pencil Icon ─────────────────────────────────────────────────────────────

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

// ─── Main Profile Component ──────────────────────────────────────────────────

export default function Profile() {
  const [profile, setProfile] = useState<ResumeProfile>(emptyProfile());
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [noResume, setNoResume] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingSection, setEditingSection] = useState<EditingSection>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // ─── Fetch resume profile ────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const listRes = await api.get("/resumes");
        const resumes: ResumeListItem[] = listRes.data;

        if (resumes.length === 0) {
          setNoResume(true);
          return;
        }

        // Pick primary or first
        const primary = resumes.find((r) => r.is_primary) || resumes[0];
        setResumeId(primary.id);

        const detailRes = await api.get(`/resumes/${primary.id}`);
        const detail = detailRes.data;

        setProfile(detail.profile || emptyProfile());
      } catch {
        setNoResume(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ─── Save changes ───────────────────────────────────────────────────────

  async function saveChanges() {
    if (resumeId === null) return;
    try {
      setSaving(true);
      await api.put(`/resumes/${resumeId}`, { profile });
      setEditingSection(null);
      showToast("success", "Profile saved successfully.");
    } catch {
      showToast("error", "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  function showToast(type: "success" | "error", message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }

  // ─── Section edit toggle ────────────────────────────────────────────────

  function toggleEdit(section: EditingSection) {
    setEditingSection((prev) => (prev === section ? null : section));
  }

  // ─── Loading / Empty states ─────────────────────────────────────────────

  if (loading) {
    return (
      <div className="profile-page">
        <div className="profile-loading">Loading profile...</div>
      </div>
    );
  }

  if (noResume) {
    return (
      <div className="profile-page">
        <div className="profile-empty">
          <h2>No Profile Found</h2>
          <p>Upload your resume first to populate your profile.</p>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="profile-page" data-tour="profile-page">
      <PageIntro page="profile" />
      {/* Header */}
      <div className="profile-header">
        <h1>Profile</h1>
        <button
          className="profile-save-btn"
          onClick={saveChanges}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      {/* Personal Info */}
      <section className="profile-section">
        <div className="profile-section-header">
          <h2>Personal Info</h2>
          <button className="profile-edit-btn" onClick={() => toggleEdit("personal")} aria-label="Edit personal info">
            <PencilIcon />
          </button>
        </div>
        {editingSection === "personal" ? (
          <div className="profile-form-grid">
            <div className="profile-form-group">
              <label>Name</label>
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
              <label>LinkedIn</label>
              <input type="url" value={profile.linkedin_url} onChange={(e) => setProfile({ ...profile, linkedin_url: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>GitHub</label>
              <input type="url" value={profile.github_url} onChange={(e) => setProfile({ ...profile, github_url: e.target.value })} />
            </div>
            <div className="profile-form-group">
              <label>Other Link</label>
              <input type="url" value={profile.other_link} onChange={(e) => setProfile({ ...profile, other_link: e.target.value })} />
            </div>
          </div>
        ) : (
          <div className="profile-info-grid">
            <InfoRow label="Name" value={profile.name} />
            <InfoRow label="Email" value={profile.email} />
            <InfoRow label="Phone" value={profile.phone} />
            <InfoRow label="Location" value={profile.location} />
            <InfoRow label="LinkedIn" value={profile.linkedin_url} />
            <InfoRow label="GitHub" value={profile.github_url} />
            {profile.other_link && <InfoRow label="Other" value={profile.other_link} />}
          </div>
        )}
      </section>

      {/* Experience */}
      <section className="profile-section">
        <div className="profile-section-header">
          <h2>Experience</h2>
          <button className="profile-edit-btn" onClick={() => toggleEdit("experience")} aria-label="Edit experience">
            <PencilIcon />
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

      {/* Education */}
      <section className="profile-section">
        <div className="profile-section-header">
          <h2>Education</h2>
          <button className="profile-edit-btn" onClick={() => toggleEdit("education")} aria-label="Edit education">
            <PencilIcon />
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
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Skills */}
      <section className="profile-section">
        <div className="profile-section-header">
          <h2>Skills</h2>
          <button className="profile-edit-btn" onClick={() => toggleEdit("skills")} aria-label="Edit skills">
            <PencilIcon />
          </button>
        </div>
        {editingSection === "skills" ? (
          <SkillsEditor
            skills={profile.skills}
            onChange={(skills) => setProfile({ ...profile, skills })}
          />
        ) : (
          <div className="profile-tags">
            {profile.skills.length === 0 && <p className="profile-empty-text">No skills added yet.</p>}
            {profile.skills.map((skill, i) => (
              <span key={i} className="profile-tag">{skill}</span>
            ))}
          </div>
        )}
      </section>

      {/* Technologies */}
      {Object.keys(profile.technologies).length > 0 && (
        <section className="profile-section">
          <div className="profile-section-header">
            <h2>Technologies</h2>
            <button className="profile-edit-btn" onClick={() => toggleEdit("technologies")} aria-label="Edit technologies">
              <PencilIcon />
            </button>
          </div>
          {editingSection === "technologies" ? (
            <TechnologiesEditor
              technologies={profile.technologies}
              onChange={(technologies) => setProfile({ ...profile, technologies })}
            />
          ) : (
            <div className="profile-tech-categories">
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
      )}

      {/* Projects */}
      <section className="profile-section">
        <div className="profile-section-header">
          <h2>Projects</h2>
          <button className="profile-edit-btn" onClick={() => toggleEdit("projects")} aria-label="Edit projects">
            <PencilIcon />
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

      {/* Toast */}
      {toast && (
        <div className={`profile-toast profile-toast-${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-info-row">
      <span className="profile-info-label">{label}</span>
      <span className="profile-info-value">{value || "—"}</span>
    </div>
  );
}

// ─── Experience Editor ───────────────────────────────────────────────────────

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
            <label>Bullets (one per line)</label>
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

// ─── Education Editor ────────────────────────────────────────────────────────

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

// ─── Skills Editor ───────────────────────────────────────────────────────────

function SkillsEditor({ skills, onChange }: { skills: string[]; onChange: (skills: string[]) => void }) {
  const [inputValue, setInputValue] = useState("");

  function addSkill() {
    const trimmed = inputValue.trim();
    if (trimmed && !skills.includes(trimmed)) {
      onChange([...skills, trimmed]);
      setInputValue("");
    }
  }

  function removeSkill(index: number) {
    onChange(skills.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addSkill();
    }
  }

  return (
    <div className="profile-skills-editor">
      <div className="profile-tags">
        {skills.map((skill, i) => (
          <span key={i} className="profile-tag profile-tag-editable">
            {skill}
            <button className="profile-tag-remove" onClick={() => removeSkill(i)} aria-label={`Remove ${skill}`}>×</button>
          </span>
        ))}
      </div>
      <div className="profile-skill-input-row">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a skill and press Enter"
        />
        <button className="profile-add-btn" onClick={addSkill}>Add</button>
      </div>
    </div>
  );
}

// ─── Technologies Editor ─────────────────────────────────────────────────────

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

// ─── Projects Editor ─────────────────────────────────────────────────────────

function ProjectsEditor({ items, onChange }: { items: ProjectItem[]; onChange: (items: ProjectItem[]) => void }) {
  function update(index: number, field: keyof ProjectItem, value: string | string[]) {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  }

  function addItem() {
    onChange([...items, { name: "", link: "", organization: "", start_date: "", end_date: "", bullets: [] }]);
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
              <label>Start Date</label>
              <input type="text" value={item.start_date} onChange={(e) => update(i, "start_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
            <div className="profile-form-group">
              <label>End Date</label>
              <input type="text" value={item.end_date} onChange={(e) => update(i, "end_date", e.target.value)} placeholder="YYYY-MM" />
            </div>
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Bullets (one per line)</label>
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