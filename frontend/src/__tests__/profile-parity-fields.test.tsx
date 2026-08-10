/**
 * Profile page ⇄ parity contract.
 *
 * Pins the fields added by docs/superpowers/specs/2026-08-09-profile-parity-contract.md:
 * the labels, the exact option vocabularies, and the fact that editing a new
 * field actually reaches PUT /api/user/application-profile. The label and option
 * strings are shared with chrome-extension/src/content/overlay.ts, which carries
 * an equivalent pin on its twin copy, if you change a string here, change it
 * there too or one of the two suites goes red.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
const put = vi.fn();
vi.mock("../auth/api", () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

// PageIntro needs the onboarding provider; none of the fields under test do.
vi.mock("../onboarding", () => ({ PageIntro: () => null }));

import Profile from "../pages/Profile";
import { EEO_OPTIONS, SCREENING_OPTIONS } from "../lib/profileExtras";

// jsdom has no IntersectionObserver; Profile's sticky-nav scroll-spy builds one.
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// ─── Contract section D, transcribed from the spec ───────────────────────────
// Deliberately literal: this is the pin. Do NOT build it from the source arrays.
const CONTRACT_OPTIONS = {
  willingToRelocate: ["Yes", "No"],
  workPreference: ["Remote", "Hybrid", "On-site", "No preference"],
  securityClearance: ["None", "Active clearance", "Eligible / previously held"],
  driversLicense: ["Yes", "No"],
  genderIdentity: ["Cisgender", "Transgender", "Non-binary", "Prefer not to say"],
  pronouns: ["He/Him", "She/Her", "They/Them", "Prefer not to say"],
  sexualOrientation: ["Heterosexual", "Gay or Lesbian", "Bisexual", "Prefer not to say"],
};

// The five pre-existing EEO lists the contract freezes as "unchanged".
const CONTRACT_EEO_UNCHANGED = {
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
};

// Contract section C: the labels the Application Answers card must render.
const SCREENING_LABELS = [
  "Current / Target Job Title",
  "Date of Birth",
  "Work Authorization",
  "Requires Sponsorship",
  "Salary Expectation",
  "Years of Experience",
  "Willing to Relocate",
  "Work Preference",
  "Notice Period",
  "Earliest Start Date",
  "Security Clearance",
  "Driver's Licence",
  "Languages",
];

const EEO_LABELS = [
  "Gender",
  "Race / Ethnicity",
  "Hispanic or Latino",
  "Veteran Status",
  "Disability Status",
  "Gender Identity",
  "Pronouns",
  "Sexual Orientation",
];

// ─── Harness ─────────────────────────────────────────────────────────────────

/** The editor's control for a form label (label + input are siblings, no htmlFor). */
function controlFor(label: string): HTMLInputElement | HTMLSelectElement {
  const labelEl = screen.getByText(label, { selector: ".profile-form-group label" });
  const control = labelEl
    .closest(".profile-form-group")
    ?.querySelector("input, select, textarea");
  if (!control) throw new Error(`no control rendered for label "${label}"`);
  return control as HTMLInputElement | HTMLSelectElement;
}

const optionTexts = (select: HTMLSelectElement) =>
  Array.from(select.options).map((o) => o.textContent);

const saveButton = () => screen.getByRole("button", { name: /save changes/i });

async function renderProfile() {
  render(<Profile />);
  await waitFor(() =>
    expect(screen.queryByText("Loading your profile…")).not.toBeInTheDocument()
  );
}

/** Open one of the card editors by its pencil-button aria-label. */
function openEditor(ariaLabel: string) {
  fireEvent.click(screen.getByRole("button", { name: ariaLabel }));
}

