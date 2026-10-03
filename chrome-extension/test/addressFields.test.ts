import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { classifyField, resolveProfileValue } from "../src/content/fieldMatcher";
import { scanPage } from "../src/content/formScanner";
import { pickLocationSuggestion } from "../src/content/adapters/lever";
import { stubLayout } from "./helpers/layout";
import type { FieldSignals } from "../src/content/domUtils";
import type { UserApplicationProfile } from "../src/shared/types";

/** Build a FieldSignals with only the sources under test populated. */
function sig(over: Partial<FieldSignals>): FieldSignals {
  return {
    label: "",
    ariaLabel: "",
    placeholder: "",
    nearby: "",
    nameAttr: "",
    idAttr: "",
    autocomplete: "",
    typeHint: "",
    testId: "",
    ...over,
  };
}

const byLabel = (label: string) => classifyField(sig({ label })).category;
const byAutocomplete = (autocomplete: string) => classifyField(sig({ autocomplete })).category;

describe("classifyField, structured address categories (EN)", () => {
  it("classifies a street-address label", () => {
    expect(byLabel("Street Address")).toBe("addressStreet");
    expect(byLabel("Address Line 1")).toBe("addressStreet");
    expect(byLabel("Civic Address")).toBe("addressStreet");
  });
  it("classifies a city label", () => {
    expect(byLabel("City")).toBe("addressCity");
    expect(byLabel("Town")).toBe("addressCity");
  });
  it("classifies a state / province label", () => {
    expect(byLabel("State")).toBe("addressState");
    expect(byLabel("Province")).toBe("addressState");
    expect(byLabel("State / Region")).toBe("addressState");
  });
  it("classifies a postal / zip code label", () => {
    expect(byLabel("Postal Code")).toBe("postalCode");
    expect(byLabel("ZIP Code")).toBe("postalCode");
    expect(byLabel("ZIP")).toBe("postalCode");
  });
  it("classifies a country label", () => {
    expect(byLabel("Country")).toBe("country");
  });
});

describe("classifyField, structured address categories (FR)", () => {
  it("classifies French address labels", () => {
    expect(byLabel("Adresse")).toBe("addressStreet");
    expect(byLabel("Ville")).toBe("addressCity");
    expect(byLabel("Province")).toBe("addressState");
    // normalize() drops the accent ("Région" -> "r gion"); the rule still catches it.
    expect(byLabel("Région")).toBe("addressState");
    expect(byLabel("Code postal")).toBe("postalCode");
    expect(byLabel("Pays")).toBe("country");
  });
});

describe("classifyField, address does NOT swallow email (regression)", () => {
  it('classifies "Email address" as email, never addressStreet or location', () => {
    expect(byLabel("Email address")).toBe("email");
    expect(byLabel("E-mail Address")).toBe("email");
  });
  // FR: "Adresse courriel" / "Adresse électronique" both contain "adresse", which
  // the addressStreet rule matches. They must classify as email, not a street.
  it("classifies French email labels as email, never addressStreet", () => {
    expect(byLabel("Adresse courriel")).toBe("email");
    expect(byLabel("Adresse électronique")).toBe("email");
    expect(byLabel("Courriel")).toBe("email");
  });
});

describe("classifyField, HTML autocomplete tokens map to address categories", () => {
  it("maps the standard address autocomplete tokens", () => {
    expect(byAutocomplete("street-address")).toBe("addressStreet");
    expect(byAutocomplete("address-line1")).toBe("addressStreet");
    expect(byAutocomplete("address-level2")).toBe("addressCity");
    expect(byAutocomplete("address-level1")).toBe("addressState");
    expect(byAutocomplete("postal-code")).toBe("postalCode");
    expect(byAutocomplete("country")).toBe("country");
    expect(byAutocomplete("country-name")).toBe("country");
  });
});

const sel = { controlType: "text" as const };

