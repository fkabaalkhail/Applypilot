import { useState, useEffect, useCallback } from "react";
import api from "../auth/api";
import { PageIntro } from "../onboarding";
import {
  EeoData,
  ProfileExtras,
  ProfileUpdatePayload,
  EMPTY_PROFILE_EXTRAS,
  EEO_OPTIONS,
  computeProfileDiff,
  splitName,
} from "../lib/profileExtras";

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

type EditingSection =
  | "personal"
  | "experience"
  | "education"
  | "skills"
  | "technologies"
  | "projects"
  | "eeo"
  | null;

// Section nav — mirrors the application form categories the extension fills.
const SECTIONS = [
  { id: "personal", label: "Personal" },
  { id: "education", label: "Education" },
  { id: "experience", label: "Work Experience" },
  { id: "skills", label: "Skills" },
  { id: "projects", label: "Projects" },
  { id: "eeo", label: "Equal Employment" },
] as const;

// Stable id list so the scroll-spy effect isn't rebuilt on every render.
const SECTION_IDS = SECTIONS.map((s) => s.id);

// ─── Helpers: empty profile ──────────────────────────────────────────────────

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

// ─── Icons ───────────────────────────────────────────────────────────────────

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function ChipIcon({ kind }: { kind: "location" | "email" | "phone" | "github" | "linkedin" | "link" }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "location":
      return <svg {...common}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>;
    case "email":
      return <svg {...common}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>;
    case "phone":
      return <svg {...common}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>;
    case "github":
      return <svg {...common}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" /></svg>;
    case "linkedin":
      return <svg {...common}><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" /><rect x="2" y="9" width="4" height="12" /><circle cx="4" cy="4" r="2" /></svg>;
    case "link":
      return <svg {...common}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>;
  }
}

// ─── Scroll-spy hook ─────────────────────────────────────────────────────────

