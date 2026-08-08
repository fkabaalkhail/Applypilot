/**
 * Pure job-application evidence check — no chrome.* and no DOM, so it
 * unit-tests cleanly (crossFrame.ts style).
 *
 * The content script runs on every page, and the generic field categories
 * (name / email / phone / address) match login, newsletter, checkout and
 * contact forms on virtually every site. Auto-mounting the panel therefore
 * must NOT trigger on "some recognized field" — it needs evidence that the
 * form is a job application. ATS-host mounting (adapter / apply-entry) is
 * decided separately in contentScript.ts; this predicate covers the unknown-
 * host generic pipeline.
 */
import type { FieldCategory } from "../shared/types";

/** Categories that essentially only appear on a job application — any one is proof. */
const APPLICATION_ONLY: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "resumeUpload",
  "coverLetter",
  "workAuthorization",
  "sponsorship",
  "eeoGender",
  "eeoGenderIdentity",
  "eeoRace",
  "eeoHispanic",
  "eeoVeteran",
  "eeoDisability",
  "eeoSexualOrientation",
  "eeoOther",
]);

/**
 * Structured work/education history. Any one of these is rare outside a job
 * application, but not unique to one — a university contact form asks for
 * "School", a loan form for "Highest level of education". So one strong
 * category needs a single job-flavored partner, no more.
 */
const STRONG: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "school",
  "degree",
  "graduationYear",
  "experienceStartDate",
  "experienceEndDate",
  "experienceDescription",
  "experienceCurrent",
]);

/**
 * Job-flavored, but common on pages that are NOT applications. "Company" +
 * "Job title" is on every B2B demo-request and contact-sales form; LinkedIn +
 * GitHub is a developer's profile-settings page. Two of these is a coincidence,
 * so weak evidence needs THREE distinct categories — or two plus a page-context
 * hint that we are on a job page at all.
 */
const WEAK: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "linkedin",
  "github",
  "portfolio",
  "education",
  "experience",
  "currentCompany",
  "currentTitle",
  "salary",
  "skills",
]);

/** The page the scan came from. Optional and inert — a hint can only upgrade
 *  existing weak field evidence, never manufacture evidence of its own. */
export interface PageContext {
  /** Full page URL; only the path + query are inspected (hosts are noisy). */
  url?: string;
  /** document.title. */
  title?: string;
}

/** Whole-word job-page vocabulary — "careership" and "sniperjobs" must not hit. */
const JOB_PAGE_HINT =
  /(?:^|[^a-z])(?:careers?|jobs?|apply|application|requisition|vacanc[a-z]*|job-?post[a-z]*)(?:[^a-z]|$)/i;

/** Does the URL path/query or the page title read as a job page? */
function onJobPage(context: PageContext | undefined): boolean {
  if (!context) return false;
  let fromUrl = "";
  if (context.url) {
    try {
      const u = new URL(context.url);
      fromUrl = u.pathname + u.search;
    } catch {
      fromUrl = context.url; // not parseable — test it whole rather than drop it
    }
  }
  return JOB_PAGE_HINT.test(fromUrl) || JOB_PAGE_HINT.test(context.title ?? "");
}

/**
 * Does this scan look like a job-application form (vs. a login / signup /
 * checkout / contact / demo-request form)? Evidence is tiered:
 *
 *   - any application-only category            → yes
 *   - one strong category + any other job field → yes
 *   - three distinct weak categories            → yes
 *   - two distinct weak categories on a job page → yes
 *
 * Anything less is left to the toolbar icon, which opens the panel on demand
 * anywhere.
 */
export function looksLikeJobApplication(
  fields: readonly { category: FieldCategory }[],
  context?: PageContext
): boolean {
  const strong = new Set<FieldCategory>();
  const weak = new Set<FieldCategory>();
  for (const f of fields) {
    if (APPLICATION_ONLY.has(f.category)) return true;
    if (STRONG.has(f.category)) strong.add(f.category);
    else if (WEAK.has(f.category)) weak.add(f.category);
  }
  if (strong.size > 0 && strong.size + weak.size >= 2) return true;
  if (weak.size >= 3) return true;
  return weak.size >= 2 && onJobPage(context);
}
