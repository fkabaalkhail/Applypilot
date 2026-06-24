// Pure, immutable update helpers for ResumeDocument editing, plus an undo/redo
// history hook. Keeping mutations here keeps ResumeEditor declarative and makes
// every edit a new document object (so the live preview re-renders predictably).

import { useCallback, useRef, useState } from "react";
import type { ResumeDocument, Section, SectionItem, SectionType, Theme } from "./resumeDocument";

let _counter = 0;
export const newId = (): string => `e${Date.now().toString(36)}${(_counter++).toString(36)}`;

export const ITEM_SECTION_TYPES: SectionType[] = ["experience", "education", "projects", "certifications"];

const SECTION_DEFAULTS: Record<SectionType, { title: string }> = {
  summary: { title: "SUMMARY" },
  experience: { title: "WORK EXPERIENCE" },
  education: { title: "EDUCATION" },
  projects: { title: "PROJECTS" },
  certifications: { title: "CERTIFICATIONS" },
  skills: { title: "SKILLS" },
  technologies: { title: "TECHNOLOGIES" },
  custom: { title: "NEW SECTION" },
};

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  summary: "Summary",
  experience: "Experience",
  education: "Education",
  projects: "Projects",
  certifications: "Certifications",
  skills: "Skills",
  technologies: "Technologies",
  custom: "Custom",
};

function emptyItem(): SectionItem {
  return { id: newId(), title: "", subtitle: "", location: "", start_date: "", end_date: "", detail: "", link: "", bullets: [] };
}

const mapSections = (doc: ResumeDocument, fn: (s: Section) => Section): ResumeDocument => ({
  ...doc,
  sections: doc.sections.map(fn),
});

export const updateHeader = (doc: ResumeDocument, field: keyof ResumeDocument["header"], value: string): ResumeDocument => ({
  ...doc,
  header: { ...doc.header, [field]: value },
});

export const updateTheme = (doc: ResumeDocument, patch: Partial<Theme>): ResumeDocument => ({
  ...doc,
  theme: { ...doc.theme, ...patch },
});

export const updateSection = (doc: ResumeDocument, id: string, patch: Partial<Section>): ResumeDocument =>
  mapSections(doc, (s) => (s.id === id ? { ...s, ...patch } : s));

export const removeSection = (doc: ResumeDocument, id: string): ResumeDocument => ({
  ...doc,
  sections: doc.sections.filter((s) => s.id !== id),
});

export function moveSection(doc: ResumeDocument, id: string, dir: -1 | 1): ResumeDocument {
  const i = doc.sections.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.sections.length) return doc;
  const next = [...doc.sections];
  [next[i], next[j]] = [next[j], next[i]];
  return { ...doc, sections: next };
}

export function addSection(doc: ResumeDocument, type: SectionType): ResumeDocument {
  const section: Section = {
    id: newId(),
    type,
    title: SECTION_DEFAULTS[type].title,
    text: "",
    items: ITEM_SECTION_TYPES.includes(type) ? [emptyItem()] : [],
    skills: [],
    groups: {},
  };
  return { ...doc, sections: [...doc.sections, section] };
}

export const addItem = (doc: ResumeDocument, sectionId: string): ResumeDocument =>
  mapSections(doc, (s) => (s.id === sectionId ? { ...s, items: [...s.items, emptyItem()] } : s));

export const removeItem = (doc: ResumeDocument, sectionId: string, itemId: string): ResumeDocument =>
  mapSections(doc, (s) => (s.id === sectionId ? { ...s, items: s.items.filter((it) => it.id !== itemId) } : s));

export const updateItem = (
  doc: ResumeDocument,
  sectionId: string,
  itemId: string,
  patch: Partial<SectionItem>
): ResumeDocument =>
  mapSections(doc, (s) =>
    s.id === sectionId ? { ...s, items: s.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) } : s
  );

/** Append skills to the first Skills section (deduped, case-insensitive), or
 *  create a Skills section if the resume has none. Powers "apply suggestions". */
export function addSkills(doc: ResumeDocument, skills: string[]): ResumeDocument {
  const toAdd = skills.map((s) => s.trim()).filter(Boolean);
  if (!toAdd.length) return doc;

  const idx = doc.sections.findIndex((s) => s.type === "skills");
  if (idx >= 0) {
    const existing = doc.sections[idx].skills;
    const lower = new Set(existing.map((s) => s.toLowerCase()));
    const merged = [...existing];
    for (const s of toAdd) if (!lower.has(s.toLowerCase())) merged.push(s);
    return { ...doc, sections: doc.sections.map((s, i) => (i === idx ? { ...s, skills: merged } : s)) };
  }

  const section: Section = { id: newId(), type: "skills", title: "SKILLS", text: "", items: [], skills: toAdd, groups: {} };
  return { ...doc, sections: [...doc.sections, section] };
}

// ── Undo/redo history ───────────────────────────────────────────────────────

export interface DocHistory {
  doc: ResumeDocument;
  set: (next: ResumeDocument) => void;
  reset: (doc: ResumeDocument) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 100;

export function useDocumentHistory(initial: ResumeDocument): DocHistory {
  const [stack, setStack] = useState<ResumeDocument[]>([initial]);
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const stackLenRef = useRef(stack.length);
  stackLenRef.current = stack.length;

  const set = useCallback((next: ResumeDocument) => {
    setStack((prev) => {
      const truncated = prev.slice(0, idxRef.current + 1);
      truncated.push(next);
      const trimmed = truncated.slice(-MAX_HISTORY);
      setIdx(trimmed.length - 1);
      return trimmed;
    });
  }, []);

  const reset = useCallback((doc: ResumeDocument) => {
    setStack([doc]);
    setIdx(0);
  }, []);

  const undo = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);
  const redo = useCallback(() => setIdx((i) => Math.min(stackLenRef.current - 1, i + 1)), []);

  return {
    doc: stack[idx],
    set,
    reset,
    undo,
    redo,
    canUndo: idx > 0,
    canRedo: idx < stack.length - 1,
  };
}
