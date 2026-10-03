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

/**
 * REGRESSION (a real profile on Robinhood, 2026-10-03): "Asian" became "East
 * Asian" because the first option holding the word won. An answer broader
 * than every option it fits names none of them, so the field stays blank and
 * the user picks. Options verbatim from Superhuman's race question (Ashby).
 */
describe("closestDemographicOption: an answer broader than the options", () => {
  const SUPERHUMAN = ["I don't wish to answer", "I prefer to self-describe", "White or European", "Southeast Asian", "South Asian", "Native Hawaiian or Pacific Islander", "Middle Eastern or North African", "Indigenous, American Indian or Alaska Native", "Hispanic, Latinx or of Spanish Origin", "East Asian", "Black or of African descent"];
  it("never picks one subgroup of 'Asian', and never declines for the user either", () => {
    expect(closestDemographicOption("eeoRace", "Asian", SUPERHUMAN)).toBeNull();
  });
  it("an exact option beats a narrower one listed before it", () => {
    expect(closestDemographicOption("eeoRace", "Asian", ["East Asian", "Asian", "White"])).toBe("Asian");
  });
  it("the one option holding the answer is still the answer", () => {
    expect(closestDemographicOption("eeoRace", "Asian", ["White (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "Decline to self-identify"])).toBe("Asian (Not Hispanic or Latino)");
    expect(closestDemographicOption("eeoDisability", "No, I do not have a disability", ["Yes, I have a disability (or previously had a disability)", "No, I do not have a disability and have not had one in the past", "I do not want to answer"])).toBe("No, I do not have a disability and have not had one in the past");
  });
  it("a synonym held by several options is no answer: 'Male' is not 'Cisgender man'", () => {
    expect(closestDemographicOption("eeoGenderIdentity", "Male", ["Cisgender man", "Cisgender woman", "Transgender man", "Transgender woman", "Non-binary"])).toBeNull();
    // The option that IS the synonym still wins over a qualified one.
    expect(closestDemographicOption("eeoGenderIdentity", "Male", ["Transgender man", "Man", "Woman"])).toBe("Man");
  });
});