/** Track which section is currently in view for the sticky nav. */
function useScrollSpy(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Activate a section once it crosses ~140px below the top (under the nav).
      { rootMargin: "-140px 0px -55% 0px", threshold: 0 }
    );
    for (const id of ids) {
      const el = document.getElementById(`profile-sec-${id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

// ─── Compose a one-line mailing address from the structured parts ─────────────

function composeAddress(extras: ProfileExtras, fallback: string): string {
  const parts = [
    extras.addressStreet,
    extras.postalCode,
    extras.addressCity,
    extras.addressState,
    extras.country,
  ].filter((p) => p && p.trim());
  return parts.length ? parts.join(", ") : fallback;
}

// ─── Main Profile Component ──────────────────────────────────────────────────

export default function Profile() {
  const [profile, setProfile] = useState<ResumeProfile>(emptyProfile());
  const [originalProfile, setOriginalProfile] = useState<ResumeProfile>(emptyProfile());
  const [extras, setExtras] = useState<ProfileExtras>(EMPTY_PROFILE_EXTRAS);
  const [originalExtras, setOriginalExtras] = useState<ProfileExtras>(EMPTY_PROFILE_EXTRAS);
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [hasResume, setHasResume] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingSection, setEditingSection] = useState<EditingSection>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const activeSection = useScrollSpy(SECTION_IDS);

  // ─── Load resume profile + application-profile extras ─────────────────────

  useEffect(() => {
    async function load() {
      setLoading(true);
      // Resume profile (rich sections + contact) — optional.
      let loadedProfile = emptyProfile();
      let loadedResumeId: number | null = null;
      try {
        const listRes = await api.get("/resumes");
        const resumes: ResumeListItem[] = listRes.data;
        if (resumes.length > 0) {
          const primary = resumes.find((r) => r.is_primary) || resumes[0];
          loadedResumeId = primary.id;
          const detailRes = await api.get(`/resumes/${primary.id}`);
          loadedProfile = { ...emptyProfile(), ...(detailRes.data.profile || {}) };
        }
      } catch {
        // No resume yet — Personal / Address / EEO still work via app-profile.
      }

      // Application-profile extras (address + EEO) + contact fallbacks. These
      // are the canonical, extension-synced values, so they win for contact.
      let loadedExtras = EMPTY_PROFILE_EXTRAS;
      try {
        const res = await api.get("/api/user/application-profile");
        const d = res.data;
        loadedExtras = {
          addressStreet: d.addressStreet ?? "",
          addressCity: d.addressCity ?? "",
          addressState: d.addressState ?? "",
          postalCode: d.postalCode ?? "",
          country: d.country ?? "",
          eeo: {
            gender: d.eeo?.gender ?? "",
            race: d.eeo?.race ?? "",
            hispanicLatino: d.eeo?.hispanicLatino ?? "",
            veteranStatus: d.eeo?.veteranStatus ?? "",
            disabilityStatus: d.eeo?.disabilityStatus ?? "",
          },
        };
        // Show the merged, extension-synced contact values (settings-first, then
        // resume) so the Personal card always matches what the extension fills.
        // Fall back to the resume-only value if the merged one is blank.
        const mergedName = [d.firstName, d.lastName].filter(Boolean).join(" ");
        loadedProfile = {
          ...loadedProfile,
          name: mergedName || loadedProfile.name,
          email: (d.email ?? "") || loadedProfile.email,
          phone: (d.phone ?? "") || loadedProfile.phone,
          location: (d.location ?? "") || loadedProfile.location,
          linkedin_url: (d.linkedin ?? "") || loadedProfile.linkedin_url,
          github_url: (d.github ?? "") || loadedProfile.github_url,
          other_link: (d.portfolio ?? "") || loadedProfile.other_link,
        };
      } catch {
        // No profile row yet — everything stays empty + editable.
      }

      setResumeId(loadedResumeId);
      setHasResume(loadedResumeId !== null);
      setProfile(loadedProfile);
      setOriginalProfile(loadedProfile);
      setExtras(loadedExtras);
      setOriginalExtras(loadedExtras);
      setLoading(false);
    }
    load();
  }, []);

  // ─── Save changes (resume + application-profile, kept in sync) ────────────

  const buildProfilePayload = useCallback((): ProfileUpdatePayload | null => {
    // Address + EEO diff (shared helper).
    const payload: ProfileUpdatePayload = computeProfileDiff(originalExtras, extras) ?? {};

    // Contact fields changed on the resume must also flow to the application
    // profile (which the extension + merge read as authoritative).
    if (profile.name !== originalProfile.name) {
      const [first, last] = splitName(profile.name);
      payload.firstName = first;
      payload.lastName = last;
    }
    if (profile.email !== originalProfile.email) payload.email = profile.email;
    if (profile.phone !== originalProfile.phone) payload.phone = profile.phone;
    if (profile.location !== originalProfile.location) payload.location = profile.location;
    if (profile.linkedin_url !== originalProfile.linkedin_url) payload.linkedin = profile.linkedin_url;
    if (profile.other_link !== originalProfile.other_link) payload.portfolio = profile.other_link;

    return Object.keys(payload).length > 0 ? payload : null;
  }, [profile, originalProfile, extras, originalExtras]);

  async function saveChanges() {
    try {
      setSaving(true);
      const resumeChanged = JSON.stringify(profile) !== JSON.stringify(originalProfile);
      const profilePayload = buildProfilePayload();

      if (resumeId !== null && resumeChanged) {
        await api.put(`/resumes/${resumeId}`, { profile });
      }
      if (profilePayload) {
        await api.put("/api/user/application-profile", profilePayload);
      }

      setOriginalProfile(profile);
      setOriginalExtras(extras);
      setEditingSection(null);
      showToast("success", "Profile saved. Your extension will sync automatically.");
    } catch {
      showToast("error", "Couldn't save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function showToast(type: "success" | "error", message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3200);
  }

  function toggleEdit(section: EditingSection) {
    setEditingSection((prev) => (prev === section ? null : section));
  }

  const isDirty =
    JSON.stringify(profile) !== JSON.stringify(originalProfile) ||
    JSON.stringify(extras) !== JSON.stringify(originalExtras);

  function scrollToSection(id: string) {
    document.getElementById(`profile-sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="profile-page">
        <div className="profile-loading">Loading your profile…</div>
      </div>
    );
  }

  const addressLine = composeAddress(extras, profile.location);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="profile-page" data-tour="profile-page">
      <PageIntro page="profile" />

      <div className="profile-eyebrow">Profile</div>

      {/* Privacy banner */}
      <div className="profile-privacy">
        <span className="profile-privacy-icon"><ShieldIcon /></span>
        <span>Your profile data is kept private and secure. It syncs only to your own extension.</span>
      </div>

      {/* Sticky section nav */}
      <nav className="profile-nav" aria-label="Profile sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`profile-nav-tab${activeSection === s.id ? " active" : ""}`}
            onClick={() => scrollToSection(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className="profile-nav-spacer" />
        <button className="profile-save-btn" onClick={saveChanges} disabled={saving || !isDirty}>
          {saving ? "Saving…" : "Save changes"}
          {isDirty && !saving && <span className="profile-dirty-dot" />}
        </button>
      </nav>

      {/* ── Personal (identity hero) ── */}
      <section id="profile-sec-personal" className="profile-card profile-hero">
        <div className="profile-card-head">
          <h1 className="profile-name">{profile.name || "Your name"}</h1>
          <button className="profile-edit-btn" onClick={() => toggleEdit("personal")} aria-label="Edit personal info">
            <PencilIcon />
          </button>
        </div>

        {editingSection === "personal" ? (
          <PersonalEditor profile={profile} extras={extras} onProfile={setProfile} onExtras={setExtras} />
        ) : (
          <div className="profile-chips">
            {addressLine && <Chip kind="location" text={addressLine} />}
            {profile.email && <Chip kind="email" text={profile.email} href={`mailto:${profile.email}`} />}
            {profile.phone && <Chip kind="phone" text={profile.phone} href={`tel:${profile.phone}`} />}
            {profile.github_url && <Chip kind="github" text={profile.github_url} href={profile.github_url} />}
            {profile.linkedin_url && <Chip kind="linkedin" text={profile.linkedin_url} href={profile.linkedin_url} />}
            {profile.other_link && <Chip kind="link" text={profile.other_link} href={profile.other_link} />}
            {!addressLine && !profile.email && !profile.phone && !profile.github_url && !profile.linkedin_url && !profile.other_link && (
              <p className="profile-empty-text">Add your contact details so applications fill instantly.</p>
            )}
          </div>
        )}
      </section>

      {/* ── Education ── */}
      <Section id="education" title="Education" onEdit={() => toggleEdit("education")}>
        {editingSection === "education" ? (
          <EducationEditor items={profile.education} onChange={(education) => setProfile({ ...profile, education })} />
        ) : (
          <div className="profile-timeline">
            {profile.education.length === 0 && <EmptyHint hasResume={hasResume} what="education" />}
            {profile.education.map((edu, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <span className="profile-timeline-date">{edu.start_date} → {edu.end_date || "Present"}</span>
                  <strong>{edu.school}</strong>
                  <span>{edu.degree}{edu.gpa ? ` — GPA: ${edu.gpa}` : ""}</span>
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
      </Section>

      {/* ── Work Experience ── */}
      <Section id="experience" title="Work Experience" onEdit={() => toggleEdit("experience")}>
        {editingSection === "experience" ? (
          <ExperienceEditor items={profile.experience} onChange={(experience) => setProfile({ ...profile, experience })} />
        ) : (
          <div className="profile-timeline">
            {profile.experience.length === 0 && <EmptyHint hasResume={hasResume} what="work experience" />}
            {profile.experience.map((exp, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <span className="profile-timeline-date">{exp.start_date} → {exp.end_date || "Present"}</span>
                  <strong>{exp.company}</strong>
                  <span>{exp.title}{exp.location ? ` · ${exp.location}` : ""}</span>
                  {exp.bullets.length > 0 && (
                    <ul className="profile-bullets">
                      {exp.bullets.filter(Boolean).map((b, j) => <li key={j}>{b}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Skills (+ Technologies) ── */}
      <Section id="skills" title="Skills" onEdit={() => toggleEdit("skills")}>
        {editingSection === "skills" ? (
          <SkillsEditor skills={profile.skills} onChange={(skills) => setProfile({ ...profile, skills })} />
        ) : (
          <div className="profile-tags">
            {profile.skills.length === 0 && <EmptyHint hasResume={hasResume} what="skills" />}
            {profile.skills.map((skill, i) => <span key={i} className="profile-tag">{skill}</span>)}
          </div>
        )}

        {(Object.keys(profile.technologies).length > 0 || editingSection === "technologies") && (
          <div className="profile-subsection">
            <div className="profile-subsection-head">
              <span className="profile-subsection-title">Technologies</span>
              <button className="profile-edit-btn small" onClick={() => toggleEdit("technologies")} aria-label="Edit technologies">
                <PencilIcon />
              </button>
            </div>
            {editingSection === "technologies" ? (
              <TechnologiesEditor technologies={profile.technologies} onChange={(technologies) => setProfile({ ...profile, technologies })} />
            ) : (
              <div className="profile-tech-categories">
                {Object.entries(profile.technologies).map(([category, items]) => (
                  <div key={category} className="profile-tech-category">
                    <span className="profile-tech-label">{category}</span>
                    <div className="profile-tags">
                      {items.map((item, i) => <span key={i} className="profile-tag">{item}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── Projects ── */}
      <Section id="projects" title="Projects" onEdit={() => toggleEdit("projects")}>
        {editingSection === "projects" ? (
          <ProjectsEditor items={profile.projects} onChange={(projects) => setProfile({ ...profile, projects })} />
        ) : (
          <div className="profile-timeline">
            {profile.projects.length === 0 && <EmptyHint hasResume={hasResume} what="projects" />}
            {profile.projects.map((proj, i) => (
              <div key={i} className="profile-timeline-item">
                <div className="profile-timeline-dot" />
                <div className="profile-timeline-content">
                  <span className="profile-timeline-date">{proj.start_date} → {proj.end_date || "Present"}</span>
                  <strong>{proj.name}</strong>
                  {proj.organization && <span>{proj.organization}</span>}
                  {proj.link && <a href={proj.link} target="_blank" rel="noopener noreferrer" className="profile-link">{proj.link}</a>}
                  {proj.bullets.length > 0 && (
                    <ul className="profile-bullets">
                      {proj.bullets.filter(Boolean).map((b, j) => <li key={j}>{b}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Equal Employment (EEO self-identification) ── */}
      <Section id="eeo" title="Equal Employment" onEdit={() => toggleEdit("eeo")}>
        <p className="profile-section-sub">
          Optional self-identification. Only filled into applications when you enable EEO autofill in the extension. Kept private.
        </p>
        {editingSection === "eeo" ? (
          <EeoEditor eeo={extras.eeo} onChange={(eeo) => setExtras({ ...extras, eeo })} />
        ) : (
          <div className="profile-info-grid">
            <InfoRow label="Gender" value={extras.eeo.gender} />
            <InfoRow label="Race / Ethnicity" value={extras.eeo.race} />
            <InfoRow label="Hispanic or Latino" value={extras.eeo.hispanicLatino} />
            <InfoRow label="Veteran Status" value={extras.eeo.veteranStatus} />
            <InfoRow label="Disability Status" value={extras.eeo.disabilityStatus} />
          </div>
        )}
      </Section>

      {toast && <div className={`profile-toast profile-toast-${toast.type}`}>{toast.message}</div>}
    </div>
  );
}

// ─── Layout sub-components ────────────────────────────────────────────────────

function Section({ id, title, onEdit, children }: { id: string; title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <section id={`profile-sec-${id}`} className="profile-card">
      <div className="profile-card-head">
        <h2 className="profile-section-title">{title}</h2>
        <button className="profile-edit-btn" onClick={onEdit} aria-label={`Edit ${title.toLowerCase()}`}>
          <PencilIcon />
        </button>
      </div>
      {children}
    </section>
  );
}

function Chip({ kind, text, href }: { kind: "location" | "email" | "phone" | "github" | "linkedin" | "link"; text: string; href?: string }) {
  const inner = (
    <>
      <span className="profile-chip-icon"><ChipIcon kind={kind} /></span>
      <span className="profile-chip-text">{text}</span>
    </>
  );
  if (href) {
    const external = kind !== "email" && kind !== "phone";
    return (
      <a className="profile-chip" href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
        {inner}
      </a>
    );
  }
  return <span className="profile-chip">{inner}</span>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-info-row">
      <span className="profile-info-label">{label}</span>
      <span className="profile-info-value">{value || "—"}</span>
    </div>
  );
}

function EmptyHint({ hasResume, what }: { hasResume: boolean; what: string }) {
  return (
    <p className="profile-empty-text">
      {hasResume ? `No ${what} added yet.` : `Upload a resume in Settings to auto-fill your ${what}, or add it manually with the pencil.`}
    </p>
  );
}

// ─── Personal editor (contact + structured address) ──────────────────────────

function PersonalEditor({
  profile,
  extras,
  onProfile,
  onExtras,
}: {
  profile: ResumeProfile;
  extras: ProfileExtras;
  onProfile: (p: ResumeProfile) => void;
  onExtras: (e: ProfileExtras) => void;
}) {
  const set = (field: keyof ResumeProfile, value: string) => onProfile({ ...profile, [field]: value });
  const setAddr = (field: keyof Omit<ProfileExtras, "eeo">, value: string) => onExtras({ ...extras, [field]: value });

  return (
    <div className="profile-editor">
      <div className="profile-form-grid">
        <Field label="Full Name" value={profile.name} onChange={(v) => set("name", v)} />
        <Field label="Email" type="email" value={profile.email} onChange={(v) => set("email", v)} />
        <Field label="Phone" type="tel" value={profile.phone} onChange={(v) => set("phone", v)} />
        <Field label="Location" value={profile.location} onChange={(v) => set("location", v)} />
        <Field label="LinkedIn" type="url" value={profile.linkedin_url} onChange={(v) => set("linkedin_url", v)} />
        <Field label="GitHub" type="url" value={profile.github_url} onChange={(v) => set("github_url", v)} />
        <Field label="Portfolio / Other" type="url" value={profile.other_link} onChange={(v) => set("other_link", v)} full />
      </div>

      <div className="profile-subsection">
        <div className="profile-subsection-head">
          <span className="profile-subsection-title">Mailing Address</span>
        </div>
        <div className="profile-form-grid">
          <Field label="Street Address" value={extras.addressStreet} onChange={(v) => setAddr("addressStreet", v)} full />
          <Field label="City" value={extras.addressCity} onChange={(v) => setAddr("addressCity", v)} />
          <Field label="Province / State" value={extras.addressState} onChange={(v) => setAddr("addressState", v)} />
          <Field label="Postal Code" value={extras.postalCode} onChange={(v) => setAddr("postalCode", v)} />
          <Field label="Country" value={extras.country} onChange={(v) => setAddr("country", v)} />
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  full = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  full?: boolean;
}) {
  return (
    <div className={`profile-form-group${full ? " profile-form-group-full" : ""}`}>
      <label>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ─── EEO editor ──────────────────────────────────────────────────────────────

function EeoEditor({ eeo, onChange }: { eeo: EeoData; onChange: (e: EeoData) => void }) {
  const set = (field: keyof EeoData, value: string) => onChange({ ...eeo, [field]: value });
  const selects: { field: keyof EeoData; label: string }[] = [
    { field: "gender", label: "Gender" },
    { field: "race", label: "Race / Ethnicity" },
    { field: "hispanicLatino", label: "Hispanic or Latino" },
    { field: "veteranStatus", label: "Veteran Status" },
    { field: "disabilityStatus", label: "Disability Status" },
  ];
  return (
    <div className="profile-form-grid">
      {selects.map(({ field, label }) => (
        <div className="profile-form-group" key={field}>
          <label>{label}</label>
          <select value={eeo[field]} onChange={(e) => set(field, e.target.value)}>
            <option value="">Select…</option>
            {EEO_OPTIONS[field].map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      ))}
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
            <Field label="Company" value={item.company} onChange={(v) => update(i, "company", v)} />
            <Field label="Title" value={item.title} onChange={(v) => update(i, "title", v)} />
            <Field label="Location" value={item.location} onChange={(v) => update(i, "location", v)} />
            <Field label="Start Date" value={item.start_date} onChange={(v) => update(i, "start_date", v)} />
            <Field label="End Date" value={item.end_date} onChange={(v) => update(i, "end_date", v)} />
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Bullets (one per line)</label>
            <textarea rows={4} value={item.bullets.join("\n")} onChange={(e) => update(i, "bullets", e.target.value.split("\n"))} />
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
            <Field label="School" value={item.school} onChange={(v) => update(i, "school", v)} />
            <Field label="Degree" value={item.degree} onChange={(v) => update(i, "degree", v)} />
            <Field label="GPA" value={item.gpa} onChange={(v) => update(i, "gpa", v)} />
            <Field label="Start Date" value={item.start_date} onChange={(v) => update(i, "start_date", v)} />
            <Field label="End Date" value={item.end_date} onChange={(v) => update(i, "end_date", v)} />
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Achievements (one per line)</label>
            <textarea rows={3} value={item.achievements.join("\n")} onChange={(e) => update(i, "achievements", e.target.value.split("\n"))} />
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Coursework (one per line)</label>
            <textarea rows={3} value={item.coursework.join("\n")} onChange={(e) => update(i, "coursework", e.target.value.split("\n"))} />
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
        <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={handleKeyDown} placeholder="Type a skill and press Enter" />
        <button className="profile-add-btn" onClick={addSkill}>Add</button>
      </div>
    </div>
  );
}

// ─── Technologies Editor ─────────────────────────────────────────────────────

function TechnologiesEditor({ technologies, onChange }: { technologies: Record<string, string[]>; onChange: (t: Record<string, string[]>) => void }) {
  function updateCategory(category: string, value: string) {
    onChange({ ...technologies, [category]: value.split(",").map((s) => s.trim()).filter(Boolean) });
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
            <Field label="Name" value={item.name} onChange={(v) => update(i, "name", v)} />
            <Field label="Organization" value={item.organization} onChange={(v) => update(i, "organization", v)} />
            <Field label="Link" type="url" value={item.link} onChange={(v) => update(i, "link", v)} />
            <Field label="Start Date" value={item.start_date} onChange={(v) => update(i, "start_date", v)} />
            <Field label="End Date" value={item.end_date} onChange={(v) => update(i, "end_date", v)} />
          </div>
          <div className="profile-form-group profile-form-group-full">
            <label>Bullets (one per line)</label>
            <textarea rows={4} value={item.bullets.join("\n")} onChange={(e) => update(i, "bullets", e.target.value.split("\n"))} />
          </div>
        </div>
      ))}
      <button className="profile-add-btn" onClick={addItem}>+ Add Project</button>
    </div>
  );
}
