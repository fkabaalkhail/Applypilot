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
 * truth. addressCity shares the same DB column as the contact "city".
 *
 * Field names, labels and option strings are fixed by
 * docs/superpowers/specs/2026-08-09-profile-parity-contract.md — the web, the
 * API and the extension must agree byte-for-byte.
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
  genderIdentity: string;
  pronouns: string;
  sexualOrientation: string;
}

// Structured mailing address + screening answers + EEO, persisted via the
// application-profile endpoint. addressCity shares the same DB column as the
// contact "city".
export interface ProfileExtras {
  addressStreet: string;
  addressCity: string;
  addressState: string;
  postalCode: string;
  country: string;
  /**
   * Answers the extension fills into screening questions. The free-text ones are
   * FREE TEXT, not enums: the extension learns these from real application forms
   * and writes back the form's literal option text (see
   * chrome-extension/src/shared/profileCategories.ts), so a stored
   * workAuthorization may read "Yes, I am legally authorized to work in the
   * United States for any employer". Constraining those to a select would
   * destroy the more specific answer that actually matched a form.
   *
   * The four that DO have a fixed vocabulary (willingToRelocate, workPreference,
   * securityClearance, driversLicense) are listed in SCREENING_OPTIONS below;
   * their answers are short and closed, so a select is safe and stops a typo
   * from being submitted to an employer.
   */
  currentTitle: string;
  /**
   * Drives every age-gate / "are you over 18" answer the extension gives. It was
   * extension-only before the parity contract, so a wrong value silently poisoned
   * those answers with no way to correct it from the web.
   */
  dateOfBirth: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  willingToRelocate: string;
  workPreference: string;
  noticePeriod: string;
  earliestStartDate: string;
  yearsOfExperience: string;
  securityClearance: string;
  driversLicense: string;
  languages: string;
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
  /**
   * Lives on the resume row as `github_url` and is edited in the Personal card,
   * exactly like `linkedin` / `portfolio` — so it is NOT part of ProfileExtras
   * and is diffed in Profile.tsx's buildProfilePayload, not computeProfileDiff.
   * Before the parity contract the profile API would not accept it at all, so
   * GitHub never round-tripped to the extension.
   */
  github?: string;
  portfolio?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  postalCode?: string;
  country?: string;
  currentTitle?: string;
  dateOfBirth?: string;
  workAuthorization?: string;
  requiresSponsorship?: string;
  salaryExpectation?: string;
  willingToRelocate?: string;
  workPreference?: string;
  noticePeriod?: string;
  earliestStartDate?: string;
  yearsOfExperience?: string;
  securityClearance?: string;
  driversLicense?: string;
  languages?: string;
  eeo?: Partial<EeoData>;
}

export const EMPTY_EEO: EeoData = {
  gender: "",
  race: "",
  hispanicLatino: "",
  veteranStatus: "",
  disabilityStatus: "",
  genderIdentity: "",
  pronouns: "",
  sexualOrientation: "",
};

export const EMPTY_PROFILE_EXTRAS: ProfileExtras = {
  addressStreet: "",
  addressCity: "",
  addressState: "",
  postalCode: "",
  country: "",
  currentTitle: "",
  dateOfBirth: "",
  workAuthorization: "",
  requiresSponsorship: "",
  salaryExpectation: "",
  willingToRelocate: "",
  workPreference: "",
  noticePeriod: "",
  earliestStartDate: "",
  yearsOfExperience: "",
  securityClearance: "",
  driversLicense: "",
  languages: "",
  eeo: { ...EMPTY_EEO },
};

/**
 * Option lists for the EEO selects.
 *
 * TWIN COPY: `EEO_CHOICES` in `chrome-extension/src/content/overlay.ts` holds the
 * same vocabularies. The two MUST stay byte-identical — the extension writes the
 * literal string into employer forms and the backend matches saved answers
 * against it, so a one-word drift here silently breaks autofill on the other
 * surface. Both files are pinned by a test (this one:
 * frontend/src/__tests__/profile-parity-fields.test.tsx) that asserts the exact
 * arrays, so editing one without the other fails the other suite.
 * Source of truth: docs/superpowers/specs/2026-08-09-profile-parity-contract.md
 * section D.
 */
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
  genderIdentity: ["Cisgender", "Transgender", "Non-binary", "Prefer not to say"],
  pronouns: ["He/Him", "She/Her", "They/Them", "Prefer not to say"],
  sexualOrientation: [
    "Heterosexual",
    "Gay or Lesbian",
    "Bisexual",
    "Prefer not to say",
  ],
} as const;

/**
 * Option lists for the four screening answers with a closed vocabulary.
 *
 * TWIN COPY: the same vocabularies live beside `EEO_CHOICES` in
 * `chrome-extension/src/content/overlay.ts`. They MUST stay byte-identical for
 * the same reason as EEO_OPTIONS above, and are pinned by a test on both sides.
 * Source of truth: docs/superpowers/specs/2026-08-09-profile-parity-contract.md
 * section D.
 */
export const SCREENING_OPTIONS = {
  willingToRelocate: ["Yes", "No"],
  workPreference: ["Remote", "Hybrid", "On-site", "No preference"],
  securityClearance: ["None", "Active clearance", "Eligible / previously held"],
  driversLicense: ["Yes", "No"],
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
    "dateOfBirth",
    "workAuthorization",
    "requiresSponsorship",
    "salaryExpectation",
    "willingToRelocate",
    "workPreference",
    "noticePeriod",
    "earliestStartDate",
    "yearsOfExperience",
    "securityClearance",
    "driversLicense",
    "languages",
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
    "genderIdentity",
    "pronouns",
    "sexualOrientation",
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
