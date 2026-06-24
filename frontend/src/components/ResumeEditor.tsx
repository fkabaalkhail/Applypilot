import { useMemo } from "react";
import type { RefObject } from "react";
import { FittedResume } from "./ResumeRenderer";
import AiAssistTextarea, { AssistProvider } from "./AiAssistTextarea";
import { analyzeKeywords } from "../lib/keywordMatch";
import type { ResumeDocument, Section, SectionItem, SectionType } from "../lib/resumeDocument";
import {
  ITEM_SECTION_TYPES,
  SECTION_TYPE_LABELS,
  addItem,
  addSection,
  moveSection,
  removeItem,
  removeSection,
  updateHeader,
  updateItem,
  updateSection,
  updateTheme,
} from "../lib/resumeEdit";
import "../resume-editor.css";

// Visual resume editor (Phase 2): structured controls on the left, the SAME
// ResumeRenderer used for preview/PDF/DOCX on the right. Every edit produces a
// new document via the pure helpers in resumeEdit.ts, so the live preview (and
// therefore the export) updates instantly. Controlled via value/onChange; the
// parent owns undo/redo history.

interface ResumeEditorProps {
  value: ResumeDocument;
  onChange: (doc: ResumeDocument) => void;
  previewRef?: RefObject<HTMLDivElement>;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Job keywords — shows a live ATS coverage badge in the toolbar when set. */
  keywords?: string[];
  /** Job id — enables the inline AI assistant on text fields when set. */
  jobId?: number | null;
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Calibri (sans)", value: "Calibri, 'Segoe UI', Helvetica, Arial, sans-serif" },
  { label: "Arial (sans)", value: "Arial, Helvetica, sans-serif" },
  { label: "Georgia (serif)", value: "Georgia, 'Times New Roman', serif" },
  { label: "Garamond (serif)", value: "Garamond, Georgia, 'Times New Roman', serif" },
];

const ADDABLE_TYPES: SectionType[] = [
  "summary",
  "experience",
  "education",
  "projects",
  "certifications",
  "skills",
  "technologies",
  "custom",
];

