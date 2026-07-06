// The "what changed" layer. Diffs the AI-rewritten document against the
// original (matched by section id + item id) and returns the normalized
// bullet/summary/section-text strings that are new or reworded, so the renderer
// can mark exactly what the rewrite touched.

import type { ResumeDocument } from "./resumeDocument";

export function normalizeLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalized strings in `final` that are new or reworded vs `original`. */
export function changedStrings(original: ResumeDocument, final: ResumeDocument): Set<string> {
  const origSections = new Map(original.sections.map((s) => [s.id, s]));
  const origItems = new Map(
    original.sections.flatMap((s) => s.items.map((it) => [it.id, it] as const))
  );
  const out = new Set<string>();

  for (const sec of final.sections) {
    const os = origSections.get(sec.id);
    // Section text (summary/custom) that is new or reworded.
    if (sec.text.trim() && normalizeLine(sec.text) !== normalizeLine(os?.text ?? "")) {
      out.add(normalizeLine(sec.text));
    }
    for (const it of sec.items) {
      const oi = origItems.get(it.id);
      const before = new Set((oi?.bullets ?? []).map(normalizeLine));
      for (const b of it.bullets) {
        const n = normalizeLine(b);
        if (n && !before.has(n)) out.add(n);
      }
    }
  }
  return out;
}
