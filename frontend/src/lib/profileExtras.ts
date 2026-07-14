/**
 * Shared model for the "application profile extras" — the structured mailing
 * address, the saved screening answers and the EEO self-identification that live
 * on the application-profile endpoint (camelCase, nested `eeo`) rather than on
 * /settings or the resume.
 *
 * These fields are what the Chrome extension autofills into job applications,
 * so the web app's Profile page edits them through the same endpoint the
 * extension syncs from (`PUT /api/user/application-profile`). Keeping the shape
 * + diff logic here means Profile.tsx and its unit tests share one source of
 * truth. addressCity shares the same DB column as the contact "city"/location.
 */

// EEO / demographic self-identification. Mirrors the extension's EeoAnswers and
// the backend EeoOut/EeoIn (camelCase). Only used by the extension when its
// "Fill EEO fields" setting is on.
export interface EeoData {
  gender: string;
  race: string;
  hispanicLatino: string;
  veteranStatus: string;
  disabilityStatus: string;
}

// Structured mailing address + EEO, persisted via the application-profile
// endpoint. addressCity shares the same DB column as the contact "city".
export interface ProfileExtras {
  addressStreet: string;
  addressCity: string;
  addressState: string;
  postalCode: string;
  country: string;
  /**
   * Answers the extension fills into screening questions. FREE TEXT, not enums:
   * the extension learns these from real application forms and writes back the
   * form's literal option text (see chrome-extension/src/shared/profileCategories.ts),
   * so a stored workAuthorization may read "Yes, I am legally authorized to work
   * in the United States for any employer". Constraining these to a select would
   * destroy the more specific answer that actually matched a form.
   */
  currentTitle: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  eeo: EeoData;
}

// PATCH body for PUT /api/user/application-profile — only changed keys are sent;
// omitted keys are left untouched by the backend.
export interface ProfileUpdatePayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  portfolio?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  postalCode?: string;
  country?: string;
  currentTitle?: string;
  workAuthorization?: string;
  requiresSponsorship?: string;
  salaryExpectation?: string;
  eeo?: Partial<EeoData>;
}

export const EMPTY_EEO: EeoData = {
  gender: "",
  race: "",
  hispanicLatino: "",
  veteranStatus: "",
  disabilityStatus: "",
};

export const EMPTY_PROFILE_EXTRAS: ProfileExtras = {
  addressStreet: "",
  addressCity: "",
  addressState: "",
  postalCode: "",
  country: "",
  currentTitle: "",
  workAuthorization: "",
  requiresSponsorship: "",
  salaryExpectation: "",
  eeo: { ...EMPTY_EEO },
};

// Field labels + option lists for the EEO selects — shared so the web app and
// (conceptually) the extension present the same choices.
export const EEO_OPTIONS = {
  gender: ["Male", "Female", "Non-binary", "Prefer not to say"],
  race: [
    "American Indian or Alaska Native",
    "Asian",
    "Black or African American",
    "Hispanic or Latino",
    "Native Hawaiian or Other Pacific Islander",
    "White",
    "Two or More Races",
    "Prefer not to say",
  ],
  hispanicLatino: ["Yes", "No", "Prefer not to say"],
  veteranStatus: [
    "I am not a protected veteran",
    "I identify as one or more of the classifications of a protected veteran",
    "Prefer not to say",
  ],
  disabilityStatus: [
    "Yes, I have a disability",
    "No, I do not have a disability",
    "Prefer not to say",
  ],
} as const;

/**
 * Build the PATCH body for the application-profile endpoint: only address /
 * screening / EEO keys that changed. Returns null when nothing changed.
 */
export function computeProfileDiff(
  original: ProfileExtras,
  current: ProfileExtras
): ProfileUpdatePayload | null {
  const diff: ProfileUpdatePayload = {};

  const flatKeys: (keyof Omit<ProfileExtras, "eeo">)[] = [
    "addressStreet",
    "addressCity",
    "addressState",
    "postalCode",
    "country",
    "currentTitle",
    "workAuthorization",
    "requiresSponsorship",
    "salaryExpectation",
  ];
  for (const key of flatKeys) {
    if (current[key] !== original[key]) {
      diff[key] = current[key];
    }
  }

  const eeoDiff: Partial<EeoData> = {};
  const eeoKeys: (keyof EeoData)[] = [
    "gender",
    "race",
    "hispanicLatino",
    "veteranStatus",
    "disabilityStatus",
  ];
  for (const key of eeoKeys) {
    if (current.eeo[key] !== original.eeo[key]) {
      eeoDiff[key] = current.eeo[key];
    }
  }
  if (Object.keys(eeoDiff).length > 0) {
    diff.eeo = eeoDiff;
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

/** "Wissam Elmasry" → ["Wissam", "Elmasry"]; single token → [token, ""]. */
export function splitName(fullName: string): [string, string] {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts.slice(1).join(" ")];
}
