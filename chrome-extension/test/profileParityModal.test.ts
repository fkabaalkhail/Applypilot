/**
 * The Autofill Information modal against the 2026-08-09 profile-parity
 * contract (docs/superpowers/specs/2026-08-09-profile-parity-contract.md).
 *
 * Two failure modes are worth a suite of their own:
 *
 *  1. LABEL DRIFT. The web app's Profile page and this modal edit the SAME
 *     record. A label reworded on one side turns "the field I filled on the
 *     web" into "a different field" for the user. §C fixes the strings; these
 *     tests pin them.
 *
 *  2. RENDERS BUT NEVER SAVES. A field can be added to the markup and left out
 *     of EditableProfileDraft / draftFromProfile / saveInfoEdits's diff, in
 *     which case it displays the value, accepts typing, and throws the edit
 *     away on Update, with no error anywhere. Every contract field is
 *     round-tripped below through the real UPDATE_PROFILE payload.
 */
import { describe, it, expect } from "vitest";
import {
  EEO_CHOICES,
  SCREENING_CHOICES,
  draftFromProfile,
  infoSectionHTML,
  profileUpdateDiff,
  type EditableProfileDraft,
} from "../src/content/overlay";
import { emptyExtras } from "../src/content/autofillExtras";
import type { UserApplicationProfile } from "../src/shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blankProfile(over: Partial<UserApplicationProfile> = {}): UserApplicationProfile {
  return {
    firstName: "", lastName: "", email: "", phone: "", location: "",
    addressStreet: "", addressCity: "", addressState: "", postalCode: "", country: "",
    linkedin: "", github: "", portfolio: "", currentCompany: "", currentTitle: "",
    workAuthorization: "", requiresSponsorship: "", dateOfBirth: "",
    education: [], experience: [], skills: [], coverLetter: "",
    ...over,
  } as UserApplicationProfile;
}

/** Render one modal section into a detached DOM node. */
function section(
  cat: "personal" | "address" | "preference" | "eeo" | "experience",
  p: UserApplicationProfile = blankProfile()
): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = infoSectionHTML(cat, p, draftFromProfile(p), emptyExtras());
  return host;
}

/** Every visible field label in a rendered section, in render order. */
function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".ap-form-row > label")].map((l) =>
    (l.textContent ?? "").replace(/\*/g, "").trim()
  );
}

const control = (host: HTMLElement, field: string): HTMLElement | null =>
  host.querySelector(`[data-field="${field}"]`);

// ---------------------------------------------------------------------------
// §C, exact labels
// ---------------------------------------------------------------------------

describe("contract §C, Personal tab labels", () => {
  it("renders exactly the contract's Personal fields, in order", () => {
    expect(labels(section("personal"))).toEqual([
      "First Name",
      "Last Name",
      "Email Address",
      "Phone",
      "Location",
      "Current / Target Job Title",
      "Date of Birth",
      "LinkedIn",
      "GitHub",
      "Portfolio",
    ]);
  });

  it("always renders LinkedIn / GitHub / Portfolio, even when blank", () => {
    // They used to be rendered only when already non-empty, so a user could
    // never ADD a link they didn't have, the row simply wasn't there.
    const host = section("personal");
    for (const f of ["linkedin", "github", "portfolio"]) {
      expect(control(host, f), f).not.toBeNull();
      expect((control(host, f) as HTMLInputElement).value, f).toBe("");
    }
  });

  it("binds GitHub to the SYNCED draft, not to a device-local extra", () => {
    const host = section("personal", blankProfile({ github: "https://github.com/ada" }));
    expect(host.querySelector('[data-extra="github"]')).toBeNull();
    expect((control(host, "github") as HTMLInputElement).value).toBe("https://github.com/ada");
  });
});

describe("contract §C, Preference tab labels", () => {
  it("renders the three existing plus all eight screening answers", () => {
    expect(labels(section("preference"))).toEqual([
      "Work Authorization",
      "Requires Sponsorship",
      "Salary Expectation",
      "Willing to Relocate",
      "Work Preference",
      "Notice Period",
      "Earliest Start Date",
      "Years of Experience",
      "Security Clearance",
      "Driver's Licence",
      "Languages",
    ]);
  });

  it("uses the contract's exact placeholders", () => {
    const host = section("preference");
    const ph = (f: string) => (control(host, f) as HTMLInputElement).placeholder;
    expect(ph("languages")).toBe("English (Native), French (Professional)");
    expect(ph("noticePeriod")).toBe("2 weeks");
    expect(ph("yearsOfExperience")).toBe("5");
  });

  it("uses a date control for the earliest start date", () => {
    expect((control(section("preference"), "earliestStartDate") as HTMLInputElement).type).toBe("date");
  });
});

