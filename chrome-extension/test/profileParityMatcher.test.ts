/**
 * The point of the 2026-08-09 parity contract (§G): questions whose answer is
 * already a stated fact on the profile must be classified and resolved in
 * pass 1, no backend call, no model, no invention.
 *
 * The precedence cases are the load-bearing half. "Years of experience with
 * Python" answered from the headline total, or "Earliest start date" answered
 * from a previous employer's start date, are confidently WRONG answers written
 * into a real application. Each is asserted here in both directions.
 */
import { describe, it, expect } from "vitest";
import { collectSignals } from "../src/content/domUtils";
import { classifyField, resolveProfileValue } from "../src/content/fieldMatcher";
import type { FieldCategory, ResolveControl, UserApplicationProfile } from "../src/shared/types";

/** Classify a control that carries `label` as its accessible name. */
function catOf(label: string, tag: "input" | "select" = "input"): FieldCategory {
  const el = document.createElement(tag);
  el.setAttribute("aria-label", label);
  return classifyField(collectSignals(el)).category;
}

const TEXT: ResolveControl = { controlType: "text", groupIndex: null };
const SELECT = (options?: string[]): ResolveControl => ({
  controlType: "select",
  options,
  groupIndex: null,
});

function profile(over: Partial<UserApplicationProfile> = {}): UserApplicationProfile {
  return {
    firstName: "Ada", lastName: "Lovelace", email: "", phone: "", location: "",
    addressStreet: "", addressCity: "", addressState: "", postalCode: "", country: "",
    linkedin: "", github: "", portfolio: "", currentCompany: "", currentTitle: "",
    workAuthorization: "", requiresSponsorship: "", dateOfBirth: "",
    education: [], experience: [], skills: [], coverLetter: "",
    ...over,
  } as UserApplicationProfile;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifyField, screening questions the profile answers", () => {
  it("recognises willingness to relocate", () => {
    expect(catOf("Are you willing to relocate?")).toBe("willingToRelocate");
    expect(catOf("Willing to relocate")).toBe("willingToRelocate");
    expect(catOf("Are you open to relocation?")).toBe("willingToRelocate");
  });

  it("does NOT answer a relocation-BENEFITS question from a willingness answer", () => {
    expect(catOf("Do you require relocation assistance?")).not.toBe("willingToRelocate");
  });

  it("recognises work preference", () => {
    expect(catOf("Work preference")).toBe("workPreference");
    expect(catOf("Do you prefer remote or onsite?")).toBe("workPreference");
    expect(catOf("Preferred work arrangement")).toBe("workPreference");
  });

  it("leaves a geographic work-location question to `location`", () => {
    expect(catOf("Preferred work location")).not.toBe("workPreference");
  });

  it("recognises notice period", () => {
    expect(catOf("Notice period")).toBe("noticePeriod");
    expect(catOf("How much notice are you required to give?")).toBe("noticePeriod");
  });

  it("recognises availability, not an employment-history date", () => {
    expect(catOf("Earliest start date")).toBe("startDate");
    expect(catOf("When can you start?")).toBe("startDate");
    expect(catOf("Available start date")).toBe("startDate");
    expect(catOf("Desired start date")).toBe("startDate");
  });

  it("keeps a plain employment Start Date on experienceStartDate", () => {
    // A repeating work-experience row's own "Start Date" must never be read as
    // the applicant's availability. It fills from the employment record.
    expect(catOf("Start Date")).toBe("experienceStartDate");
    expect(catOf("End Date")).toBe("experienceEndDate");
    expect(catOf("Employment start date")).toBe("experienceStartDate");
  });

  it("recognises the headline years-of-experience number", () => {
    expect(catOf("Years of experience")).toBe("yearsOfExperience");
    expect(catOf("How many years of experience do you have?")).toBe("yearsOfExperience");
    expect(catOf("Total years of relevant work experience")).toBe("yearsOfExperience");
  });

  it("does NOT read a per-skill experience question as the headline number", () => {
    // The profile has no answer for "with Python", abstaining routes it to the
    // grounded AI pass instead of writing a confidently wrong number.
    expect(catOf("Years of experience with Python")).not.toBe("yearsOfExperience");
    expect(catOf("How many years of experience do you have in project management?")).not.toBe(
      "yearsOfExperience"
    );
    expect(catOf("Years of experience using React")).not.toBe("yearsOfExperience");
  });

  it("recognises security clearance", () => {
    expect(catOf("Security clearance")).toBe("securityClearance");
    expect(catOf("Do you hold an active clearance?")).toBe("securityClearance");
  });

  it("recognises a driver's licence in both spellings and both apostrophe forms", () => {
    expect(catOf("Do you have a valid driver's licence?")).toBe("driversLicense");
    expect(catOf("Do you have a valid driver's license?")).toBe("driversLicense");
    expect(catOf("Drivers License")).toBe("driversLicense");
    expect(catOf("Driving licence")).toBe("driversLicense");
  });

  it("does not treat a licence NUMBER field as the screening question", () => {
    expect(catOf("Driver's licence number")).not.toBe("driversLicense");
  });

  it("recognises spoken languages", () => {
    expect(catOf("Languages")).toBe("languages");
    expect(catOf("Languages spoken")).toBe("languages");
    expect(catOf("Language proficiency")).toBe("languages");
  });

  it("does not read programming languages as spoken languages", () => {
    expect(catOf("Programming languages")).not.toBe("languages");
  });

  it("splits pronouns out of the eeoOther catch-all", () => {
    expect(catOf("Pronouns")).toBe("eeoPronouns");
    expect(catOf("What are your preferred pronouns?")).toBe("eeoPronouns");
    // The rest of the bucket is unchanged.
    expect(catOf("Do you identify as transgender?")).toBe("eeoOther");
  });

  it("still separates gender / gender identity / sexual orientation", () => {
    expect(catOf("Gender")).toBe("eeoGender");
    expect(catOf("Gender identity")).toBe("eeoGenderIdentity");
    expect(catOf("Sexual orientation")).toBe("eeoSexualOrientation");
  });

  it("flags every demographic category sensitive, so the AI never guesses one", () => {
    for (const label of ["Pronouns", "Gender identity", "Sexual orientation"]) {
      const el = document.createElement("select");
      el.setAttribute("aria-label", label);
      expect(classifyField(collectSignals(el)).sensitive, label).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Resolution: pass 1, no LLM
// ---------------------------------------------------------------------------

describe("resolveProfileValue, screening answers fill straight from the profile", () => {
  const p = profile({
    willingToRelocate: "Yes",
    workPreference: "Hybrid",
    noticePeriod: "2 weeks",
    earliestStartDate: "2026-09-01",
    yearsOfExperience: "5",
    securityClearance: "None",
    driversLicense: "No",
    languages: "English (Native), French (Professional)",
    eeo: { pronouns: "They/Them", genderIdentity: "Non-binary", sexualOrientation: "Bisexual" },
  });

  it("resolves each one", () => {
    expect(resolveProfileValue("willingToRelocate", p, TEXT, false)).toBe("Yes");
    expect(resolveProfileValue("workPreference", p, TEXT, false)).toBe("Hybrid");
    expect(resolveProfileValue("noticePeriod", p, TEXT, false)).toBe("2 weeks");
    expect(resolveProfileValue("startDate", p, TEXT, false)).toBe("2026-09-01");
    expect(resolveProfileValue("yearsOfExperience", p, TEXT, false)).toBe("5");
    expect(resolveProfileValue("securityClearance", p, TEXT, false)).toBe("None");
    expect(resolveProfileValue("driversLicense", p, TEXT, false)).toBe("No");
    expect(resolveProfileValue("languages", p, TEXT, false)).toBe(
      "English (Native), French (Professional)"
    );
    expect(resolveProfileValue("eeoPronouns", p, TEXT, false)).toBe("They/Them");
  });

  it("abstains on every one when the profile has no answer", () => {
    const blank = profile();
    for (const c of [
      "willingToRelocate", "workPreference", "noticePeriod", "startDate",
      "yearsOfExperience", "securityClearance", "driversLicense", "languages",
      "eeoPronouns",
    ] as FieldCategory[]) {
      expect(resolveProfileValue(c, blank, TEXT, false), c).toBeNull();
    }
  });

  it("answers a Yes/No control with Yes/No even when the profile holds prose", () => {
    const prose = profile({
      willingToRelocate: "No, I am not able to relocate",
      driversLicense: "Yes, full clean licence",
    });
    const yesNo = SELECT(["Yes", "No"]);
    expect(resolveProfileValue("willingToRelocate", prose, yesNo, false)).toBe("No");
    expect(resolveProfileValue("driversLicense", prose, yesNo, false)).toBe("Yes");
    // A free-text control keeps the user's own words.
    expect(resolveProfileValue("willingToRelocate", prose, TEXT, false)).toBe(
      "No, I am not able to relocate"
    );
  });

  it("never reads pronouns off the gender answer", () => {
    // Gender identity may fall back to gender; pronouns must not be derived.
    const g = profile({ eeo: { gender: "Female" } });
    expect(resolveProfileValue("eeoGenderIdentity", g, TEXT, false)).toBe("Female");
    expect(resolveProfileValue("eeoPronouns", g, TEXT, false)).toBeNull();
  });

  it("keeps availability and employment dates apart at resolution too", () => {
    const withJob = profile({
      earliestStartDate: "2026-09-01",
      experience: [
        { company: "Acme", title: "Eng", startDate: "2020-01", endDate: "2024-06", description: "" },
      ],
    });
    expect(resolveProfileValue("startDate", withJob, TEXT, false)).toBe("2026-09-01");
    expect(
      resolveProfileValue("experienceStartDate", withJob, { ...TEXT, groupIndex: 0 }, false)
    ).toBe("2020-01");
    // A standalone employment "Start Date" (no repeating row) still resolves to
    // nothing rather than borrowing the availability date.
    expect(resolveProfileValue("experienceStartDate", withJob, TEXT, false)).toBeNull();
  });
});
