import { describe, it, expect } from "vitest";
import { computeProfileDiff } from "../lib/profileExtras";

const EMPTY = {
  addressStreet: "",
  addressCity: "",
  addressState: "",
  postalCode: "",
  country: "",
  eeo: {
    gender: "",
    race: "",
    hispanicLatino: "",
    veteranStatus: "",
    disabilityStatus: "",
  },
};

describe("computeProfileDiff", () => {
  it("returns null when nothing changed", () => {
    expect(computeProfileDiff(EMPTY, EMPTY)).toBeNull();
  });

  it("emits only changed address keys, in camelCase", () => {
    const diff = computeProfileDiff(EMPTY, {
      ...EMPTY,
      addressStreet: "1 King St",
      postalCode: "K1A 0B1",
    });
    expect(diff).toEqual({ addressStreet: "1 King St", postalCode: "K1A 0B1" });
  });

  it("nests only changed EEO answers under eeo", () => {
    const diff = computeProfileDiff(EMPTY, {
      ...EMPTY,
      eeo: { ...EMPTY.eeo, gender: "Female", veteranStatus: "Prefer not to say" },
    });
    expect(diff).toEqual({
      eeo: { gender: "Female", veteranStatus: "Prefer not to say" },
    });
  });

  it("combines address and EEO changes into one payload", () => {
    const diff = computeProfileDiff(EMPTY, {
      ...EMPTY,
      country: "Canada",
      eeo: { ...EMPTY.eeo, race: "Asian" },
    });
    expect(diff).toEqual({ country: "Canada", eeo: { race: "Asian" } });
  });
});