describe("contract §C, Equal Employment tab labels", () => {
  it("renders the five original plus the three new demographics", () => {
    expect(labels(section("eeo"))).toEqual([
      "Gender",
      "Race / Ethnicity",
      "Hispanic or Latino",
      "Veteran Status",
      "Disability Status",
      "Gender Identity",
      "Pronouns",
      "Sexual Orientation",
    ]);
  });
});

// ---------------------------------------------------------------------------
// §D, exact option vocabularies
// ---------------------------------------------------------------------------

describe("contract §D, option vocabularies", () => {
  it("pins EEO_CHOICES byte-for-byte (twin: frontend/src/lib/profileExtras.ts EEO_OPTIONS)", () => {
    expect(EEO_CHOICES).toEqual({
      gender: ["Male", "Female", "Non-binary", "Prefer not to say"],
      race: [
        "American Indian or Alaska Native",
        "Asian",
        "Black or African American",
        "Hispanic or Latino",
        "Native Hawaiian or Other Pacific Islander",
        "White",
        "Two or More Races",
        "Prefer not to say",
      ],
      hispanicLatino: ["Yes", "No", "Prefer not to say"],
      veteranStatus: [
        "I am not a protected veteran",
        "I identify as one or more of the classifications of a protected veteran",
        "Prefer not to say",
      ],
      disabilityStatus: [
        "Yes, I have a disability",
        "No, I do not have a disability",
        "Prefer not to say",
      ],
      genderIdentity: ["Cisgender", "Transgender", "Non-binary", "Prefer not to say"],
      pronouns: ["He/Him", "She/Her", "They/Them", "Prefer not to say"],
      sexualOrientation: ["Heterosexual", "Gay or Lesbian", "Bisexual", "Prefer not to say"],
    });
  });

  it("pins the screening option lists byte-for-byte", () => {
    expect(SCREENING_CHOICES).toEqual({
      willingToRelocate: ["Yes", "No"],
      workPreference: ["Remote", "Hybrid", "On-site", "No preference"],
      securityClearance: ["None", "Active clearance", "Eligible / previously held"],
      driversLicense: ["Yes", "No"],
    });
  });

  it("renders every select with a blank first option labelled Select…", () => {
    for (const host of [section("preference"), section("eeo")]) {
      const selects = [...host.querySelectorAll("select")];
      expect(selects.length).toBeGreaterThan(0);
      for (const s of selects) {
        expect(s.options[0].value).toBe("");
        expect(s.options[0].textContent).toBe("Select…");
      }
    }
  });

  it("renders exactly the contract options after the blank, in order", () => {
    const host = section("preference");
    for (const [field, expected] of Object.entries(SCREENING_CHOICES)) {
      const sel = host.querySelector<HTMLSelectElement>(`select[data-field="${field}"]`)!;
      expect([...sel.options].slice(1).map((o) => o.textContent), field).toEqual(expected);
    }
    const eeo = section("eeo");
    for (const [field, expected] of Object.entries(EEO_CHOICES)) {
      const sel = eeo.querySelector<HTMLSelectElement>(`select[data-eeo="${field}"]`)!;
      expect([...sel.options].slice(1).map((o) => o.textContent), field).toEqual(expected);
    }
  });

  it("preselects the stored answer", () => {
    const p = blankProfile({
      workPreference: "Hybrid",
      eeo: { pronouns: "They/Them" },
    });
    expect(
      section("preference", p).querySelector<HTMLSelectElement>('select[data-field="workPreference"]')!.value
    ).toBe("Hybrid");
    expect(
      section("eeo", p).querySelector<HTMLSelectElement>('select[data-eeo="pronouns"]')!.value
    ).toBe("They/Them");
  });
});

// ---------------------------------------------------------------------------
// §F, work experience is honest about staying on this device
// ---------------------------------------------------------------------------

describe("contract §F, device-local work experience says so", () => {
  it("tells the user those edits never reach the web app", () => {
    const text = section("experience").textContent ?? "";
    expect(text).toContain("stay on this device");
    expect(text.toLowerCase()).toContain("do not change your tailrd profile");
  });
});

// ---------------------------------------------------------------------------
// §E, every rendered field actually saves
// ---------------------------------------------------------------------------

/** Type into one modal control exactly the way the delegated input handler
 *  does, then produce the payload saveInfoEdits would PUT. */
function editAndSave(
  edits: Record<string, string>,
  eeoEdits: Record<string, string> = {}
): Partial<UserApplicationProfile> {
  const orig = blankProfile();
  const draft = draftFromProfile(orig) as unknown as Record<string, unknown>;
  Object.assign(draft, edits);
  Object.assign(draft.eeo as Record<string, string>, eeoEdits);
  return profileUpdateDiff(draft as unknown as EditableProfileDraft, orig);
}

