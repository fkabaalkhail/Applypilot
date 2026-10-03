/**
 * Veteran status (decided with the user, 2026-10-03): "I am not a protected
 * veteran" says nothing about having served, so it fills only an option that
 * says exactly that. "I have never served", "I am not a veteran" and the like
 * are narrower claims and are left for the user, unless the profile says
 * "I have never served in the military" (a profile choice added the same day).
 * Option lists are verbatim from live forms.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPage } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";
import { SPARSE_CANADIAN } from "./fixtures/profiles";
import { stubLayout } from "./helpers/layout";

const NOT_PROTECTED = "I am not a protected veteran";
const NEVER_SERVED = "I have never served in the military";
const PROTECTED = "I identify as one or more of the classifications of a protected veteran";

const FORMS: Record<string, { label: string; options: string[] }> = {
  // Lever and Ashby's standard self-identification (Palantir, Gecko).
  standard: {
    label: "Veteran Status",
    options: ["I identify as one or more of the classifications of protected veteran listed above", "I am not a protected veteran", "I decline to self-identify for protected veteran status"],
  },
  // Robinhood on Greenhouse.
  robinhood: {
    label: "What is your military status?",
    options: ["I am on active duty", "I am part of the national guard or on reserve", "I have never served in the military", "I identify as a protected veteran", "I identify as a non-protected veteran", "I identify in multiple military status categories", "I don't wish to answer"],
  },
  // Zoox and PointClickCare on Lever.
  lever: { label: "Veteran Status", options: ["I am a veteran", "I am not a veteran", "Decline to self-identify"] },
  // Superhuman on Ashby.
  superhuman: {
    label: "Are you a veteran or active member of the United States Armed Forces?",
    options: ["Yes, I am a veteran or active member", "No, I am not a veteran or active member", "I prefer to self-describe", "I don't wish to answer"],
  },
  // ActioNet on Jobvite.
  actionet: {
    label: "Veteran Status",
    options: ["Special Disabled Veteran", "Vietnam Era Veteran", "Newly Separated Veteran", "Other Protected Veteran", "Not a Veteran", "Decline To Self Identify"],
  },
  // Kepler on Lever.
  kepler: { label: "Are you a veteran/have you served in the military?", options: ["Yes", "No", "Prefer not to answer"] },
  protectedYesNo: { label: "Are you a protected veteran?", options: ["Yes", "No", "I don't wish to answer"] },
};

describe("veteran status from the profile's answer", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());

  const propose = (form: keyof typeof FORMS, veteranStatus: string): string | null => {
    const { label, options } = FORMS[form];
    document.body.innerHTML = `<form><fieldset><legend>${label}</legend>${options
      .map((o, i) => `<label><input type="radio" name="v" value="${i}">${o}</label>`)
      .join("")}</fieldset></form>`;
    const profile: UserApplicationProfile = { ...SPARSE_CANADIAN, eeo: { veteranStatus } };
    const fields = scanPage(profile, false, null).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].category).toBe("eeoVeteran");
    return fields[0].proposedValue ?? null;
  };

  it("'not a protected veteran' fills only the option that says exactly that", () => {
    expect(propose("standard", NOT_PROTECTED)).toBe("I am not a protected veteran");
    expect(propose("protectedYesNo", NOT_PROTECTED)).toBe("No");
  });
  it("'not a protected veteran' claims nothing narrower: never served, not a veteran, not a member", () => {
    for (const form of ["robinhood", "lever", "superhuman", "actionet", "kepler"] as const) {
      expect(propose(form, NOT_PROTECTED), form).toBeNull();
    }
  });
  it("'I have never served in the military' answers every way it is asked", () => {
    expect(propose("standard", NEVER_SERVED)).toBe("I am not a protected veteran");
    expect(propose("robinhood", NEVER_SERVED)).toBe("I have never served in the military");
    expect(propose("lever", NEVER_SERVED)).toBe("I am not a veteran");
    expect(propose("superhuman", NEVER_SERVED)).toBe("No, I am not a veteran or active member");
    expect(propose("actionet", NEVER_SERVED)).toBe("Not a Veteran");
    expect(propose("kepler", NEVER_SERVED)).toBe("No");
    expect(propose("protectedYesNo", NEVER_SERVED)).toBe("No");
  });
  it("a protected veteran: the one option it names, never a guessed category", () => {
    expect(propose("standard", PROTECTED)).toBe("I identify as one or more of the classifications of protected veteran listed above");
    expect(propose("robinhood", PROTECTED)).toBe("I identify as a protected veteran");
    expect(propose("lever", PROTECTED)).toBe("I am a veteran");
    expect(propose("superhuman", PROTECTED)).toBe("Yes, I am a veteran or active member");
    expect(propose("kepler", PROTECTED)).toBe("Yes");
    // Four protected categories: which one is the applicant's to say.
    expect(propose("actionet", PROTECTED)).toBeNull();
  });
});

describe("a veteran list that loads on open (Robinhood's combobox)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("the re-ask leaves an unsettled answer blank: the bare matcher's decline is no fallback for it", async () => {
    const { planSensitiveReask } = await import("../src/content/aiFillPlanner");
    const { resolveWithOptions } = await import("../src/content/formScanner");
    const { closestDemographicOption } = await import("../src/content/demographicMatch");
    document.body.innerHTML = `<form><label for="ms">What is your military status?*</label><input id="ms" role="combobox" aria-expanded="false" aria-haspopup="listbox"></form>`;
    const profile: UserApplicationProfile = { ...SPARSE_CANADIAN, eeo: { veteranStatus: NOT_PROTECTED } };
    const { fields, registry } = scanPage(profile, false, null);
    const f = fields.find((x) => x.category === "eeoVeteran")!;
    const opts = FORMS.robinhood.options;
    // The bare matcher does not settle it either (it no longer declines a
    // stated answer for the user, round 3).
    expect(closestDemographicOption("eeoVeteran", f.proposedValue ?? "", opts)).toBeNull();
    const plan = planSensitiveReask(fields, [{ fieldId: f.id, options: opts }], (field, o) => resolveWithOptions(field, registry, profile, null, false, o));
    expect(plan).toEqual([]);
    // The bare matcher is still consulted when re-resolution cannot run at all.
    expect(planSensitiveReask(fields, [{ fieldId: f.id, options: ["I have never served in the military", "I am not a protected veteran"] }], () => undefined)).toEqual([{ fieldId: f.id, value: "I am not a protected veteran" }]);
  });
});
