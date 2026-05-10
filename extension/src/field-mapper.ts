/**
 * FieldMapper — maps detected form fields to user profile data using label keyword matching.
 */

import type { FormField } from "./form-detector"

/** Keywords mapped to profile field keys */
const FIELD_KEYWORDS: Record<string, string[]> = {
  first_name: ["first name", "first_name", "firstname", "given name", "prénom"],
  last_name: ["last name", "last_name", "lastname", "surname", "family name", "nom"],
  full_name: ["full name", "full_name", "fullname", "your name", "name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "telephone", "tel", "mobile", "cell", "phone number"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
  location: ["location", "city", "address", "where are you located"],
  company: ["current company", "company", "employer", "current employer"],
  title: ["current title", "job title", "title", "position", "current position"],
  website: ["website", "portfolio", "personal site", "url", "personal website"],
  github: ["github", "github url", "github profile"],
  salary: ["salary", "expected salary", "desired salary", "compensation"],
  start_date: ["start date", "available date", "availability", "when can you start"],
  work_authorization: [
    "work authorization",
    "authorized to work",
    "legally authorized",
    "visa",
    "sponsorship",
    "require sponsorship",
    "work permit"
  ],
  years_experience: [
    "years of experience",
    "years experience",
    "experience years",
    "how many years"
  ],
  education: ["education", "degree", "university", "school", "college"],
  cover_letter: ["cover letter", "cover_letter", "coverletter"],
  resume: ["resume", "cv", "curriculum vitae"]
}

export class FieldMapper {
  /**
   * Map a detected form field to a profile value using label keyword matching.
   * Returns the profile value for the field, or null if no match found.
   */
  mapFieldToProfile(
    field: FormField,
    profile: Record<string, string>
  ): string | null {
    const profileKey = this.identifyProfileKey(field)
    if (!profileKey) return null
    return profile[profileKey] ?? null
  }

  /**
   * Identify which profile key a field corresponds to.
   * Returns the profile key or null if unknown.
   */
  identifyProfileKey(field: FormField): string | null {
    const searchText = this.normalizeText(field.label || field.name)

    if (!searchText) return null

    // Check field type for email inputs
    if (field.type === "email") return "email"

    // Search through keyword mappings
    for (const [profileKey, keywords] of Object.entries(FIELD_KEYWORDS)) {
      for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
          return profileKey
        }
      }
    }

    // Fallback: check the name attribute directly
    const nameAttr = this.normalizeText(field.name)
    for (const [profileKey, keywords] of Object.entries(FIELD_KEYWORDS)) {
      for (const keyword of keywords) {
        const normalizedKeyword = keyword.replace(/\s+/g, "")
        if (nameAttr.includes(normalizedKeyword) || nameAttr.includes(keyword)) {
          return profileKey
        }
      }
    }

    return null
  }

  /**
   * Normalize text for comparison: lowercase, trim, collapse whitespace.
   */
  private normalizeText(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, " ")
  }
}