describe("resolveProfileValue, structured address mapping", () => {
  const full = {
    addressStreet: "123 Main St",
    addressCity: "Toronto",
    addressState: "ON",
    postalCode: "M5V 2T6",
    country: "Canada",
    location: "Ottawa, ON, Canada",
  } as unknown as UserApplicationProfile;

  it("maps each category to its profile field", () => {
    expect(resolveProfileValue("addressStreet", full, sel, false)).toBe("123 Main St");
    expect(resolveProfileValue("addressCity", full, sel, false)).toBe("Toronto");
    expect(resolveProfileValue("addressState", full, sel, false)).toBe("ON");
    expect(resolveProfileValue("postalCode", full, sel, false)).toBe("M5V 2T6");
    expect(resolveProfileValue("country", full, sel, false)).toBe("Canada");
  });

  // 2026-10-03: the CITY part of the location string, never the whole
  // "Ottawa, ON, Canada" (which BambooHR/Jobvite City fields received live).
  it("derives the city from profile.location when addressCity is empty", () => {
    const p = { addressCity: "", location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(resolveProfileValue("addressCity", p, sel, false)).toBe("Ottawa");
  });

  it("returns null when the profile has no value (and no fallback)", () => {
    const empty = {
      addressStreet: "",
      addressCity: "",
      addressState: "",
      postalCode: "",
      country: "",
      location: "",
    } as unknown as UserApplicationProfile;
    expect(resolveProfileValue("addressStreet", empty, sel, false)).toBeNull();
    expect(resolveProfileValue("addressState", empty, sel, false)).toBeNull();
    expect(resolveProfileValue("postalCode", empty, sel, false)).toBeNull();
    expect(resolveProfileValue("country", empty, sel, false)).toBeNull();
    expect(resolveProfileValue("addressCity", empty, sel, false)).toBeNull();
  });
});

/**
 * REGRESSION (a real profile, 2026-10-03): location "Gatineau", with the
 * province and country stored apart. Lever's typeahead lists two Gatineaus
 * (verbatim from jobs.lever.co/searchLocations?text=Gatineau), so the bare
 * city picked neither, and "Current location" stayed blank on all eight
 * Lever pages.
 */
describe("resolveProfileValue: a bare-city location is completed from the address", () => {
  const p = { location: "Gatineau", addressCity: "Gatineau", addressState: "Quebec", country: "Canada" } as unknown as UserApplicationProfile;
  it("adds the region and country the profile stores apart", () => {
    expect(resolveProfileValue("location", p, sel, false)).toBe("Gatineau, QC, Canada");
  });
  it("so Lever's picker takes the Canadian Gatineau", () => {
    const live = ["Gatineau, QC, CAN", "Gatineau, Jeremi, Depatman Grandans, HTI"];
    expect(pickLocationSuggestion(live, "Gatineau")).toBe(-1);
    expect(pickLocationSuggestion(live, resolveProfileValue("location", p, sel, false)!)).toBe(0);
  });
  it("leaves a location naming more than a city, or a different city, as stated", () => {
    expect(resolveProfileValue("location", { ...p, location: "Ottawa, ON, Canada" } as UserApplicationProfile, sel, false)).toBe("Ottawa, ON, Canada");
    expect(resolveProfileValue("location", { ...p, location: "Montreal" } as UserApplicationProfile, sel, false)).toBe("Montreal");
  });
});

describe("scanPage, postal-code input resolves from profile.postalCode", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("gives a labeled postal-code input a proposedValue from the new profile field", () => {
    document.body.innerHTML = `<label for="pc">Postal code</label><input id="pc" name="postal" />`;
    const profile = { postalCode: "K1A 0A6", location: "Ottawa" } as unknown as UserApplicationProfile;
    const { fields } = scanPage(profile, false, null);
    const f = fields.find((x) => x.category === "postalCode");
    expect(f).toBeTruthy();
    expect(f!.proposedValue).toBe("K1A 0A6");
  });
});
