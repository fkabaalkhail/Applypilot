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

  it("accepts a résumé upload on its own — minimal apply forms exist", () => {
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

  it("accepts two distinct job-flavored fields (LinkedIn + current title)", () => {
    expect(looksLikeJobApplication(fields("linkedin", "currentTitle", "email"))).toBe(true);
  });

  it("does not double-count a repeated job-flavored category (two school rows)", () => {
    expect(looksLikeJobApplication(fields("school", "school"))).toBe(false);
  });
});
