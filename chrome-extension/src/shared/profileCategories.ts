// chrome-extension/src/shared/profileCategories.ts
/**
 * Maps a detected field CATEGORY to the editable application-profile field it
 * should persist to.
 *
 * When the user answers a question in the gap modal, an answer that corresponds
 * to a real profile field is saved back to their profile
 * (PUT /api/user/application-profile), so it shows up in the extension's
 * "Autofill Information" and the web app's Profile page, and autofills next
 * time. This map is the ONLY thing that persists an answer: anything not in it
 * (free-form screening questions, education/experience prose) is filled into
 * the page in front of the user and stored nowhere.
 *
 * Only categories the profile endpoint actually stores are included (mirrors
 * backend/routers/profile.py `field_map` + the salary/work-auth/sponsorship
 * prefilled answers).
 */
import type { FieldCategory, UserApplicationProfile } from "./types";

export type PersistableProfileKey =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "location"
  | "addressStreet"
  | "addressCity"
  | "addressState"
  | "postalCode"
  | "country"
  | "linkedin"
  | "github"
  | "portfolio"
  | "currentTitle"
  | "workAuthorization"
  | "requiresSponsorship"
  | "salaryExpectation"
  | "willingToRelocate"
  | "workPreference"
  | "noticePeriod"
  | "earliestStartDate"
  | "yearsOfExperience"
  | "securityClearance"
  | "driversLicense"
  | "languages";

const CATEGORY_TO_PROFILE_KEY: Partial<Record<FieldCategory, PersistableProfileKey>> = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  location: "location",
  addressStreet: "addressStreet",
  addressCity: "addressCity",
  addressState: "addressState",
  postalCode: "postalCode",
  country: "country",
  linkedin: "linkedin",
  // Was deliberately absent while `github` was read-only server-side; the
  // profile endpoint accepts it now (parity contract §B), so a GitHub URL
  // typed into the gap modal finally sticks instead of being filled once.
  github: "github",
  portfolio: "portfolio",
  currentTitle: "currentTitle",
  workAuthorization: "workAuthorization",
  // Category name ≠ profile key for the two oldest screening answers; the new
  // ones below follow the same rule, the category is named after the QUESTION
  // ("startDate" = "when can you start?"), the key after the profile field.
  sponsorship: "requiresSponsorship",
  salary: "salaryExpectation",
  willingToRelocate: "willingToRelocate",
  workPreference: "workPreference",
  noticePeriod: "noticePeriod",
  startDate: "earliestStartDate",
  yearsOfExperience: "yearsOfExperience",
  securityClearance: "securityClearance",
  driversLicense: "driversLicense",
  languages: "languages",
};

/** EEO categories persist into the profile's nested `eeo` object (PUT
 *  /api/user/application-profile accepts the same nested shape), so answering
 *  a demographic dropdown once in the missing-info modal refills it on every
 *  future application via resolveProfileValue. `eeoOther` is the leftover
 *  bucket (transgender / LGBTQ / generic "demographic" prompts) and still has
 *  no profile slot, those answers stay device-local. */
const CATEGORY_TO_EEO_KEY: Partial<Record<FieldCategory, keyof NonNullable<UserApplicationProfile["eeo"]>>> = {
  eeoGender: "gender",
  eeoGenderIdentity: "genderIdentity",
  eeoPronouns: "pronouns",
  eeoRace: "race",
  eeoHispanic: "hispanicLatino",
  eeoVeteran: "veteranStatus",
  eeoDisability: "disabilityStatus",
  eeoSexualOrientation: "sexualOrientation",
};

/** The profile field a category persists to, or null when it isn't a profile field. */
export function profileFieldForCategory(category: FieldCategory): PersistableProfileKey | null {
  return CATEGORY_TO_PROFILE_KEY[category] ?? null;
}

/** True when an answer for this category belongs in the profile (vs nowhere). */
export function isProfileCategory(category: FieldCategory): boolean {
  return profileFieldForCategory(category) !== null || CATEGORY_TO_EEO_KEY[category] !== undefined;
}

/**
 * Build a minimal profile patch from `{category, value}` pairs. Non-profile
 * categories and blank values are skipped; returns `{}` when nothing qualifies.
 * EEO categories land in a nested `eeo` object mirroring the API shape.
 */
export function buildProfilePatch(
  entries: Array<{ category: FieldCategory; value: string }>
): Partial<UserApplicationProfile> {
  const patch: Partial<UserApplicationProfile> = {};
  for (const { category, value } of entries) {
    if (!value.trim()) continue;
    const key = profileFieldForCategory(category);
    if (key) {
      (patch as Record<string, string>)[key] = value;
      continue;
    }
    const eeoKey = CATEGORY_TO_EEO_KEY[category];
    if (eeoKey) {
      patch.eeo = { ...(patch.eeo ?? {}), [eeoKey]: value } as UserApplicationProfile["eeo"];
    }
  }
  return patch;
}
