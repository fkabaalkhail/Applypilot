// chrome-extension/src/shared/profileCategories.ts
/**
 * Maps a detected field CATEGORY to the editable application-profile field it
 * should persist to.
 *
 * When the user answers a question in the missing-info modal, an answer that
 * corresponds to a real profile field is saved back to their profile
 * (PUT /api/user/application-profile) — not just the answer bank — so it shows
 * up in the extension's "Autofill Information" and the web app's Profile page,
 * and autofills automatically next time. Anything not in this map (free-form
 * screening questions, education/experience prose) stays in the answer bank.
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
  | "portfolio"
  | "currentTitle"
  | "workAuthorization"
  | "requiresSponsorship"
  | "salaryExpectation";

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
  portfolio: "portfolio",
  currentTitle: "currentTitle",
  workAuthorization: "workAuthorization",
  sponsorship: "requiresSponsorship",
  salary: "salaryExpectation",
};

/** The profile field a category persists to, or null when it isn't a profile field. */
export function profileFieldForCategory(category: FieldCategory): PersistableProfileKey | null {
  return CATEGORY_TO_PROFILE_KEY[category] ?? null;
}

/** True when an answer for this category belongs in the profile (vs the answer bank). */
export function isProfileCategory(category: FieldCategory): boolean {
  return profileFieldForCategory(category) !== null;
}

/**
 * Build a minimal profile patch from `{category, value}` pairs. Non-profile
 * categories and blank values are skipped; returns `{}` when nothing qualifies.
 */
export function buildProfilePatch(
  entries: Array<{ category: FieldCategory; value: string }>
): Partial<UserApplicationProfile> {
  const patch: Partial<UserApplicationProfile> = {};
  for (const { category, value } of entries) {
    const key = profileFieldForCategory(category);
    if (key && value.trim()) (patch as Record<string, string>)[key] = value;
  }
  return patch;
}
