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
 * Job-flavored categories that individually also show up elsewhere (a GitHub
 * URL on profile settings, "annual income" on a loan form). Two DISTINCT ones
 * together read as an application, not a coincidence.
 */
const JOB_FLAVORED: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "linkedin",
  "github",
  "portfolio",
  "education",
  "school",
  "degree",
  "graduationYear",
  "experience",
  "currentCompany",
  "currentTitle",
  "experienceStartDate",
  "experienceEndDate",
  "experienceDescription",
  "experienceCurrent",
  "salary",
  "skills",
]);

/**
 * Does this scan look like a job-application form (vs. a login / signup /
 * checkout / contact form)? True when any application-only category is
 * present, or when at least two distinct job-flavored categories are.
 */
export function looksLikeJobApplication(fields: readonly { category: FieldCategory }[]): boolean {
  const flavored = new Set<FieldCategory>();
  for (const f of fields) {
    if (APPLICATION_ONLY.has(f.category)) return true;
    if (JOB_FLAVORED.has(f.category)) flavored.add(f.category);
  }
  return flavored.size >= 2;
}
