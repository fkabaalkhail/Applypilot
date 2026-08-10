import { describe, it, expect } from "vitest";
import {
  emptyExtras,
  normalizeExtras,
  pruneExtras,
  mergeProfileWithExtras,
  customFieldAnswers,
  type AutofillExtras,
} from "../src/content/autofillExtras";
import type { UserApplicationProfile } from "../src/shared/types";

function profile(over: Partial<UserApplicationProfile> = {}): UserApplicationProfile {
  return {
    firstName: "Ada", lastName: "Lovelace", email: "ada@x.com", phone: "", location: "",
    addressStreet: "", addressCity: "", addressState: "", postalCode: "", country: "",
    linkedin: "", github: "", portfolio: "", currentCompany: "", currentTitle: "",
    workAuthorization: "", requiresSponsorship: "",
    education: [], experience: [], skills: [], coverLetter: "",
    ...over,
  } as UserApplicationProfile;
}

describe("normalizeExtras", () => {
  it("returns a well-formed empty shape for junk / missing input", () => {
    expect(normalizeExtras(undefined)).toEqual(emptyExtras());
    expect(normalizeExtras(null)).toEqual(emptyExtras());
    expect(normalizeExtras(42)).toEqual(emptyExtras());
  });
  it("keeps only non-empty scalar overrides and well-formed custom fields", () => {
    const n = normalizeExtras({
      fields: { website: "https://ada.dev", linkedin: "  ", nope: 5 },
      experience: null,
      customFields: [
        { id: "a", section: "personal", label: "Pronouns", value: "she/her" },
        { label: "" }, // dropped later by prune, kept by normalize but harmless
        "junk",
      ],
    });
    expect(n.fields).toEqual({ website: "https://ada.dev" });
    expect(n.customFields.map((c) => c.label)).toContain("Pronouns");
  });

  it("drops a retired device-local github override so it cannot shadow the sync", () => {
    // github now round-trips through PUT /api/user/application-profile. A stale
    // local copy would win forever over whatever the user sets on the web app,
    // the exact bug the 2026-08-09 parity contract set out to kill.
    const n = normalizeExtras({
      fields: { github: "https://github.com/stale", website: "https://ada.dev" },
      experience: null,
      customFields: [],
    });
    expect(n.fields).toEqual({ website: "https://ada.dev" });
    expect("github" in n.fields).toBe(false);
  });
});

describe("mergeProfileWithExtras", () => {
  // The merge stays generic so an OLDER stored blob keeps filling; nothing in
  // the UI writes scalar overrides any more (github moved to the synced
  // profile, see the retired-key test above).
  it("overrides a scalar from a legacy stored blob without mutating the input", () => {
    const p = profile({ portfolio: "" });
    const extras: AutofillExtras = { fields: { portfolio: "https://ada.dev" }, experience: null, customFields: [] };
    const merged = mergeProfileWithExtras(p, extras);
    expect(merged.portfolio).toBe("https://ada.dev");
    expect(p.portfolio).toBe(""); // original untouched
  });
  it("replaces experience with the user-edited array", () => {
    const p = profile({ experience: [{ company: "Old", title: "Dev", startDate: "2019", endDate: "2020" } as any] });
    const extras: AutofillExtras = {
      fields: {}, customFields: [],
      experience: [{ company: "New Corp", title: "Staff Eng", startDate: "2021", endDate: "" } as any],
    };
    expect(mergeProfileWithExtras(p, extras).experience[0].company).toBe("New Corp");
  });
  it("leaves the synced value when the override is blank", () => {
    const p = profile({ portfolio: "https://synced.dev" });
    const merged = mergeProfileWithExtras(p, { fields: { portfolio: "   " }, experience: null, customFields: [] });
    expect(merged.portfolio).toBe("https://synced.dev");
  });
  it("keeps synced experience when no override array is set", () => {
    const p = profile({ experience: [{ company: "Synced", title: "Dev" } as any] });
    expect(mergeProfileWithExtras(p, emptyExtras()).experience[0].company).toBe("Synced");
  });
});

describe("customFieldAnswers", () => {
  it("maps normalized labels to values for the fill path", () => {
    const extras: AutofillExtras = {
      fields: {}, experience: null,
      customFields: [
        { id: "1", section: "personal", label: "Preferred Pronouns", value: "she/her" },
        { id: "2", section: "personal", label: "Notice Period", value: "2 weeks" },
        { id: "3", section: "personal", label: "  ", value: "ignored" },
        { id: "4", section: "personal", label: "Empty", value: "  " },
      ],
    };
    const m = customFieldAnswers(extras);
    expect(m.get("preferred pronouns")).toBe("she/her");
    expect(m.get("notice period")).toBe("2 weeks");
    expect(m.has("empty")).toBe(false); // blank value dropped
    expect(m.size).toBe(2);
  });
});

describe("pruneExtras", () => {
  it("drops blank overrides and incomplete custom fields", () => {
    const pruned = pruneExtras({
      fields: { portfolio: " https://x ", linkedin: "  " },
      experience: null,
      customFields: [
        { id: "1", section: "personal", label: " Pronouns ", value: " she/her " },
        { id: "2", section: "personal", label: "No value", value: "" },
        { id: "3", section: "personal", label: "", value: "orphan" },
      ],
    });
    expect(pruned.fields).toEqual({ portfolio: "https://x" });
    expect(pruned.customFields).toHaveLength(1);
    expect(pruned.customFields[0]).toMatchObject({ label: "Pronouns", value: "she/her" });
  });
});
