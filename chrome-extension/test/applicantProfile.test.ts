import { describe, it, expect } from "vitest";
import { toApplicantProfile } from "../src/content/applicantProfile";
import type { UserApplicationProfile } from "../src/shared/types";

const base: UserApplicationProfile = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@x.io", phone: "555",
  location: "Toronto", addressStreet: "1 St", addressCity: "Toronto",
  addressState: "ON", postalCode: "M1", country: "Canada",
  linkedin: "li", github: "gh", portfolio: "pf",
  currentCompany: "Acme", currentTitle: "Eng",
  workAuthorization: "Citizen", requiresSponsorship: "No",
  dateOfBirth: "1999-03-14",
  education: [{ school: "UofT", degree: "BSc", graduationYear: "2020" }],
  experience: [{ company: "Acme", title: "Eng", startDate: "2020", endDate: "2024", description: "x" }],
  skills: ["Python"], coverLetter: "", salaryExpectation: "120000",
  eeo: { race: "Arab", gender: "Woman" },
};

describe("toApplicantProfile", () => {
  it("copies non-sensitive fields and flattens experience/education", () => {
    const a = toApplicantProfile(base);
    expect(a.workAuthorization).toBe("Citizen");
    expect(a.salaryExpectation).toBe("120000");
    expect(a.experience[0]).toContain("Eng");
    expect(a.experience[0]).toContain("Acme");
    expect(a.education[0]).toContain("BSc");
  });

  it("never includes EEO/demographic data", () => {
    const a = toApplicantProfile(base) as Record<string, unknown>;
    expect(JSON.stringify(a).toLowerCase()).not.toContain("arab");
    expect("eeo" in a).toBe(false);
  });

  it("carries the structured dates the derived resolvers compute from", () => {
    // The flattened lines above are prose for the model. Arithmetic, an age
    // gate, a career total, a graduation year, reads these instead, because a
    // parser that is wrong about a date is worse than no answer at all.
    const a = toApplicantProfile(base);
    expect(a.dateOfBirth).toBe("1999-03-14");
    expect(a.workHistory).toEqual([{ startDate: "2020", endDate: "2024" }]);
    expect(a.educationHistory).toEqual([
      { degree: "BSc", school: "UofT", graduationYear: "2020" },
    ]);
  });

  it("sends nothing at all when the profile holds no date of birth", () => {
    const a = toApplicantProfile({ ...base, dateOfBirth: "" });
    expect(a.dateOfBirth).toBe("");
  });
});
