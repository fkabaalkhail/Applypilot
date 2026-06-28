/**
 * Scrapes a job posting's description, title and company from the page so AI
 * answers (POST /api/fill) and the cover-letter generator (Feature B) have
 * context. Best-effort and failure-tolerant: returns empty strings rather than
 * throwing, because AI fill still works (lower quality) without context.
 */
import type { JobContext } from "../shared/types";

const MAX_DESC = 6000;
const MIN_DESC = 200;

const DESC_SELECTORS = [
  '[class*="job-description" i]',
  '[class*="jobdescription" i]',
  '[data-testid*="description" i]',
  '[id*="job-description" i]',
  '[class*="description" i]',
  "article",
  '[role="main"]',
  "main",
];

const SKIP_BLOCK = new Set(["NAV", "FOOTER", "HEADER", "SCRIPT", "STYLE", "NOSCRIPT"]);

function visibleText(el: Element | null): string {
  if (!el) return "";
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function extractDescription(doc: Document): string {
  for (const sel of DESC_SELECTORS) {
    const el = doc.querySelector(sel);
    const text = visibleText(el);
    if (text.length >= MIN_DESC) return text.slice(0, MAX_DESC);
  }
  // Fallback: the largest text block, ignoring chrome/navigation containers.
  let best = "";
  for (const el of Array.from(doc.querySelectorAll("section, article, div, p"))) {
    if (el.closest("nav, footer, header")) continue;
    if (SKIP_BLOCK.has(el.tagName)) continue;
    const text = visibleText(el);
    if (text.length > best.length) best = text;
  }
  return best.length >= MIN_DESC ? best.slice(0, MAX_DESC) : "";
}

function extractTitle(doc: Document): string {
  const h1 = visibleText(doc.querySelector("h1"));
  if (h1) return h1.slice(0, 200);
  const titled = visibleText(doc.querySelector('[class*="title" i]'));
  if (titled) return titled.slice(0, 200);
  return (doc.title || "").trim().slice(0, 200);
}

function extractCompany(doc: Document): string {
  const og = doc
    .querySelector('meta[property="og:site_name"]')
    ?.getAttribute("content");
  if (og && og.trim()) return og.trim().slice(0, 120);
  const named = visibleText(doc.querySelector('[class*="company" i]'));
  if (named) return named.slice(0, 120);
  return "";
}

export function extractJobContext(doc: Document = document): JobContext {
  try {
    return {
      jobDescription: extractDescription(doc),
      jobTitle: extractTitle(doc),
      company: extractCompany(doc),
    };
  } catch {
    return { jobDescription: "", jobTitle: "", company: "" };
  }
}
