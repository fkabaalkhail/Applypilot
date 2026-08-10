/**
 * GET /api/extension/sync is the only door the profile comes through. A key the
 * normalizer forgets is dropped no matter what the backend sends, and the field
 * then looks broken everywhere at once — panel, scanner and AI context — with a
 * perfectly correct response sitting in the network tab.
 *
 * Also covers the sample profile, which is what "Use sample data" exercises and
 * what the published JSON schema is validated against.
 */
import { describe, it, expect } from "vitest";
import { normalizeProfile } from "../src/api/sync";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { EEO_CHOICES, SCREENING_CHOICES } from "../src/content/overlay";

const SCREENING = {
  willingToRelocate: "Yes",
  workPreference: "Remote",
  noticePeriod: "2 weeks",
  earliestStartDate: "2026-09-01",
  yearsOfExperience: "5",
  securityClearance: "None",
  driversLicense: "No",
  languages: "English (Native), French (Professional)",
} as const;

describe("normalizeProfile", () => {
  it("carries every screening answer through", () => {
    const p = normalizeProfile({ ...SCREENING }) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(SCREENING)) expect(p[k], k).toBe(v);
  });

  it("carries the nested demographics through", () => {
    const eeo = { genderIdentity: "Non-binary", pronouns: "They/Them", sexualOrientation: "Bisexual" };
    expect(normalizeProfile({ eeo }).eeo).toEqual(eeo);
  });

  it('reads a blank screening answer as "not answered", not as an answer', () => {
    // Same convention salaryExpectation has always used: "" collapses to
    // undefined so a resolver abstains instead of filling an empty string.
    const p = normalizeProfile({ ...SCREENING, noticePeriod: "", languages: "" });
    expect(p.noticePeriod).toBeUndefined();
    expect(p.languages).toBeUndefined();
    expect(p.workPreference).toBe("Remote");
  });

  it("survives a payload that predates the new fields", () => {
    const p = normalizeProfile({ firstName: "Ada" });
    expect(p.firstName).toBe("Ada");
    for (const k of Object.keys(SCREENING)) {
      expect((p as unknown as Record<string, unknown>)[k], k).toBeUndefined();
    }
  });

  it("ignores non-string junk rather than passing it to the filler", () => {
    const p = normalizeProfile({ yearsOfExperience: 5 as unknown as string });
    expect(p.yearsOfExperience).toBeUndefined();
  });
});

describe("the sample profile exercises the new fields", () => {
  it("answers every screening question", () => {
    for (const k of Object.keys(SCREENING)) {
      expect((MOCK_PROFILE as unknown as Record<string, unknown>)[k], k).toBeTruthy();
    }
  });

  it("only uses values the modal actually offers, so no select renders blank", () => {
    // MOCK_PROFILE.veteranStatus used to be "I am not a veteran" — not in the
    // list — so mock mode rendered a Veteran Status select with nothing chosen.
    for (const [field, options] of Object.entries(EEO_CHOICES)) {
      const value = (MOCK_PROFILE.eeo as unknown as Record<string, string>)[field];
      if (value) expect(options, `eeo.${field}`).toContain(value);
    }
    for (const [field, options] of Object.entries(SCREENING_CHOICES)) {
      const value = (MOCK_PROFILE as unknown as Record<string, string>)[field];
      if (value) expect(options, field).toContain(value);
    }
  });

  it("survives normalization unchanged", () => {
    expect(normalizeProfile(MOCK_PROFILE)).toEqual(MOCK_PROFILE);
  });
});
