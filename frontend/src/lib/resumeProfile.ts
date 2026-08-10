// The resume profile as the API returns it, plus the helpers that turn it into
// an ordered list of sections. Mirrors backend/schemas/resume.py and
// backend/services/resume_document.py, keep the two in step.

import { DEFAULT_THEME } from "./resumeDocument";
import type { ResumeDocument, Section, SectionItem } from "./resumeDocument";

export interface ExperienceItem {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

export interface EducationItem {
  school: string;
  degree: string;
  location: string;
  start_date: string;
  end_date: string;
  gpa: string;
  achievements: string[];
  coursework: string[];
}

export interface ProjectItem {
  name: string;
  link: string;
  organization: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

export interface CustomSectionItem {
  title: string;
  subtitle: string;
  location: string;
  start_date: string;
  end_date: string;
  detail: string;
  link: string;
  bullets: string[];
}

/** Certifications, awards, volunteering, publications, languages, anything the
 *  resume has that isn't one of the five sections we model explicitly. */
export interface CustomSection {
  id: string;
  title: string;
  kind: "certifications" | "custom";
  text: string;
  bullets: string[];
  items: CustomSectionItem[];
}

export interface ResumeProfile {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  other_link: string;
  summary: string;
  summary_title: string;
  skills: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  projects: ProjectItem[];
  technologies: Record<string, string[]>;
  custom_sections: CustomSection[];
  section_order: string[];
}

export type Severity = "urgent" | "critical" | "optional";

export interface AnalysisIssue {
  id: string;
  title: string;
  severity: Severity;
  count: number;
  description: string;
  evidence: string[];
  suggestion: string;
  section: string;
}

export interface AnalysisCategory {
  id: string;
  name: string;
  score: number;
  why_it_matters: string;
  issues: AnalysisIssue[];
}

export interface AnalysisReport {
  overall_grade: string;
  letter_grade: string;
  score: number;
  urgent_fix_count: number;
  critical_fix_count: number;
  optional_fix_count: number;
  summary: string;
  highlights: string[];
  strengths: string[];
  categories: AnalysisCategory[];
  analyzed_at: string | null;
}

export interface ResumeDetailData {
  id: number;
  name: string;
  target_job_title: string | null;
  is_primary: boolean;
  profile: ResumeProfile;
  analysis_report: AnalysisReport | null;
  created_at: string;
  updated_at: string;
}

/** Section keys we model explicitly; custom sections are `custom:<id>`. */
export type SectionKey =
  | "summary"
  | "experience"
  | "education"
  | "projects"
  | "skills"
  | "technologies"
  | `custom:${string}`;

const DEFAULT_ORDER: SectionKey[] = [
  "summary",
  "experience",
  "education",
  "projects",
  "skills",
  "technologies",
];

export const SECTION_LABELS: Record<string, string> = {
  summary: "Professional Summary",
  experience: "Work Experience",
  education: "Education",
  projects: "Projects",
  skills: "Skills",
  technologies: "Technologies",
};

export function emptyProfile(): ResumeProfile {
  return {
    name: "", email: "", phone: "", location: "",
    linkedin_url: "", github_url: "", other_link: "",
    summary: "", summary_title: "",
    skills: [], experience: [], education: [], projects: [],
    technologies: {}, custom_sections: [], section_order: [],
  };
}

/** Does this section have anything in it? Empty sections are never rendered. */
export function hasContent(profile: ResumeProfile, key: SectionKey): boolean {
  if (key.startsWith("custom:")) {
    const section = findCustom(profile, key);
    return !!section && (!!section.text.trim() || section.bullets.length > 0 || section.items.length > 0);
  }
  switch (key) {
    case "summary": return !!profile.summary.trim();
    case "experience": return profile.experience.length > 0;
    case "education": return profile.education.length > 0;
    case "projects": return profile.projects.length > 0;
    case "skills": return profile.skills.length > 0;
    case "technologies": return Object.keys(profile.technologies).length > 0;
    default: return false;
  }
}

export function findCustom(profile: ResumeProfile, key: string): CustomSection | undefined {
  return profile.custom_sections.find((c) => `custom:${c.id}` === key);
}

/**
 * The section keys to render, in order. Honors the stored `section_order` (the
 * order they appeared in the uploaded file) and appends anything it omits, so a
 * stale ordering can never hide a section the user actually has.
 */
export function orderedSections(profile: ResumeProfile): SectionKey[] {
  const all: SectionKey[] = [
    ...DEFAULT_ORDER,
    ...profile.custom_sections.map((c) => `custom:${c.id}` as SectionKey),
  ];
  const present = all.filter((key) => hasContent(profile, key));

  const stored = profile.section_order.filter(
    (key): key is SectionKey => present.includes(key as SectionKey),
  );
  return [...stored, ...present.filter((key) => !stored.includes(key))];
}

/** The label a section shows, preferring the user's own heading. */
export function sectionLabel(profile: ResumeProfile, key: SectionKey): string {
  if (key.startsWith("custom:")) return findCustom(profile, key)?.title || "Additional";
  if (key === "summary") return profile.summary_title || SECTION_LABELS.summary;
  return SECTION_LABELS[key] ?? key;
}

const item = (over: Partial<SectionItem>): SectionItem => ({
  id: "", title: "", subtitle: "", location: "",
  start_date: "", end_date: "", detail: "", link: "", bullets: [], ...over,
});

const section = (over: Partial<Section> & Pick<Section, "id" | "type">): Section => ({
  title: "", text: "", items: [], skills: [], groups: {}, ...over,
});

/**
 * Build the printable/exportable document from a profile. Mirrors the backend's
 * `db_record_to_document` so the PDF, the DOCX, and the on-screen canvas agree.
 */
export function profileToDocument(profile: ResumeProfile): ResumeDocument {
  const sections: Section[] = [];

  for (const key of orderedSections(profile)) {
    if (key === "summary") {
      sections.push(section({
        id: "summary", type: "summary",
        title: (profile.summary_title || "Professional Summary").toUpperCase(),
        text: profile.summary,
      }));
    } else if (key === "experience") {
      sections.push(section({
        id: "experience", type: "experience", title: "WORK EXPERIENCE",
        items: profile.experience.map((e, i) => item({
          id: `experience-${i}`, title: e.title, subtitle: e.company, location: e.location,
          start_date: e.start_date, end_date: e.end_date, bullets: e.bullets,
        })),
      }));
    } else if (key === "education") {
      sections.push(section({
        id: "education", type: "education", title: "EDUCATION",
        items: profile.education.map((e, i) => item({
          id: `education-${i}`, title: e.degree, subtitle: e.school, location: e.location,
          start_date: e.start_date, end_date: e.end_date,
          detail: e.gpa ? `GPA: ${e.gpa}` : "",
          bullets: e.coursework.length
            ? [...e.achievements, `Relevant coursework: ${e.coursework.join(", ")}`]
            : e.achievements,
        })),
      }));
    } else if (key === "projects") {
      sections.push(section({
        id: "projects", type: "projects", title: "PROJECTS",
        items: profile.projects.map((p, i) => item({
          id: `projects-${i}`, title: p.name, subtitle: p.organization, location: p.location,
          start_date: p.start_date, end_date: p.end_date, link: p.link, bullets: p.bullets,
        })),
      }));
    } else if (key === "skills") {
      sections.push(section({ id: "skills", type: "skills", title: "SKILLS", skills: profile.skills }));
    } else if (key === "technologies") {
      sections.push(section({
        id: "technologies", type: "technologies", title: "TECHNOLOGIES", groups: profile.technologies,
      }));
    } else {
      const custom = findCustom(profile, key);
      if (!custom) continue;
      const items = custom.items.map((it, i) => item({ ...it, id: `custom-${custom.id}-${i}` }));
      if (custom.bullets.length) {
        items.push(item({ id: `custom-${custom.id}-bullets`, bullets: custom.bullets }));
      }
      sections.push(section({
        id: `custom-${custom.id}`,
        type: custom.kind === "certifications" ? "certifications" : "custom",
        title: custom.title.toUpperCase(), text: custom.text, items,
      }));
    }
  }

  const { name, email, phone, location, linkedin_url, github_url, other_link } = profile;
  return {
    header: { name, email, phone, location, linkedin_url, github_url, other_link },
    sections,
    theme: DEFAULT_THEME,
  };
}

/** Which resume section an analysis issue points at, matched loosely on label. */
export function issueMatchesSection(issueSection: string, label: string): boolean {
  const a = issueSection.trim().toLowerCase();
  const b = label.trim().toLowerCase();
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** The analysis findings that point at a section, summed by severity for its heading badge. */
export function sectionFlags(
  report: AnalysisReport | null,
  label: string,
): { severity: Severity; count: number }[] {
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
