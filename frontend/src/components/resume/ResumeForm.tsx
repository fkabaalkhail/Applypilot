import { useMemo, useRef } from "react";
import type { AnalysisReport, CustomSection, ResumeProfile, Severity } from "../../lib/resumeProfile";
import { findCustom, orderedSections, sectionFlags, sectionLabel } from "../../lib/resumeProfile";
import { BulletList, ChipList, EditableArea, EditableText } from "./Editable";
import { SEVERITY_LABEL } from "./SeverityRail";

type Update = (patch: Partial<ResumeProfile>) => void;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="rd-field">
      <span className="rd-field-label">{label}</span>
      {children}
    </label>
  );
}

function DateRange({ start, end, onStart, onEnd, label }: {
  start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void; label: string;
}) {
  return (
    <div className="rd-field-row">
      <Field label="Start"><EditableText value={start} onChange={onStart} ariaLabel={`${label} start date`} placeholder="e.g. 2023" /></Field>
      <Field label="End"><EditableText value={end} onChange={onEnd} ariaLabel={`${label} end date`} placeholder="Present" /></Field>
    </div>
  );
}

function EntryCard({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) {
  return (
    <div className="rd-entry-card">
      <div className="rd-entry-card-body">{children}</div>
      <button type="button" className="rd-entry-del" aria-label={`Remove ${label}`} onClick={onRemove}>
        <i className="fa-solid fa-trash-can" /> Remove
      </button>
    </div>
  );
}

export default function ResumeForm({
  profile,
  report,
  onChange,
  onFlagClick,
}: {
  profile: ResumeProfile;
  report: AnalysisReport | null;
  onChange: Update;
  onFlagClick: (severity: Severity) => void;
}) {
  const keys = useMemo(() => orderedSections(profile), [profile]);
  const liveRef = useRef<HTMLDivElement>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    const next = [...keys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ section_order: next });
    if (liveRef.current) {
      liveRef.current.textContent = `${sectionLabel(profile, moved)} moved to position ${to + 1} of ${next.length}`;
    }
  };

  const setCustom = (id: string, patch: Partial<CustomSection>) =>
    onChange({ custom_sections: profile.custom_sections.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <div className="rd-form">
      <div ref={liveRef} aria-live="polite" className="sr-only" style={{ position: "absolute", left: "-9999px" }} />

      <section className="rd-form-section" aria-label="Basics">
        <div className="rd-form-head"><h2 className="rd-form-title">Basics</h2></div>
        <div className="rd-form-body">
          <Field label="Full name"><EditableText value={profile.name} onChange={(name) => onChange({ name })} ariaLabel="Your name" placeholder="Your name" /></Field>
          <div className="rd-field-row">
            <Field label="Email"><EditableText value={profile.email} onChange={(email) => onChange({ email })} ariaLabel="Email" placeholder="you@email.com" /></Field>
            <Field label="Phone"><EditableText value={profile.phone} onChange={(phone) => onChange({ phone })} ariaLabel="Phone" placeholder="(555) 555-5555" /></Field>
          </div>
          <Field label="Location"><EditableText value={profile.location} onChange={(location) => onChange({ location })} ariaLabel="Location" placeholder="City, Region" /></Field>
          <div className="rd-field-row">
            <Field label="LinkedIn"><EditableText value={profile.linkedin_url} onChange={(linkedin_url) => onChange({ linkedin_url })} ariaLabel="LinkedIn URL" placeholder="linkedin.com/in/you" /></Field>
            <Field label="GitHub"><EditableText value={profile.github_url} onChange={(github_url) => onChange({ github_url })} ariaLabel="GitHub URL" placeholder="github.com/you" /></Field>
          </div>
          <Field label="Other link"><EditableText value={profile.other_link} onChange={(other_link) => onChange({ other_link })} ariaLabel="Portfolio or other link" placeholder="your-site.com" /></Field>
        </div>
      </section>

      {keys.map((key, index) => {
        const label = sectionLabel(profile, key);
        const flags = sectionFlags(report, label);
        return (
          <section key={key} className="rd-form-section" aria-label={label}>
            <div className="rd-form-head">
              <div className="rd-reorder">
                <button type="button" className="rd-reorder-btn" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, index - 1)}><i className="fa-solid fa-chevron-up" /></button>
                <button type="button" className="rd-reorder-btn" aria-label={`Move ${label} down`} disabled={index === keys.length - 1} onClick={() => move(index, index + 1)}><i className="fa-solid fa-chevron-down" /></button>
              </div>
              <h2 className="rd-form-title">{label}</h2>
              {flags.length > 0 && (
                <div className="rd-section-flags">
                  {flags.map(({ severity, count }) => (
                    <button
                      key={severity}
                      type="button"
                      className="rd-flag"
                      data-severity={severity}
                      onClick={() => onFlagClick(severity)}
                      title={`See the ${count} ${SEVERITY_LABEL[severity].toLowerCase()} finding${count === 1 ? "" : "s"} for ${label}`}
                    >
                      {count} {SEVERITY_LABEL[severity]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rd-form-body">
              {key === "summary" && (
                <EditableArea
                  value={profile.summary}
                  onChange={(summary) => onChange({ summary })}
                  ariaLabel="Professional summary"
                  placeholder="Two or three sentences on what you do and what you've shipped."
                  className="rd-edit-area"
                  maxHeight={200}
                />
              )}
              {key === "experience" && (
                <>
                  {profile.experience.map((exp, i) => {
                    const patch = (p: Partial<typeof exp>) =>
                      onChange({ experience: profile.experience.map((e, j) => (j === i ? { ...e, ...p } : e)) });
                    return (
                      <EntryCard key={i} label={exp.company || `experience ${i + 1}`} onRemove={() => onChange({ experience: profile.experience.filter((_, j) => j !== i) })}>
                        <div className="rd-field-row">
                          <Field label="Company"><EditableText value={exp.company} onChange={(company) => patch({ company })} ariaLabel={`Company ${i + 1}`} placeholder="Company" /></Field>
                          <Field label="Job title"><EditableText value={exp.title} onChange={(title) => patch({ title })} ariaLabel={`Job title ${i + 1}`} placeholder="Job title" /></Field>
                        </div>
                        <div className="rd-field-row">
                          <Field label="Location"><EditableText value={exp.location} onChange={(location) => patch({ location })} ariaLabel={`Location ${i + 1}`} placeholder="City, Region" /></Field>
                          <div />
                        </div>
                        <DateRange start={exp.start_date} end={exp.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={exp.company || `Experience ${i + 1}`} />
                        <Field label="Highlights"><BulletList bullets={exp.bullets} onChange={(bullets) => patch({ bullets })} label={exp.company || `Experience ${i + 1}`} /></Field>
                      </EntryCard>
                    );
                  })}
                  <button className="rd-add" onClick={() => onChange({ experience: [...profile.experience, { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [""] }] })}>
                    <i className="fa-solid fa-plus" /> Add a role
                  </button>
                </>
              )}

              {key === "education" && (
                <>
                  {profile.education.map((edu, i) => {
                    const patch = (p: Partial<typeof edu>) =>
                      onChange({ education: profile.education.map((e, j) => (j === i ? { ...e, ...p } : e)) });
                    return (
                      <EntryCard key={i} label={edu.school || `education ${i + 1}`} onRemove={() => onChange({ education: profile.education.filter((_, j) => j !== i) })}>
                        <Field label="School"><EditableText value={edu.school} onChange={(school) => patch({ school })} ariaLabel={`School ${i + 1}`} placeholder="School" /></Field>
                        <Field label="Degree"><EditableText value={edu.degree} onChange={(degree) => patch({ degree })} ariaLabel={`Degree ${i + 1}`} placeholder="e.g. Honours BSc. Translation and Interpretation" /></Field>
                        <div className="rd-field-row">
                          <Field label="Location"><EditableText value={edu.location} onChange={(location) => patch({ location })} ariaLabel={`Education location ${i + 1}`} placeholder="City, Region" /></Field>
                          <Field label="GPA"><EditableText value={edu.gpa} onChange={(gpa) => patch({ gpa })} ariaLabel={`GPA ${i + 1}`} placeholder="e.g. 3.9 / 4.0" /></Field>
                        </div>
                        <DateRange start={edu.start_date} end={edu.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={edu.school || `Education ${i + 1}`} />
                        <Field label="Achievements"><BulletList bullets={edu.achievements} onChange={(achievements) => patch({ achievements })} label={`${edu.school || "Education"} achievements`} /></Field>
                        <Field label="Relevant coursework"><ChipList values={edu.coursework} onChange={(coursework) => patch({ coursework })} label="coursework" placeholder="Add a course…" /></Field>
                      </EntryCard>
                    );
                  })}
                  <button className="rd-add" onClick={() => onChange({ education: [...profile.education, { school: "", degree: "", location: "", start_date: "", end_date: "", gpa: "", achievements: [], coursework: [] }] })}>
                    <i className="fa-solid fa-plus" /> Add a school
                  </button>
                </>
              )}

              {key === "projects" && (
                <>
                  {profile.projects.map((proj, i) => {
                    const patch = (p: Partial<typeof proj>) =>
                      onChange({ projects: profile.projects.map((e, j) => (j === i ? { ...e, ...p } : e)) });
                    return (
                      <EntryCard key={i} label={proj.name || `project ${i + 1}`} onRemove={() => onChange({ projects: profile.projects.filter((_, j) => j !== i) })}>
                        <div className="rd-field-row">
                          <Field label="Project"><EditableText value={proj.name} onChange={(name) => patch({ name })} ariaLabel={`Project ${i + 1}`} placeholder="Project name" /></Field>
                          <Field label="Organization"><EditableText value={proj.organization} onChange={(organization) => patch({ organization })} ariaLabel={`Project organization ${i + 1}`} placeholder="Course, club, or company" /></Field>
                        </div>
                        <Field label="Link"><EditableText value={proj.link} onChange={(link) => patch({ link })} ariaLabel={`Project link ${i + 1}`} placeholder="github.com/you/project" /></Field>
                        <DateRange start={proj.start_date} end={proj.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={proj.name || `Project ${i + 1}`} />
                        <Field label="Highlights"><BulletList bullets={proj.bullets} onChange={(bullets) => patch({ bullets })} label={proj.name || `Project ${i + 1}`} /></Field>
                      </EntryCard>
                    );
                  })}
                  <button className="rd-add" onClick={() => onChange({ projects: [...profile.projects, { name: "", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [""] }] })}>
                    <i className="fa-solid fa-plus" /> Add a project
                  </button>
                </>
              )}

              {key === "skills" && (
                <Field label="Skills"><ChipList values={profile.skills} onChange={(skills) => onChange({ skills })} label="skills" placeholder="Add a skill…" /></Field>
              )}

              {key === "technologies" && (
                <>
                  {Object.entries(profile.technologies).map(([category, items]) => (
                    <Field key={category} label={category}>
                      <ChipList values={items} onChange={(next) => onChange({ technologies: { ...profile.technologies, [category]: next } })} label={category} />
                    </Field>
                  ))}
                </>
              )}

              {key.startsWith("custom:") && (() => {
                const custom = findCustom(profile, key);
                if (!custom) return null;
                return (
                  <>
                    {custom.text && (
                      <EditableArea value={custom.text} onChange={(text) => setCustom(custom.id, { text })} ariaLabel={custom.title} className="rd-edit-area" maxHeight={200} />
                    )}
                    {custom.items.map((it, i) => (
                      <EntryCard key={i} label={it.title || `${custom.title} entry ${i + 1}`} onRemove={() => setCustom(custom.id, { items: custom.items.filter((_, j) => j !== i) })}>
                        <div className="rd-field-row">
                          <Field label="Name"><EditableText value={it.title} onChange={(title) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, title } : x)) })} ariaLabel={`${custom.title} entry ${i + 1}`} placeholder="Name" /></Field>
                          <Field label="Issuer"><EditableText value={it.subtitle} onChange={(subtitle) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, subtitle } : x)) })} ariaLabel={`${custom.title} issuer ${i + 1}`} placeholder="Issuer or organization" /></Field>
                        </div>
                        <DateRange start={it.start_date} end={it.end_date}
                          onStart={(start_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, start_date } : x)) })}
                          onEnd={(end_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, end_date } : x)) })}
                          label={it.title || custom.title} />
                        {it.bullets.length > 0 && (
                          <Field label="Details"><BulletList bullets={it.bullets} onChange={(bullets) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, bullets } : x)) })} label={it.title || custom.title} /></Field>
                        )}
                      </EntryCard>
                    ))}
                    {custom.bullets.length > 0 && (
                      <Field label="Items"><BulletList bullets={custom.bullets} onChange={(bullets) => setCustom(custom.id, { bullets })} label={custom.title} /></Field>
                    )}
                    {custom.items.length === 0 && custom.bullets.length === 0 && !custom.text && (
                      <button className="rd-add" onClick={() => setCustom(custom.id, { bullets: [""] })}>
                        <i className="fa-solid fa-plus" /> Add a line
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </section>
        );
      })}
    </div>
  );
}