const NEW_SCALARS: Record<string, string> = {
  github: "https://github.com/ada",
  currentTitle: "Staff Engineer",
  willingToRelocate: "Yes",
  workPreference: "Remote",
  noticePeriod: "2 weeks",
  earliestStartDate: "2026-09-01",
  yearsOfExperience: "5",
  securityClearance: "Active clearance",
  driversLicense: "No",
  languages: "English (Native), French (Professional)",
};
const NEW_DEMOGRAPHICS: Record<string, string> = {
  genderIdentity: "Non-binary",
  pronouns: "They/Them",
  sexualOrientation: "Bisexual",
};

describe("contract §E, every new field round-trips to UPDATE_PROFILE", () => {
  it("sends every new scalar, one at a time, so no single field can be missed", () => {
    for (const [key, value] of Object.entries(NEW_SCALARS)) {
      const update = editAndSave({ [key]: value }) as Record<string, unknown>;
      expect(update[key], `${key} renders but never saves`).toBe(value);
      // Only the edited key travels, a no-op field must not bump sync.
      expect(Object.keys(update)).toEqual([key]);
    }
  });

  it("sends every new demographic, nested under eeo", () => {
    for (const [key, value] of Object.entries(NEW_DEMOGRAPHICS)) {
      const update = editAndSave({}, { [key]: value });
      expect(update.eeo, `eeo.${key} renders but never saves`).toEqual({ [key]: value });
    }
  });

  it("sends every one of them together", () => {
    const update = editAndSave(NEW_SCALARS, NEW_DEMOGRAPHICS) as Record<string, unknown>;
    for (const [key, value] of Object.entries(NEW_SCALARS)) expect(update[key], key).toBe(value);
    expect(update.eeo).toEqual(NEW_DEMOGRAPHICS);
  });

  it("sends nothing at all when nothing was edited", () => {
    // A no-op Update must not bump the shared sync version.
    expect(editAndSave({}, {})).toEqual({});
  });

  /**
   * The structural guard: walk the REAL markup and prove that every control it
   * binds is one the save diff carries. A field added to a section but left
   * out of EditableProfileDraft fails here without anyone remembering to write
   * a case for it.
   */
  it("saves every data-field / data-eeo control the modal renders", () => {
    const rendered = { fields: new Set<string>(), eeo: new Set<string>() };
    for (const cat of ["personal", "address", "preference", "eeo"] as const) {
      const host = section(cat);
      for (const el of host.querySelectorAll<HTMLElement>("[data-field]")) {
        rendered.fields.add(el.dataset.field!);
      }
      for (const el of host.querySelectorAll<HTMLElement>("[data-eeo]")) {
        rendered.eeo.add(el.dataset.eeo!);
      }
    }
    expect(rendered.fields.size).toBeGreaterThan(20);
    expect(rendered.eeo.size).toBe(8);

    for (const f of rendered.fields) {
      const update = editAndSave({ [f]: "sentinel" }) as Record<string, unknown>;
      expect(update[f], `${f} renders but never saves`).toBe("sentinel");
    }
    for (const f of rendered.eeo) {
      expect(editAndSave({}, { [f]: "sentinel" }).eeo, `eeo.${f} renders but never saves`).toEqual({
        [f]: "sentinel",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The draft is the contract between "renders" and "saves"
// ---------------------------------------------------------------------------

describe("draftFromProfile", () => {
  it("carries every contract field off the profile", () => {
    const p = blankProfile({
      github: "gh", currentTitle: "Eng",
      willingToRelocate: "No", workPreference: "On-site", noticePeriod: "1 month",
      earliestStartDate: "2026-01-05", yearsOfExperience: "8",
      securityClearance: "None", driversLicense: "Yes", languages: "English",
      eeo: { genderIdentity: "Cisgender", pronouns: "She/Her", sexualOrientation: "Heterosexual" },
    });
    const d: EditableProfileDraft = draftFromProfile(p);
    expect(d).toMatchObject({
      github: "gh", currentTitle: "Eng",
      willingToRelocate: "No", workPreference: "On-site", noticePeriod: "1 month",
      earliestStartDate: "2026-01-05", yearsOfExperience: "8",
      securityClearance: "None", driversLicense: "Yes", languages: "English",
    });
    expect(d.eeo).toMatchObject({
      genderIdentity: "Cisgender", pronouns: "She/Her", sexualOrientation: "Heterosexual",
    });
  });

  it('defaults every unanswered field to "" rather than undefined', () => {
    const d = draftFromProfile(blankProfile());
    for (const [k, v] of Object.entries(d)) {
      if (k === "eeo") continue;
      expect(typeof v, k).toBe("string");
    }
  });
});
