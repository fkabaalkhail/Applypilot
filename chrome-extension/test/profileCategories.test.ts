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

  it("returns null for categories the profile endpoint does not store", () => {
    // EEO comes from the profile already (never prompted); education/experience
    // prose + free-form questions belong in the answer bank, not the profile.
    expect(profileFieldForCategory("eeoGender")).toBeNull();
    expect(profileFieldForCategory("education")).toBeNull();
    expect(profileFieldForCategory("coverLetter")).toBeNull();
    expect(profileFieldForCategory("unknown")).toBeNull();
  });
});

describe("isProfileCategory", () => {
  it("is true for mapped categories, false otherwise", () => {
    expect(isProfileCategory("email")).toBe(true);
    expect(isProfileCategory("eeoRace")).toBe(false);
    expect(isProfileCategory("unknown")).toBe(false);
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

  it("returns an empty patch when nothing qualifies", () => {
    expect(buildProfilePatch([{ category: "unknown", value: "x" }])).toEqual({});
    expect(buildProfilePatch([])).toEqual({});
  });
});
