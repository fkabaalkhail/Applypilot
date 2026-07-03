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
    expect(profileFieldForCategory("sponsorship")).toBe("requiresSponsorship");
    expect(profileFieldForCategory("salary")).toBe("salaryExpectation");
    expect(profileFieldForCategory("workAuthorization")).toBe("workAuthorization");
  });

  it("returns null for categories without a TOP-LEVEL profile field", () => {
    // EEO persists into the nested `eeo` object (see buildProfilePatch), not a
    // top-level key; education/experience prose + free-form questions belong in
    // the answer bank, not the profile.
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

  it("is true for the five standard EEO categories (nested eeo persistence)", () => {
    expect(isProfileCategory("eeoGender")).toBe(true);
    expect(isProfileCategory("eeoRace")).toBe(true);
    expect(isProfileCategory("eeoHispanic")).toBe(true);
    expect(isProfileCategory("eeoVeteran")).toBe(true);
    expect(isProfileCategory("eeoDisability")).toBe(true);
    // eeoOther (orientation, transgender, pronouns…) has no profile slot — it
    // stays device-local via the sensitive answer store.
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
});
