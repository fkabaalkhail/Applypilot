// Structured resume document — the single source of truth shared by the
// renderer (preview), the PDF export, and the DOCX export. Mirrors the backend
// Pydantic models in backend/schemas/resume_document.py.

export type SectionType =
  | "summary"
  | "experience"
  | "education"
  | "projects"
  | "skills"
  | "technologies"
  | "certifications"
  | "custom";

export interface SectionItem {
  id: string;
  title: string;
  subtitle: string;
  location: string;
  start_date: string;
  end_date: string;
  detail: string;
  link: string;
  bullets: string[];
}

export interface Section {
  id: string;
  type: SectionType;
  title: string;
  text: string;
  items: SectionItem[];
  skills: string[];
  groups: Record<string, string[]>;
}

export interface Theme {
  template_id: string;
  font_family: string;
  base_font_pt: number;
  name_font_pt: number;
  heading_font_pt: number;
  section_spacing_pt: number;
  line_height: number;
  accent_color: string;
  text_color: string;
  columns: number;
  page_size: "letter" | "a4";
}

export interface ResumeHeader {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  other_link: string;
}

export interface ResumeDocument {
  header: ResumeHeader;
  sections: Section[];
  theme: Theme;
}

export const DEFAULT_THEME: Theme = {
  template_id: "classic",
  font_family: "Calibri, 'Segoe UI', Helvetica, Arial, sans-serif",
  base_font_pt: 10.5,
  name_font_pt: 22,
  heading_font_pt: 12,
  section_spacing_pt: 12,
  line_height: 1.28,
  accent_color: "#1f2937",
  text_color: "#1f2937",
  columns: 1,
  page_size: "letter",
};

/** Flatten a document to clean plain text (for the Copy button). Mirrors the
 *  backend document_to_text so copied text matches what was scored. */
export function documentToText(doc: ResumeDocument): string {
  const lines: string[] = [];
  const h = doc.header;
  if (h.name) lines.push(h.name);
  const contact = [h.location, h.email, h.phone].filter(Boolean).join(" | ");
  if (contact) lines.push(contact);
  const links = [h.linkedin_url, h.github_url, h.other_link].filter(Boolean).join(" | ");
  if (links) lines.push(links);

  for (const section of doc.sections) {
    lines.push("");
    lines.push((section.title || section.type).toUpperCase());

    if ((section.type === "summary" || section.type === "custom") && section.text) {
      lines.push(section.text);
    }
    if (section.skills.length) lines.push(section.skills.join(", "));
    for (const [category, items] of Object.entries(section.groups || {})) {
      if (items.length) lines.push(`${category}: ${items.join(", ")}`);
    }
    for (const item of section.items) {
      const heading = [item.title, item.subtitle].filter(Boolean).join(" — ");
      const dates = [item.start_date, item.end_date].filter(Boolean).join(" - ");
      const head = [heading, dates].filter(Boolean).join("  ");
      if (head) lines.push(head);
      if (item.detail) lines.push(item.detail);
      for (const b of item.bullets) {
        if (b.trim()) lines.push(`- ${b.trim()}`);
      }
    }
  }
  return lines.join("\n").trim();
}
