import { describe, it, expect } from "vitest";
import { closestDemographicOption } from "../src/content/demographicMatch";

const RACE = ["White", "Black or African American", "Asian", "Hispanic or Latino", "Two or More Races", "Prefer Not to Say"];

describe("closestDemographicOption", () => {
  it("maps Arab to a MENA option when offered", () => {
    const opts = [...RACE, "Middle Eastern or North African"];
    expect(closestDemographicOption("eeoRace", "Arab", opts)).toBe("Middle Eastern or North African");
  });
  it("maps Arab to White when no MENA option exists", () => {
    expect(closestDemographicOption("eeoRace", "Arab", RACE)).toBe("White");
  });
  it("falls back to a decline option when nothing matches", () => {
    expect(closestDemographicOption("eeoRace", "Klingon", RACE)).toBe("Prefer Not to Say");
  });
  it("returns null when there is no match and no decline option", () => {
    expect(closestDemographicOption("eeoRace", "Klingon", ["White", "Asian"])).toBeNull();
  });
  it("maps Woman to Female", () => {
    expect(closestDemographicOption("eeoGender", "Woman", ["Male", "Female", "Non-binary"])).toBe("Female");
  });
});

/**
 * REGRESSION (2026-10-03): the matcher tested SUBSTRINGS, so "male" was found
 * inside "female" and "man" inside "woman", and whichever option came first
 * won. Most forms list Female / Woman first, so a male applicant got Female.
 * Same bug class as the driver's old pickOption (optionMatch.ts).
 */
describe("closestDemographicOption: whole words only", () => {
  it("never reads Male as Female, or Man as Woman, whatever the option order", () => {
    expect(closestDemographicOption("eeoGender", "Male", ["Female", "Male", "Decline to self-identify"])).toBe("Male");
    expect(closestDemographicOption("eeoGender", "Man", ["Woman", "Man", "Non-binary"])).toBe("Man");
    expect(closestDemographicOption("eeoGender", "man", ["Woman", "Male", "I prefer not to say"])).toBe("Male");
  });
});