describe("Profile: parity-contract fields", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    // No resume row, empty application profile: every field renders blank and
    // editable, and saving hits ONLY the application-profile endpoint.
    get.mockImplementation((url: string) =>
      url === "/resumes"
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: {} })
    );
    put.mockResolvedValue({ data: {} });
  });

  // ─── Labels ────────────────────────────────────────────────────────────────

  it("renders the contract's Personal labels, incl. GitHub, and drops the old wording", async () => {
    await renderProfile();
    openEditor("Edit personal info");

    for (const label of ["Full Name", "Email Address", "Phone", "Location", "LinkedIn", "GitHub", "Portfolio"]) {
      expect(controlFor(label)).toBeInTheDocument();
    }
    // Harmonised away by the contract, exact-match queries, so "Email Address"
    // does not satisfy "Email".
    expect(screen.queryByText("Email", { selector: ".profile-form-group label" })).toBeNull();
    expect(
      screen.queryByText("Portfolio / Other", { selector: ".profile-form-group label" })
    ).toBeNull();
  });

  it("renders every Application Answers label from the contract", async () => {
    await renderProfile();
    openEditor("Edit application answers");

    for (const label of SCREENING_LABELS) {
      expect(controlFor(label)).toBeInTheDocument();
    }
  });

  it("uses the contract's control types and placeholders", async () => {
    await renderProfile();
    openEditor("Edit application answers");

    expect(controlFor("Date of Birth")).toHaveAttribute("type", "date");
    expect(controlFor("Earliest Start Date")).toHaveAttribute("type", "date");
    expect(controlFor("Notice Period")).toHaveAttribute("placeholder", "2 weeks");
    expect(controlFor("Years of Experience")).toHaveAttribute("placeholder", "5");
    expect(controlFor("Languages")).toHaveAttribute(
      "placeholder",
      "English (Native), French (Professional)"
    );
  });

  it("renders every Equal Employment label from the contract", async () => {
    await renderProfile();
    openEditor("Edit equal employment");

    for (const label of EEO_LABELS) {
      expect(controlFor(label)).toBeInTheDocument();
    }
  });

  // ─── Option vocabularies as rendered ───────────────────────────────────────

  it("offers exactly the contract's screening options, in order, blank first", async () => {
    await renderProfile();
    openEditor("Edit application answers");

    const selects: [string, keyof typeof CONTRACT_OPTIONS][] = [
      ["Willing to Relocate", "willingToRelocate"],
      ["Work Preference", "workPreference"],
      ["Security Clearance", "securityClearance"],
      ["Driver's Licence", "driversLicense"],
    ];
    for (const [label, key] of selects) {
      const control = controlFor(label);
      expect(control.tagName).toBe("SELECT");
      expect(optionTexts(control as HTMLSelectElement)).toEqual([
        "Select…",
        ...CONTRACT_OPTIONS[key],
      ]);
    }
  });

  it("offers exactly the contract's EEO options, in order, blank first", async () => {
    await renderProfile();
    openEditor("Edit equal employment");

    const expected: [string, string[]][] = [
      ["Gender", CONTRACT_EEO_UNCHANGED.gender],
      ["Race / Ethnicity", CONTRACT_EEO_UNCHANGED.race],
      ["Hispanic or Latino", CONTRACT_EEO_UNCHANGED.hispanicLatino],
      ["Veteran Status", CONTRACT_EEO_UNCHANGED.veteranStatus],
      ["Disability Status", CONTRACT_EEO_UNCHANGED.disabilityStatus],
      ["Gender Identity", CONTRACT_OPTIONS.genderIdentity],
      ["Pronouns", CONTRACT_OPTIONS.pronouns],
      ["Sexual Orientation", CONTRACT_OPTIONS.sexualOrientation],
    ];
    for (const [label, options] of expected) {
      const control = controlFor(label);
      expect(control.tagName).toBe("SELECT");
      expect(optionTexts(control as HTMLSelectElement)).toEqual(["Select…", ...options]);
    }
  });

  // ─── Dirty tracking + the PUT payload ──────────────────────────────────────

  it("date of birth marks the form dirty and reaches the profile endpoint", async () => {
    await renderProfile();
    expect(saveButton()).toBeDisabled();

    openEditor("Edit application answers");
    fireEvent.change(controlFor("Date of Birth"), { target: { value: "1999-04-02" } });
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/user/application-profile", {
        dateOfBirth: "1999-04-02",
      })
    );
  });

  it("sends every edited screening answer under its contract key", async () => {
    await renderProfile();
    openEditor("Edit application answers");

    fireEvent.change(controlFor("Willing to Relocate"), { target: { value: "Yes" } });
    fireEvent.change(controlFor("Work Preference"), { target: { value: "Hybrid" } });
    fireEvent.change(controlFor("Notice Period"), { target: { value: "2 weeks" } });
    fireEvent.change(controlFor("Earliest Start Date"), { target: { value: "2026-09-01" } });
    fireEvent.change(controlFor("Years of Experience"), { target: { value: "5" } });
    fireEvent.change(controlFor("Security Clearance"), { target: { value: "None" } });
    fireEvent.change(controlFor("Driver's Licence"), { target: { value: "No" } });
    fireEvent.change(controlFor("Languages"), {
      target: { value: "English (Native), French (Professional)" },
    });

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/user/application-profile", {
        willingToRelocate: "Yes",
        workPreference: "Hybrid",
        noticePeriod: "2 weeks",
        earliestStartDate: "2026-09-01",
        yearsOfExperience: "5",
        securityClearance: "None",
        driversLicense: "No",
        languages: "English (Native), French (Professional)",
      })
    );
  });

  it("nests the three new demographics under eeo", async () => {
    await renderProfile();
    openEditor("Edit equal employment");

    fireEvent.change(controlFor("Gender Identity"), { target: { value: "Non-binary" } });
    fireEvent.change(controlFor("Pronouns"), { target: { value: "They/Them" } });
    fireEvent.change(controlFor("Sexual Orientation"), { target: { value: "Bisexual" } });
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/user/application-profile", {
        eeo: {
          genderIdentity: "Non-binary",
          pronouns: "They/Them",
          sexualOrientation: "Bisexual",
        },
      })
    );
  });

  it("GitHub now round-trips through the profile endpoint, not just the resume row", async () => {
    await renderProfile();
    openEditor("Edit personal info");

    fireEvent.change(controlFor("GitHub"), {
      target: { value: "https://github.com/wissam" },
    });
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/user/application-profile", {
        github: "https://github.com/wissam",
      })
    );
  });

  it("still splits the Full Name composite into firstName / lastName", async () => {
    await renderProfile();
    openEditor("Edit personal info");

    fireEvent.change(controlFor("Full Name"), { target: { value: "Wissam Elmasry" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/user/application-profile", {
        firstName: "Wissam",
        lastName: "Elmasry",
      })
    );
  });

  // ─── Round-trip: values loaded from the API show up in the editors ─────────

  it("loads the new fields back out of GET /api/user/application-profile", async () => {
    get.mockImplementation((url: string) =>
      url === "/resumes"
        ? Promise.resolve({ data: [] })
        : Promise.resolve({
            data: {
              dateOfBirth: "1999-04-02",
              workPreference: "Remote",
              languages: "English (Native)",
              eeo: { pronouns: "She/Her" },
            },
          })
    );
    await renderProfile();

    openEditor("Edit application answers");
    expect(controlFor("Date of Birth")).toHaveValue("1999-04-02");
    expect(controlFor("Work Preference")).toHaveValue("Remote");
    expect(controlFor("Languages")).toHaveValue("English (Native)");
    // Nothing was edited, so the form is still clean.
    expect(saveButton()).toBeDisabled();

    openEditor("Edit equal employment");
    expect(controlFor("Pronouns")).toHaveValue("She/Her");
  });

  // ─── The pin ───────────────────────────────────────────────────────────────

  it("pins the exact option arrays (twin: chrome-extension overlay.ts EEO_CHOICES)", () => {
    expect(SCREENING_OPTIONS.willingToRelocate).toEqual(CONTRACT_OPTIONS.willingToRelocate);
    expect(SCREENING_OPTIONS.workPreference).toEqual(CONTRACT_OPTIONS.workPreference);
    expect(SCREENING_OPTIONS.securityClearance).toEqual(CONTRACT_OPTIONS.securityClearance);
    expect(SCREENING_OPTIONS.driversLicense).toEqual(CONTRACT_OPTIONS.driversLicense);
    expect(Object.keys(SCREENING_OPTIONS)).toEqual([
      "willingToRelocate",
      "workPreference",
      "securityClearance",
      "driversLicense",
    ]);

    expect(EEO_OPTIONS.gender).toEqual(CONTRACT_EEO_UNCHANGED.gender);
    expect(EEO_OPTIONS.race).toEqual(CONTRACT_EEO_UNCHANGED.race);
    expect(EEO_OPTIONS.hispanicLatino).toEqual(CONTRACT_EEO_UNCHANGED.hispanicLatino);
    expect(EEO_OPTIONS.veteranStatus).toEqual(CONTRACT_EEO_UNCHANGED.veteranStatus);
    expect(EEO_OPTIONS.disabilityStatus).toEqual(CONTRACT_EEO_UNCHANGED.disabilityStatus);
    expect(EEO_OPTIONS.genderIdentity).toEqual(CONTRACT_OPTIONS.genderIdentity);
    expect(EEO_OPTIONS.pronouns).toEqual(CONTRACT_OPTIONS.pronouns);
    expect(EEO_OPTIONS.sexualOrientation).toEqual(CONTRACT_OPTIONS.sexualOrientation);
    expect(Object.keys(EEO_OPTIONS)).toEqual([
      "gender",
      "race",
      "hispanicLatino",
      "veteranStatus",
      "disabilityStatus",
      "genderIdentity",
      "pronouns",
      "sexualOrientation",
    ]);
  });
});
