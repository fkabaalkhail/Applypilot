// Deterministic skill-tag coverage against the user's primary resume.
// Same whole-word semantics as lib/keywordMatch, but over plain text and
// cached per session so the Jobs detail panel costs zero AI calls.

import api from "../auth/api";
import { documentToText } from "./resumeDocument";
import { profileToDocument } from "./resumeProfile";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wholeWord(text: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}(?:[^a-z0-9]|$)`, "i").test(text);
}

export function skillCovered(resumeText: string, skill: string): boolean {
  const text = (resumeText || "").toLowerCase();
  const k = (skill || "").toLowerCase().trim();
  if (!text || !k) return false;
  const words = k.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return false;
  if (words.length > 1) {
    if (text.includes(k)) return true;
    return words.every((w) => wholeWord(text, w));
  }
  return wholeWord(text, words[0]);
}

let cached: Promise<string> | null = null;

/** Primary resume as plain text, fetched once per session ("" when none). */
export function getPrimaryResumeText(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      try {
        const { data: list } = await api.get("/resumes");
        if (!Array.isArray(list) || list.length === 0) return "";
        const primary = list.find((r: { is_primary?: boolean }) => r.is_primary) || list[0];
        const { data: detail } = await api.get(`/resumes/${primary.id}`);
        if (!detail?.profile) return "";
        return documentToText(profileToDocument(detail.profile));
      } catch {
        return "";
      }
    })();
  }
  return cached;
}

/** Test hook: forget the session cache. */
export function resetResumeTextCache(): void {
  cached = null;
}
