/** Central configuration constants. */

/** Default ApplyPilot deployment. Both are editable in the popup settings. */
export const DEFAULT_API_BASE_URL = "https://resumate-smoky.vercel.app";
export const DEFAULT_DASHBOARD_URL = "https://resumate-smoky.vercel.app";

/**
 * Placeholder profile endpoint. If the backend does not implement it yet,
 * the API client falls back to the existing GET /settings endpoint and
 * finally to mock data (see src/api/client.ts).
 */
export const PROFILE_ENDPOINT = "/api/user/application-profile";
export const SETTINGS_ENDPOINT = "/settings";

/** Fields at or above this confidence are pre-selected for autofill. */
export const AUTOFILL_CONFIDENCE_THRESHOLD = 0.7;

/** Below this score a field is reported as "unknown" rather than guessed. */
export const MIN_CATEGORY_CONFIDENCE = 0.35;

/** How long a fetched profile is reused before hitting the API again. */
export const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/** DOM attribute used to give scanned controls a stable id across rescans. */
export const FIELD_ID_ATTR = "data-ap-field";

/** Hostname → friendly ATS name, used for the badge in the popup. */
const KNOWN_ATS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /greenhouse\.io$/i, name: "Greenhouse" },
  { pattern: /lever\.co$/i, name: "Lever" },
  { pattern: /(myworkdayjobs|myworkdaysite)\.com$/i, name: "Workday" },
  { pattern: /ashbyhq\.com$/i, name: "Ashby" },
  { pattern: /bamboohr\.com$/i, name: "BambooHR" },
  { pattern: /smartrecruiters\.com$/i, name: "SmartRecruiters" },
  { pattern: /icims\.com$/i, name: "iCIMS" },
  { pattern: /jobvite\.com$/i, name: "Jobvite" },
  { pattern: /workable\.com$/i, name: "Workable" },
];

export function detectAtsName(hostname: string): string | null {
  for (const { pattern, name } of KNOWN_ATS) {
    if (pattern.test(hostname)) return name;
  }
  return null;
}

/** Human-friendly names for field categories (popup display). */
export const CATEGORY_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  linkedin: "LinkedIn",
  github: "GitHub",
  portfolio: "Portfolio",
  resumeUpload: "Resume upload",
  coverLetter: "Cover letter",
  workAuthorization: "Work authorization",
  sponsorship: "Sponsorship",
  education: "Education",
  school: "School",
  degree: "Degree",
  graduationYear: "Graduation year",
  experience: "Experience",
  currentCompany: "Current company",
  currentTitle: "Current title",
  salary: "Salary expectations",
  eeoGender: "EEO — Gender",
  eeoRace: "EEO — Race/Ethnicity",
  eeoHispanic: "EEO — Hispanic/Latino",
  eeoVeteran: "EEO — Veteran status",
  eeoDisability: "EEO — Disability",
  eeoOther: "EEO — Demographic",
  unknown: "Unrecognized",
};
