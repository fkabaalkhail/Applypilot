/**
 * Which country the JOB is in, read from structured page data only:
 *
 *   1. schema.org JobPosting JSON-LD (`jobLocation.address.addressCountry`),
 *      which Greenhouse, Lever, Workday, SmartRecruiters and many career
 *      sites embed for search engines;
 *   2. the ATS's own location element (a short "Toronto, ON" / "Remote - US"
 *      line in the posting header).
 *
 * The answer is a country only when every signal found agrees on one; mixed
 * or unparseable locations give null. Questions like "Are you authorized to
 * work in this country?" or an unscoped "Will you require sponsorship?" are
 * answered for THIS country, so a wrong guess here would be a wrong legal
 * answer there: null (and an abstention) is the safe failure.
 */
import { countryByCode, countryFromName, regionFromText } from "./geo";
import { parseAddress } from "./profileFacts";

const LOCATION_SELECTORS = [
  ".job__location",
  ".location",
  ".posting-categories .location",
  ".sort-by-location",
  '[data-automation-id="locations"]',
  '[data-ui="job-location"]',
  '[itemprop="jobLocation"]',
  '[class*="job-location" i]',
  '[class*="jobLocation" i]',
  '[class*="posting-location" i]',
  '[data-testid*="location" i]',
];

const ATS_NAMES = /^(greenhouse|lever|workday|ashby|ashbyhq|workable|smartrecruiters|bamboohr|jobvite|icims|taleo|oracle|successfactors|careers|jobs|job board|job boards)$/i;

function countryOfText(text: string): string | null {
  const t = (text || "").trim();
  if (!t || t.length > 120) return null;
  const whole = countryFromName(t);
  if (whole) return whole.code;
  const parsed = parseAddress(t.replace(/^remote\s*[-–:(]?\s*/i, "").replace(/\)$/, ""));
  if (parsed.country) return parsed.country.code;
  if (parsed.region) return parsed.region.country;
  if (parsed.postal) return parsed.postal.country;
  return null;
}

function jsonLdCountries(doc: Document): string[] {
  const out: string[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent || "");
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const n = node as Record<string, unknown>;
      const graph = Array.isArray(n?.["@graph"]) ? (n["@graph"] as unknown[]) : [n];
      for (const g of graph) {
        const posting = g as Record<string, unknown>;
        if (!posting || !/JobPosting/i.test(String(posting["@type"] ?? ""))) continue;
        const locs = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
        for (const loc of locs) {
          const address = (loc as Record<string, unknown> | undefined)?.address as Record<string, unknown> | string | undefined;
          if (!address) continue;
          if (typeof address === "string") {
            const c = countryOfText(address);
            if (c) out.push(c);
            continue;
          }
          const raw = address.addressCountry;
          const name = typeof raw === "string" ? raw : String((raw as Record<string, unknown> | undefined)?.name ?? "");
          const code = name.length === 2 ? countryByCode(name)?.code : countryFromName(name)?.code;
          if (code) out.push(code);
          else {
            const c = countryOfText([address.addressLocality, address.addressRegion].filter(Boolean).join(", "));
            if (c) out.push(c);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Workday puts the job's location in its URL: `/job/<Location>/<Title>_<Req>`
 * ("Cambridge-MA", "Dayton-Minnesota-USA-French-Lake", "Texas---Houston-
 * Corporate-Office", "Toronto-ON"), and keeps it on every application step,
 * which otherwise shows no location at all. Only unambiguous evidence counts:
 * a country name, a full state/province name, or an UPPERCASE two-letter code
 * ("MA", "ON"; a lowercase "in"/"or" is a word, not Indiana/Oregon).
 */
export function countryFromWorkdayUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!/myworkday(jobs|site)\.com$/i.test(url.hostname)) return null;
  const m = /\/job\/([^/]+)\//.exec(url.pathname);
  if (!m) return null;
  const tokens = decodeURIComponent(m[1]).split(/[-_,\s]+/).filter(Boolean);
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const pair = i + 1 < tokens.length ? `${t} ${tokens[i + 1]}` : "";
    const triple = i + 2 < tokens.length ? `${t} ${tokens[i + 1]} ${tokens[i + 2]}` : "";
    for (const phrase of [triple, pair, t]) {
      if (!phrase) continue;
      const c = phrase.length === 2 ? null : countryFromName(phrase);
      if (c) found.add(c.code);
      const isCode = /^[A-Z]{2}$/.test(phrase);
      if (isCode || phrase.length > 3) {
        const r = regionFromText(phrase);
        if (r && (isCode || r.name.toLowerCase() === phrase.toLowerCase())) found.add(r.country);
      }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

export function detectJobCountry(doc: Document = document): string | null {
  try {
    const fromUrl = countryFromWorkdayUrl(doc.location?.href ?? "");
    if (fromUrl) return fromUrl;
    const found = jsonLdCountries(doc);
    if (found.length === 0) {
      for (const sel of LOCATION_SELECTORS) {
        for (const el of Array.from(doc.querySelectorAll(sel)).slice(0, 4)) {
          if (el.closest("form")) continue; // a form's own location field is the applicant's
          const c = countryOfText((el.textContent || "").replace(/\s+/g, " "));
          if (c) found.push(c);
        }
        if (found.length) break;
      }
    }
    const distinct = [...new Set(found)];
    return distinct.length === 1 ? distinct[0] : null;
  } catch {
    return null;
  }
}

/** The hiring company, or "" when the page only names its ATS vendor. */
export function sanitizeCompany(name: string): string {
  const n = (name || "").trim();
  return ATS_NAMES.test(n) ? "" : n;
}
