import { describe, it, expect } from "vitest";
import { resolveProfileValue } from "../src/content/fieldMatcher";
import { isDefaultSelected } from "../src/shared/selection";
import type { DetectedField, UserApplicationProfile } from "../src/shared/types";

const profileWithEeo = {
  eeo: {
    gender: "Male",
    race: "Hispanic or Latino",
    hispanicLatino: "Yes",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No, I do not have a disability",
  },
} as unknown as UserApplicationProfile;

const ctrl = { controlType: "select" as const };

describe("resolveProfileValue fills EEO from the profile (presence = consent)", () => {
  it("returns the stored answer even when the legacy fillEEO flag is false", () => {
    expect(resolveProfileValue("eeoGender", profileWithEeo, ctrl, false)).toBe("Male");
    expect(resolveProfileValue("eeoRace", profileWithEeo, ctrl, false)).toBe("Hispanic or Latino");
    expect(resolveProfileValue("eeoHispanic", profileWithEeo, ctrl, false)).toBe("Yes");
    expect(resolveProfileValue("eeoDisability", profileWithEeo, ctrl, false)).toBe(
      "No, I do not have a disability"
    );
    // ...and still fills when the flag is true.
    expect(resolveProfileValue("eeoVeteran", profileWithEeo, ctrl, true)).toBe(
      "I am not a protected veteran"
    );
  });

  it("returns null when the profile has no EEO answer (never fabricated)", () => {
    const empty = {} as UserApplicationProfile;
    expect(resolveProfileValue("eeoGender", empty, ctrl, false)).toBeNull();
    expect(resolveProfileValue("eeoRace", empty, ctrl, true)).toBeNull();
  });
});

describe("isDefaultSelected auto-selects a sensitive field that has the user's answer", () => {
  const base: DetectedField = {
    id: "1",
    category: "eeoGender",
    confidence: 0.95,
    label: "Gender",
    controlType: "select",
    required: false,
    proposedValue: "Male",
    fillable: true,
    sensitive: true,
  };

  it("selects a sensitive field with a stored value", () => {
    expect(isDefaultSelected(base)).toBe(true);
  });
  it("does not select a sensitive field we have no answer for", () => {
    expect(isDefaultSelected({ ...base, proposedValue: null })).toBe(false);
  });
  it("does not overwrite a value the user already entered", () => {
    expect(isDefaultSelected({ ...base, currentValue: "Female" })).toBe(false);
  });
});
