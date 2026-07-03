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
});
