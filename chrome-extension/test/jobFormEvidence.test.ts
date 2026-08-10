import { describe, it, expect } from "vitest";
import { looksLikeJobApplication } from "../src/content/jobFormEvidence";
import type { FieldCategory } from "../src/shared/types";

const fields = (...categories: FieldCategory[]): { category: FieldCategory }[] =>
  categories.map((category) => ({ category }));

describe("looksLikeJobApplication", () => {
  it("rejects an empty scan", () => {
    expect(looksLikeJobApplication([])).toBe(false);
  });

  it("rejects a login form (email + password)", () => {
    expect(looksLikeJobApplication(fields("email", "accountPassword"))).toBe(false);
  });

  it("rejects a newsletter signup (lone email)", () => {
    expect(looksLikeJobApplication(fields("email"))).toBe(false);
  });

  it("rejects a checkout form (name/address/contact cluster)", () => {
    expect(
      looksLikeJobApplication(
        fields(
          "fullName",
          "email",
          "phone",
          "addressStreet",
          "addressCity",
          "addressState",
          "postalCode",
          "country"
        )
      )
    ).toBe(false);
  });

  it("rejects a contact form (name + email + unknown message box)", () => {
    expect(looksLikeJobApplication(fields("fullName", "email", "unknown"))).toBe(false);
  });

  it("accepts a résumé upload on its own, minimal apply forms exist", () => {
    expect(looksLikeJobApplication(fields("resumeUpload"))).toBe(true);
  });

  it("accepts a Greenhouse-style application", () => {
    expect(
      looksLikeJobApplication(
        fields("firstName", "lastName", "email", "phone", "resumeUpload", "coverLetter", "linkedin")
      )
    ).toBe(true);
  });

  it("accepts an EEO voluntary-disclosure page (Workday step)", () => {
    expect(
      looksLikeJobApplication(fields("eeoGender", "eeoRace", "eeoVeteran", "eeoDisability"))
    ).toBe(true);
  });

  it("accepts a sponsorship question among generic contact fields", () => {
    expect(looksLikeJobApplication(fields("firstName", "email", "sponsorship"))).toBe(true);
  });

  it("accepts a work-authorization question on its own", () => {
    expect(looksLikeJobApplication(fields("workAuthorization"))).toBe(true);
  });

  it("rejects a single job-flavored field (GitHub URL on a profile-settings page)", () => {
    expect(looksLikeJobApplication(fields("github", "email"))).toBe(false);
  });

  it("rejects a lone salary field (loan/income forms ask that too)", () => {
    expect(looksLikeJobApplication(fields("salary", "fullName", "email"))).toBe(false);
  });

  it("does not double-count a repeated job-flavored category (two school rows)", () => {
    expect(looksLikeJobApplication(fields("school", "school"))).toBe(false);
  });

  // --- Weak-tier tiering: the false positives this gate exists to stop --------

  it("rejects a B2B demo-request form (Company + Job title)", () => {
    expect(
      looksLikeJobApplication(fields("fullName", "email", "currentCompany", "currentTitle"))
    ).toBe(false);
  });

  it("rejects a developer profile-settings page (LinkedIn + GitHub)", () => {
    expect(looksLikeJobApplication(fields("linkedin", "github", "email"))).toBe(false);
  });

  it("rejects two weak fields (LinkedIn + current title)", () => {
    expect(looksLikeJobApplication(fields("linkedin", "currentTitle", "email"))).toBe(false);
  });

  it("accepts three distinct weak fields (LinkedIn + GitHub + portfolio)", () => {
    expect(looksLikeJobApplication(fields("linkedin", "github", "portfolio"))).toBe(true);
  });

  // --- Strong tier -----------------------------------------------------------

  it("rejects a lone strong field (a university contact form asks for School)", () => {
    expect(looksLikeJobApplication(fields("school", "fullName", "email"))).toBe(false);
  });

  it("accepts a strong field paired with any other job field (school + grad year)", () => {
    expect(looksLikeJobApplication(fields("school", "graduationYear"))).toBe(true);
  });

  it("accepts a strong field paired with a weak one (degree + LinkedIn)", () => {
    expect(looksLikeJobApplication(fields("degree", "linkedin"))).toBe(true);
  });

  /** Field of Study was split out of the `degree` rule. It is the same kind of
   *  evidence (a structured education field) so it has to carry the same
   *  weight, or a page whose only education control is labelled "Major" stops
   *  mounting the panel it used to mount. */
  it("accepts Field of Study paired with a weak one (major + LinkedIn)", () => {
    expect(looksLikeJobApplication(fields("fieldOfStudy", "linkedin"))).toBe(true);
  });

  it("still rejects a lone Field of Study among generic contact fields", () => {
    expect(looksLikeJobApplication(fields("fieldOfStudy", "fullName", "email"))).toBe(false);
  });

  // --- Page context upgrades two weak fields ---------------------------------

  it("accepts Company + Job title on a careers apply URL", () => {
    expect(
      looksLikeJobApplication(fields("currentCompany", "currentTitle"), {
        url: "https://acme.com/careers/apply/123",
      })
    ).toBe(true);
  });

  it("accepts two weak fields when the page title names a job application", () => {
    expect(
      looksLikeJobApplication(fields("linkedin", "currentTitle"), {
        title: "Job Application, Software Engineer",
      })
    ).toBe(true);
  });

  it("ignores a job-page hint that only matches inside a longer word", () => {
    expect(
      looksLikeJobApplication(fields("currentCompany", "currentTitle"), {
        url: "https://example.com/careership/enrollment",
        title: "Careership Enrollment",
      })
    ).toBe(false);
  });

  it("does not mount on a careers landing page with no job fields", () => {
    expect(
      looksLikeJobApplication(fields("email"), { url: "https://acme.com/careers" })
    ).toBe(false);
  });

  it("does not let a job-page hint rescue a single weak field", () => {
    expect(
      looksLikeJobApplication(fields("currentTitle"), { url: "https://acme.com/jobs/apply" })
    ).toBe(false);
  });
});
