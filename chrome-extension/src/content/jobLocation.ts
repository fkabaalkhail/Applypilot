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
import { countryByCode, countryFromName } from "./geo";
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

export function detectJobCountry(doc: Document = document): string | null {
  try {
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
