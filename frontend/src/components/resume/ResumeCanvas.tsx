import { useMemo, useRef, useState } from "react";
import type {
  AnalysisReport,
  CustomSection,
  ResumeProfile,
  SectionKey,
  Severity,
} from "../../lib/resumeProfile";
import { findCustom, issueMatchesSection, orderedSections, sectionLabel } from "../../lib/resumeProfile";
import { BulletList, ChipList, EditableArea, EditableText } from "./Editable";
import { SEVERITY_LABEL } from "./SeverityRail";

/**
 * The resume, rendered as the page it will become — and editable in place.
 *
 * Sections render in the order they appeared in the uploaded file and can be
 * dragged into a new one. Each heading carries the analysis findings that point
 * at it, so a fix is always one click from the line that needs it.
 */

type Update = (patch: Partial<ResumeProfile>) => void;

/** Which severities have findings pointing at this section. */
function flagsFor(report: AnalysisReport | null, label: string) {
  if (!report) return [];
  const counts: Partial<Record<Severity, number>> = {};
  for (const category of report.categories) {
    for (const issue of category.issues) {
      if (issueMatchesSection(issue.section, label)) {
        counts[issue.severity] = (counts[issue.severity] ?? 0) + issue.count;
      }
    }
  }
  return (["urgent", "critical", "optional"] as Severity[])
    .filter((s) => counts[s])
    .map((s) => ({ severity: s, count: counts[s] as number }));
}

function ContactField({
  icon,
  value,
  onChange,
  label,
  placeholder,
}: {
  icon: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <span className="rd-doc-field">
      <i className={icon} />
      <EditableText value={value} onChange={onChange} ariaLabel={label} placeholder={placeholder} />
    </span>
  );
}

function DatePair({
  start,
  end,
  onStart,
  onEnd,
  label,
}: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  label: string;
}) {
  return (
    <span className="rd-entry-dates">
      <EditableText value={start} onChange={onStart} ariaLabel={`${label} start date`} placeholder="Start" className="rd-edit-date" />
      <span aria-hidden="true" style={{ color: "var(--rd-mute)" }}>→</span>
      <EditableText value={end} onChange={onEnd} ariaLabel={`${label} end date`} placeholder="Present" className="rd-edit-date" />
    </span>
  );
}

