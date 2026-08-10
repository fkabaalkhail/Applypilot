import { describe, it, expect } from "vitest";
import {
  profileFieldForCategory,
  isProfileCategory,
  buildProfilePatch,
} from "../src/shared/profileCategories";

describe("profileFieldForCategory", () => {
  it("maps personal-info categories to their editable profile field", () => {
    expect(profileFieldForCategory("firstName")).toBe("firstName");
    expect(profileFieldForCategory("phone")).toBe("phone");
    expect(profileFieldForCategory("addressCity")).toBe("addressCity");
    expect(profileFieldForCategory("linkedin")).toBe("linkedin");
    // github had no write path at all before the parity contract.
    expect(profileFieldForCategory("github")).toBe("github");
    expect(profileFieldForCategory("sponsorship")).toBe("requiresSponsorship");
    expect(profileFieldForCategory("salary")).toBe("salaryExpectation");
    expect(profileFieldForCategory("workAuthorization")).toBe("workAuthorization");
  });

  it("maps the eight screening categories added by the parity contract", () => {
    expect(profileFieldForCategory("willingToRelocate")).toBe("willingToRelocate");
    expect(profileFieldForCategory("workPreference")).toBe("workPreference");
    expect(profileFieldForCategory("noticePeriod")).toBe("noticePeriod");
    // The category is named after the QUESTION ("when can you start?"), the
    // profile key after the field, same quirk as sponsorship/salary.
    expect(profileFieldForCategory("startDate")).toBe("earliestStartDate");
    expect(profileFieldForCategory("yearsOfExperience")).toBe("yearsOfExperience");
    expect(profileFieldForCategory("securityClearance")).toBe("securityClearance");
    expect(profileFieldForCategory("driversLicense")).toBe("driversLicense");
    expect(profileFieldForCategory("languages")).toBe("languages");
  });

  it("returns null for categories without a TOP-LEVEL profile field", () => {
    // EEO persists into the nested `eeo` object (see buildProfilePatch), not a
    // top-level key; education/experience prose + free-form questions persist
    // nowhere at all.
    expect(profileFieldForCategory("eeoGender")).toBeNull();
    expect(profileFieldForCategory("education")).toBeNull();
    expect(profileFieldForCategory("coverLetter")).toBeNull();
    expect(profileFieldForCategory("unknown")).toBeNull();
  });
});

describe("isProfileCategory", () => {
  it("is true for mapped categories, false otherwise", () => {
    expect(isProfileCategory("email")).toBe(true);
    expect(isProfileCategory("unknown")).toBe(false);
  });

  it("is true for the eight EEO categories (nested eeo persistence)", () => {
    expect(isProfileCategory("eeoGender")).toBe(true);
    expect(isProfileCategory("eeoRace")).toBe(true);
    expect(isProfileCategory("eeoHispanic")).toBe(true);
    expect(isProfileCategory("eeoVeteran")).toBe(true);
    expect(isProfileCategory("eeoDisability")).toBe(true);
    // Gender identity, pronouns and sexual orientation gained real profile
    // slots in the 2026-08-09 parity contract.
    expect(isProfileCategory("eeoGenderIdentity")).toBe(true);
    expect(isProfileCategory("eeoPronouns")).toBe(true);
    expect(isProfileCategory("eeoSexualOrientation")).toBe(true);
    // eeoOther is what's left (transgender, LGBTQ, generic "demographic"
    // prompts) and still has no profile slot at all.
    expect(isProfileCategory("eeoOther")).toBe(false);
  });
});

describe("buildProfilePatch", () => {
  it("collects only profile categories with non-blank values", () => {
    const patch = buildProfilePatch([
      { category: "phone", value: "555-1212" },
      { category: "country", value: "Canada" },
      { category: "education", value: "MIT" }, // not a profile field → skipped
      { category: "email", value: "   " }, // blank → skipped
    ]);
    expect(patch).toEqual({ phone: "555-1212", country: "Canada" });
  });

  it("nests EEO answers under `eeo` in the API shape", () => {
    const patch = buildProfilePatch([
      { category: "eeoGender", value: "Male" },
      { category: "eeoDisability", value: "No, I do not have a disability" },
      { category: "country", value: "Canada" },
    ]);
    expect(patch).toEqual({
      country: "Canada",
      eeo: { gender: "Male", disabilityStatus: "No, I do not have a disability" },
    });
  });

  it("returns an empty patch when nothing qualifies", () => {
    expect(buildProfilePatch([{ category: "unknown", value: "x" }])).toEqual({});
    expect(buildProfilePatch([])).toEqual({});
  });

  it("persists a screening answer under its profile key, not its category name", () => {
    expect(
      buildProfilePatch([
        { category: "startDate", value: "2026-09-01" },
        { category: "languages", value: "English, French" },
        { category: "eeoPronouns", value: "They/Them" },
      ])
    ).toEqual({
      earliestStartDate: "2026-09-01",
      languages: "English, French",
      eeo: { pronouns: "They/Them" },
    });
  });
});
