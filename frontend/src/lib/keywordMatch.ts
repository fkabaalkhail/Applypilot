// Client-side keyword/ATS analysis. Given the job's important keywords (matched
// + missing, from the step-1 analysis) and the CURRENT resume document, compute
// per-keyword coverage so the ATS panel and the heatmap update live as the user
// edits — no backend round-trip, no LLM.

import { documentToText, type ResumeDocument } from "./resumeDocument";

export type KeywordStatus = "green" | "yellow" | "red";

export interface KeywordResult {
  keyword: string;
  status: KeywordStatus; // green = present, yellow = partial/stem, red = missing
}

export interface KeywordAnalysis {
  results: KeywordResult[];
  matched: number; // green count
  partial: number; // yellow count
  total: number;
  coverage: number; // 0-100, weights partials at 0.5
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wholeWord(text: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}(?:[^a-z0-9]|$)`, "i").test(text);
}

function statusFor(text: string, keyword: string): KeywordStatus {
  const k = keyword.toLowerCase().trim();
  if (!k) return "red";
  const words = k.split(/\s+/);
  if (words.length > 1) {
    if (text.includes(k)) return "green"; // exact phrase
    const present = words.filter((w) => wholeWord(text, w)).length;
    if (present === words.length) return "green";
    return present > 0 ? "yellow" : "red";
  }
  if (wholeWord(text, k)) return "green";
  return text.includes(k) ? "yellow" : "red"; // substring (stem) match
}

/** Dedupe + drop blanks, preserving first-seen order. */
function cleanKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim();
    const key = k.toLowerCase();
    if (k && !seen.has(key)) {
      seen.add(key);
      out.push(k);
    }
  }
  return out;
}

export function analyzeKeywords(keywords: string[], doc: ResumeDocument): KeywordAnalysis {
  const text = documentToText(doc).toLowerCase();
  const list = cleanKeywords(keywords);
  const results = list.map((keyword) => ({ keyword, status: statusFor(text, keyword) }));
  const matched = results.filter((r) => r.status === "green").length;
  const partial = results.filter((r) => r.status === "yellow").length;
  const total = results.length;
  const coverage = total === 0 ? 100 : Math.round((100 * (matched + 0.5 * partial)) / total);
  return { results, matched, partial, total, coverage };
}

/** Present keywords (green/yellow) to highlight on the rendered resume. */
export function heatmapTerms(analysis: KeywordAnalysis): { term: string; color: Exclude<KeywordStatus, "red"> }[] {
  return analysis.results
    .filter((r) => r.status !== "red")
    .map((r) => ({ term: r.keyword, color: r.status as Exclude<KeywordStatus, "red"> }));
}