const ITEM_LABELS: Partial<Record<SectionType, { title: string; subtitle: string }>> = {
  experience: { title: "Role / title", subtitle: "Company" },
  education: { title: "Degree", subtitle: "School" },
  projects: { title: "Project name", subtitle: "Organization" },
  certifications: { title: "Certification", subtitle: "Issuer" },
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  full,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  full?: boolean;
}) {
  return (
    <label className={`redit-field${full ? " full" : ""}`}>
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export default function ResumeEditor({
  value,
  onChange,
  previewRef,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  keywords,
  jobId,
}: ResumeEditorProps) {
  const theme = value.theme;
  const ats = useMemo(() => (keywords && keywords.length ? analyzeKeywords(keywords, value) : null), [keywords, value]);
  const covColor = ats ? (ats.coverage >= 80 ? "#16a34a" : ats.coverage >= 55 ? "#d97706" : "#dc2626") : undefined;
  const assistValue = useMemo(() => ({ jobId }), [jobId]);

  return (
    <AssistProvider value={assistValue}>
    <div className="redit">
      <div className="redit-toolbar">
        <div className="redit-tb-group">
          <button className="redit-tb-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button className="redit-tb-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
            ↷ Redo
          </button>
        </div>

        {ats && (
          <div
            className="redit-tb-group"
            style={{ fontSize: "0.8rem", fontWeight: 700, color: covColor }}
            title="Live ATS keyword coverage"
          >
            ATS {ats.coverage}% · {ats.matched}/{ats.total}
          </div>
        )}

        <div className="redit-tb-group">
          <label className="redit-tb-control">
            Font
            <select value={theme.font_family} onChange={(e) => onChange(updateTheme(value, { font_family: e.target.value }))}>
              {FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="redit-tb-control">
            Size
            <input
              type="number"
              min={8}
              max={14}
              step={0.5}
              value={theme.base_font_pt}
              onChange={(e) => onChange(updateTheme(value, { base_font_pt: Number(e.target.value) || 10.5 }))}
            />
          </label>
          <label className="redit-tb-control">
            Accent
            <input
              type="color"
              value={theme.accent_color}
              onChange={(e) => onChange(updateTheme(value, { accent_color: e.target.value, text_color: e.target.value }))}
            />
          </label>
          <label className="redit-tb-control">
            Page
            <select
              value={theme.page_size}
              onChange={(e) => onChange(updateTheme(value, { page_size: e.target.value as "letter" | "a4" }))}
            >
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </label>
        </div>

        <label className="redit-tb-control redit-add">
          + Add section
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onChange(addSection(value, e.target.value as SectionType));
            }}
          >
            <option value="" disabled>
              choose…
            </option>
            {ADDABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {SECTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="redit-body">
        <div className="redit-controls">
          {/* Contact header */}
          <div className="redit-card">
            <div className="redit-card-head">
              <span className="redit-card-title">Contact</span>
            </div>
            <div className="redit-grid">
              <Field label="Full name" value={value.header.name} onChange={(v) => onChange(updateHeader(value, "name", v))} />
              <Field label="Email" value={value.header.email} onChange={(v) => onChange(updateHeader(value, "email", v))} />
              <Field label="Phone" value={value.header.phone} onChange={(v) => onChange(updateHeader(value, "phone", v))} />
              <Field label="Location" value={value.header.location} onChange={(v) => onChange(updateHeader(value, "location", v))} />
              <Field label="LinkedIn" value={value.header.linkedin_url} onChange={(v) => onChange(updateHeader(value, "linkedin_url", v))} />
              <Field label="GitHub" value={value.header.github_url} onChange={(v) => onChange(updateHeader(value, "github_url", v))} />
              <Field label="Other link" value={value.header.other_link} onChange={(v) => onChange(updateHeader(value, "other_link", v))} full />
            </div>
          </div>

          {value.sections.map((section, i) => (
            <SectionEditor
              key={section.id}
              section={section}
              isFirst={i === 0}
              isLast={i === value.sections.length - 1}
              doc={value}
              onChange={onChange}
            />
          ))}

          {value.sections.length === 0 && (
            <p className="redit-empty">No sections yet — use “+ Add section” above to start building.</p>
          )}
        </div>

        <div className="redit-preview">
          <FittedResume document={value} innerRef={previewRef} />
        </div>
      </div>
    </div>
    </AssistProvider>
  );
}

function SectionEditor({
  section,
  isFirst,
  isLast,
  doc,
  onChange,
}: {
  section: Section;
  isFirst: boolean;
  isLast: boolean;
  doc: ResumeDocument;
  onChange: (doc: ResumeDocument) => void;
}) {
  const isItemType = ITEM_SECTION_TYPES.includes(section.type);

  return (
    <div className="redit-card">
      <div className="redit-card-head">
        <input
          className="redit-section-title"
          value={section.title}
          onChange={(e) => onChange(updateSection(doc, section.id, { title: e.target.value }))}
        />
        <div className="redit-card-actions">
          <button className="redit-icon" title="Move up" disabled={isFirst} onClick={() => onChange(moveSection(doc, section.id, -1))}>
            ↑
          </button>
          <button className="redit-icon" title="Move down" disabled={isLast} onClick={() => onChange(moveSection(doc, section.id, 1))}>
            ↓
          </button>
          <button className="redit-icon danger" title="Delete section" onClick={() => onChange(removeSection(doc, section.id))}>
            ✕
          </button>
        </div>
      </div>

      {(section.type === "summary" || section.type === "custom") && (
        <AiAssistTextarea
          className="redit-textarea"
          rows={4}
          placeholder="Write a short professional summary…"
          value={section.text}
          onChange={(v) => onChange(updateSection(doc, section.id, { text: v }))}
        />
      )}

      {section.type === "skills" && (
        <label className="redit-field full">
          <span>Skills (one per line)</span>
          <textarea
            className="redit-textarea"
            rows={4}
            value={section.skills.join("\n")}
            onChange={(e) => onChange(updateSection(doc, section.id, { skills: e.target.value.split("\n") }))}
          />
        </label>
      )}

      {section.type === "technologies" && <GroupsEditor section={section} doc={doc} onChange={onChange} />}

      {isItemType && (
        <div className="redit-items">
          {section.items.map((item) => (
            <ItemEditor key={item.id} item={item} section={section} doc={doc} onChange={onChange} />
          ))}
          <button className="redit-add-btn" onClick={() => onChange(addItem(doc, section.id))}>
            + Add entry
          </button>
        </div>
      )}
    </div>
  );
}

function ItemEditor({
  item,
  section,
  doc,
  onChange,
}: {
  item: SectionItem;
  section: Section;
  doc: ResumeDocument;
  onChange: (doc: ResumeDocument) => void;
}) {
  const labels = ITEM_LABELS[section.type] ?? { title: "Title", subtitle: "Subtitle" };
  const set = (patch: Partial<SectionItem>) => onChange(updateItem(doc, section.id, item.id, patch));

  return (
    <div className="redit-item">
      <button className="redit-item-remove" title="Remove entry" onClick={() => onChange(removeItem(doc, section.id, item.id))}>
        ✕
      </button>
      <div className="redit-grid">
        <Field label={labels.title} value={item.title} onChange={(v) => set({ title: v })} />
        <Field label={labels.subtitle} value={item.subtitle} onChange={(v) => set({ subtitle: v })} />
        <Field label="Location" value={item.location} onChange={(v) => set({ location: v })} />
        <Field label="Start" value={item.start_date} onChange={(v) => set({ start_date: v })} placeholder="YYYY" />
        <Field label="End" value={item.end_date} onChange={(v) => set({ end_date: v })} placeholder="YYYY or Present" />
        <Field label="Detail (GPA, etc.)" value={item.detail} onChange={(v) => set({ detail: v })} />
        {(section.type === "projects" || section.type === "certifications") && (
          <Field label="Link" value={item.link} onChange={(v) => set({ link: v })} full />
        )}
      </div>
      <label className="redit-field full">
        <span>Bullet points (one per line)</span>
        <AiAssistTextarea
          className="redit-textarea"
          rows={Math.min(8, Math.max(3, item.bullets.length + 1))}
          value={item.bullets.join("\n")}
          onChange={(v) => set({ bullets: v.split("\n") })}
        />
      </label>
    </div>
  );
}

function GroupsEditor({
  section,
  doc,
  onChange,
}: {
  section: Section;
  doc: ResumeDocument;
  onChange: (doc: ResumeDocument) => void;
}) {
  const entries = Object.entries(section.groups || {});

  const setGroups = (next: Record<string, string[]>) => onChange(updateSection(doc, section.id, { groups: next }));

  const renameCategory = (oldKey: string, newKey: string) => {
    const next: Record<string, string[]> = {};
    for (const [k, v] of entries) next[k === oldKey ? newKey : k] = v;
    setGroups(next);
  };
  const setItems = (key: string, items: string[]) => {
    const next: Record<string, string[]> = {};
    for (const [k, v] of entries) next[k] = k === key ? items : v;
    setGroups(next);
  };
  const removeCategory = (key: string) => {
    const next: Record<string, string[]> = {};
    for (const [k, v] of entries) if (k !== key) next[k] = v;
    setGroups(next);
  };
  const addCategory = () => {
    const base = "Category";
    let name = base;
    let n = 1;
    while (name in section.groups) name = `${base} ${++n}`;
    setGroups({ ...section.groups, [name]: [] });
  };

  return (
    <div className="redit-groups">
      {entries.map(([category, items]) => (
        <div key={category} className="redit-group-row">
          <input
            className="redit-group-cat"
            value={category}
            onChange={(e) => renameCategory(category, e.target.value)}
          />
          <input
            className="redit-group-items"
            placeholder="comma-separated"
            value={items.join(", ")}
            onChange={(e) => setItems(category, e.target.value.split(",").map((s) => s.trim()))}
          />
          <button className="redit-icon danger" title="Remove category" onClick={() => removeCategory(category)}>
            ✕
          </button>
        </div>
      ))}
      <button className="redit-add-btn" onClick={addCategory}>
        + Add category
      </button>
    </div>
  );
}