function Entry({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) {
  return (
    <div className="rd-entry">
      <button type="button" className="rd-entry-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        <i className="fa-solid fa-trash-can" />
      </button>
      {children}
    </div>
  );
}

export default function ResumeCanvas({
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
  const [dragKey, setDragKey] = useState<SectionKey | null>(null);
  const [overKey, setOverKey] = useState<SectionKey | null>(null);
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

  const drop = (target: SectionKey) => {
    if (!dragKey || dragKey === target) return;
    move(keys.indexOf(dragKey), keys.indexOf(target));
    setDragKey(null);
    setOverKey(null);
  };

  const setCustom = (id: string, patch: Partial<CustomSection>) =>
    onChange({
      custom_sections: profile.custom_sections.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });

  return (
    <div className="rd-sheet">
      <div ref={liveRef} aria-live="polite" className="sr-only" style={{ position: "absolute", left: "-9999px" }} />

      <header className="rd-doc-header">
        <div className="rd-doc-name">
          <EditableText
            value={profile.name}
            onChange={(name) => onChange({ name })}
            ariaLabel="Your name"
            placeholder="Your name"
          />
        </div>
        <div className="rd-doc-contact">
          <ContactField icon="fa-regular fa-envelope" value={profile.email} onChange={(email) => onChange({ email })} label="Email" placeholder="Email" />
          <ContactField icon="fa-solid fa-phone" value={profile.phone} onChange={(phone) => onChange({ phone })} label="Phone" placeholder="Phone" />
          <ContactField icon="fa-solid fa-location-dot" value={profile.location} onChange={(location) => onChange({ location })} label="Location" placeholder="City, Region" />
        </div>
        <div className="rd-doc-contact">
          <ContactField icon="fa-brands fa-linkedin" value={profile.linkedin_url} onChange={(linkedin_url) => onChange({ linkedin_url })} label="LinkedIn URL" placeholder="linkedin.com/in/you" />
          <ContactField icon="fa-brands fa-github" value={profile.github_url} onChange={(github_url) => onChange({ github_url })} label="GitHub URL" placeholder="github.com/you" />
          <ContactField icon="fa-solid fa-globe" value={profile.other_link} onChange={(other_link) => onChange({ other_link })} label="Portfolio or other link" placeholder="your-site.com" />
        </div>
      </header>

      {keys.map((key, index) => {
        const label = sectionLabel(profile, key);
        const flags = flagsFor(report, label);

        return (
          <section
            key={key}
            className={[
              "rd-section",
              dragKey === key ? "is-dragging" : "",
              overKey === key && dragKey !== key ? "is-drop-target" : "",
            ].filter(Boolean).join(" ")}
            onDragOver={(e) => { e.preventDefault(); setOverKey(key); }}
            onDragLeave={() => setOverKey((k) => (k === key ? null : k))}
            onDrop={(e) => { e.preventDefault(); drop(key); }}
          >
            <div className="rd-section-head">
              <button
                type="button"
                className="rd-grip"
                draggable
                aria-label={`Reorder ${label}. Position ${index + 1} of ${keys.length}. Use arrow keys to move.`}
                onDragStart={() => setDragKey(key)}
                onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") { e.preventDefault(); move(index, index - 1); }
                  if (e.key === "ArrowDown") { e.preventDefault(); move(index, index + 1); }
                }}
              >
                <i className="fa-solid fa-grip-vertical" />
              </button>

              <h2 className="rd-section-title">{label}</h2>

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

            {key === "summary" && (
              <EditableArea
                value={profile.summary}
                onChange={(summary) => onChange({ summary })}
                ariaLabel="Professional summary"
                placeholder="Two or three sentences on what you do and what you've shipped."
                className="rd-edit-area"
              />
            )}

            {key === "experience" && (
              <>
                {profile.experience.map((exp, i) => {
                  const patch = (p: Partial<typeof exp>) =>
                    onChange({ experience: profile.experience.map((e, j) => (j === i ? { ...e, ...p } : e)) });
                  return (
                    <Entry key={i} label={exp.company || `experience ${i + 1}`} onRemove={() => onChange({ experience: profile.experience.filter((_, j) => j !== i) })}>
                      <div className="rd-entry-top">
                        <EditableText value={exp.company} onChange={(company) => patch({ company })} ariaLabel={`Company ${i + 1}`} placeholder="Company" className="rd-edit-strong" />
                        <DatePair start={exp.start_date} end={exp.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={exp.company || `Experience ${i + 1}`} />
                      </div>
                      <div className="rd-entry-sub">
                        <EditableText value={exp.title} onChange={(title) => patch({ title })} ariaLabel={`Job title ${i + 1}`} placeholder="Job title" />
                        <EditableText value={exp.location} onChange={(location) => patch({ location })} ariaLabel={`Location ${i + 1}`} placeholder="Location" />
                      </div>
                      <BulletList bullets={exp.bullets} onChange={(bullets) => patch({ bullets })} label={exp.company || `Experience ${i + 1}`} />
                    </Entry>
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
                    <Entry key={i} label={edu.school || `education ${i + 1}`} onRemove={() => onChange({ education: profile.education.filter((_, j) => j !== i) })}>
                      <div className="rd-entry-top">
                        <EditableText value={edu.school} onChange={(school) => patch({ school })} ariaLabel={`School ${i + 1}`} placeholder="School" className="rd-edit-strong" />
                        <DatePair start={edu.start_date} end={edu.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={edu.school || `Education ${i + 1}`} />
                      </div>
                      <div className="rd-entry-sub">
                        <EditableText value={edu.degree} onChange={(degree) => patch({ degree })} ariaLabel={`Degree ${i + 1}`} placeholder="Degree" />
                      </div>
                      <div className="rd-doc-contact" style={{ justifyContent: "flex-start", marginTop: "0.25rem" }}>
                        <EditableText value={edu.gpa} onChange={(gpa) => patch({ gpa })} ariaLabel={`GPA ${i + 1}`} placeholder="GPA" className="rd-edit-date" />
                        <EditableText value={edu.location} onChange={(location) => patch({ location })} ariaLabel={`Education location ${i + 1}`} placeholder="Location" />
                      </div>
                      <BulletList bullets={edu.achievements} onChange={(achievements) => patch({ achievements })} label={`${edu.school || "Education"} achievements`} />
                      <div style={{ marginTop: "0.75rem" }}>
                        <span className="rd-eyebrow">Relevant coursework</span>
                        <ChipList values={edu.coursework} onChange={(coursework) => patch({ coursework })} label="coursework" placeholder="Add a course…" />
                      </div>
                    </Entry>
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
                    <Entry key={i} label={proj.name || `project ${i + 1}`} onRemove={() => onChange({ projects: profile.projects.filter((_, j) => j !== i) })}>
                      <div className="rd-entry-top">
                        <EditableText value={proj.name} onChange={(name) => patch({ name })} ariaLabel={`Project ${i + 1}`} placeholder="Project name" className="rd-edit-strong" />
                        <DatePair start={proj.start_date} end={proj.end_date} onStart={(start_date) => patch({ start_date })} onEnd={(end_date) => patch({ end_date })} label={proj.name || `Project ${i + 1}`} />
                      </div>
                      <div className="rd-entry-sub">
                        <EditableText value={proj.organization} onChange={(organization) => patch({ organization })} ariaLabel={`Project organization ${i + 1}`} placeholder="Course, club, or company" />
                        <EditableText value={proj.link} onChange={(link) => patch({ link })} ariaLabel={`Project link ${i + 1}`} placeholder="Link" />
                      </div>
                      <BulletList bullets={proj.bullets} onChange={(bullets) => patch({ bullets })} label={proj.name || `Project ${i + 1}`} />
                    </Entry>
                  );
                })}
                <button className="rd-add" onClick={() => onChange({ projects: [...profile.projects, { name: "", link: "", organization: "", location: "", start_date: "", end_date: "", bullets: [""] }] })}>
                  <i className="fa-solid fa-plus" /> Add a project
                </button>
              </>
            )}

            {key === "skills" && (
              <ChipList values={profile.skills} onChange={(skills) => onChange({ skills })} label="skills" placeholder="Add a skill…" />
            )}

            {key === "technologies" && (
              <>
                {Object.entries(profile.technologies).map(([category, items]) => (
                  <div className="rd-tech-group" key={category}>
                    <span className="rd-tech-label">{category}</span>
                    <ChipList
                      values={items}
                      onChange={(next) => onChange({ technologies: { ...profile.technologies, [category]: next } })}
                      label={category}
                    />
                  </div>
                ))}
              </>
            )}

            {key.startsWith("custom:") && (() => {
              const custom = findCustom(profile, key);
              if (!custom) return null;
              return (
                <>
                  {custom.text && (
                    <EditableArea
                      value={custom.text}
                      onChange={(text) => setCustom(custom.id, { text })}
                      ariaLabel={custom.title}
                      className="rd-edit-area"
                    />
                  )}
                  {custom.items.map((it, i) => (
                    <Entry
                      key={i}
                      label={it.title || `${custom.title} entry ${i + 1}`}
                      onRemove={() => setCustom(custom.id, { items: custom.items.filter((_, j) => j !== i) })}
                    >
                      <div className="rd-entry-top">
                        <EditableText
                          value={it.title}
                          onChange={(title) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, title } : x)) })}
                          ariaLabel={`${custom.title} entry ${i + 1}`}
                          placeholder="Name"
                          className="rd-edit-strong"
                        />
                        <DatePair
                          start={it.start_date}
                          end={it.end_date}
                          onStart={(start_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, start_date } : x)) })}
                          onEnd={(end_date) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, end_date } : x)) })}
                          label={it.title || custom.title}
                        />
                      </div>
                      <div className="rd-entry-sub">
                        <EditableText
                          value={it.subtitle}
                          onChange={(subtitle) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, subtitle } : x)) })}
                          ariaLabel={`${custom.title} issuer ${i + 1}`}
                          placeholder="Issuer or organization"
                        />
                      </div>
                      {it.bullets.length > 0 && (
                        <BulletList
                          bullets={it.bullets}
                          onChange={(bullets) => setCustom(custom.id, { items: custom.items.map((x, j) => (j === i ? { ...x, bullets } : x)) })}
                          label={it.title || custom.title}
                        />
                      )}
                    </Entry>
                  ))}
                  {custom.bullets.length > 0 && (
                    <BulletList
                      bullets={custom.bullets}
                      onChange={(bullets) => setCustom(custom.id, { bullets })}
                      label={custom.title}
                    />
                  )}
                  {custom.items.length === 0 && custom.bullets.length === 0 && !custom.text && (
                    <button className="rd-add" onClick={() => setCustom(custom.id, { bullets: [""] })}>
                      <i className="fa-solid fa-plus" /> Add a line
                    </button>
                  )}
                </>
              );
            })()}
          </section>
        );
      })}
    </div>
  );
}
