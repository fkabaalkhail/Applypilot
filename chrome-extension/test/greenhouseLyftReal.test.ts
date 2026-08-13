// chrome-extension/test/greenhouseLyftReal.test.ts
/**
 * Regression tests for the real Lyft application on Greenhouse
 * (job-boards.greenhouse.io/embed/job_app?for=lyft), diagnosed 2026-08-12 from
 * autofill_reports #167: 24 fields, 11 filled, 13 failed.
 *
 * Every label and every control shape below is copied verbatim from that live
 * form, not invented. The form has ZERO <select> elements: every dropdown is an
 * `<input type="text" role="combobox" autocomplete="list">`, which is why so
 * much of it depends on classification being right the first time.
 *
 * The bugs this pins, all four visible in that one report:
 *  1. The 431-char "I certify …" statement says "Employer" three times, so
 *     currentCompany's loose /\bemployer\b/ claimed it and Lyft was sent the
 *     applicant's employer name typed into their legal certification box.
 *  2. "May we contact your current employer?" is a Yes/No question, and was
 *     also classified currentCompany (it would answer with a company name).
 *  3. "Please share your gender pronouns." tied between eeoGender and
 *     eeoPronouns; eeoGender is listed first, so it won and proposed "Male"
 *     into a pronouns list ("No option matches \"Male\"" in the report).
 *  4. Greenhouse suffixes its repeating-row index ("start-date-month-0"), and
 *     detectGroupIndex only matched an index followed by another delimiter, so
 *     every employment date resolved to null and the date pickers filled nothing.
 */
import { describe, it, expect } from "vitest";
import { classifyField, deriveDegreeLevel, resolveProfileValue } from "../src/content/fieldMatcher";
import { detectGroupIndex } from "../src/content/groupIndex";
import { greenhouseAdapter } from "../src/content/adapters/greenhouse";
import { planOnDeviceReask } from "../src/content/aiFillPlanner";
import { matchOption } from "../src/content/writeEngine";
import type { FieldSignals } from "../src/content/domUtils";
import type { DetectedField, ResolveControl, UserApplicationProfile } from "../src/shared/types";

/** The certification field's label, verbatim from the live form (431 chars). */
const CERTIFICATION =
  "I certify that the facts set forth in this Application for Employment are true " +
  "and complete to the best of my knowledge. I understand that if I am employed, " +
  "false statements, omissions or misrepresentations may result in my dismissal. " +
  "I authorize the Employer to make an investigation of any of the facts set forth " +
  "in this application and release the Employer from any liability. The employer " +
  "may contact any provided references. *";

/** The relocation question, verbatim: prose, but it must still be recognized. */
const RELOCATION =
  "This position is required to work out of a Lyft Office in Toronto, if you do " +
  "not reside within the country and within commutable proximity to the office, " +
  "are you open to relocating? *";

function signals(over: Partial<FieldSignals>): FieldSignals {
  return {
    label: "", ariaLabel: "", placeholder: "", nameAttr: "", testId: "",
    idAttr: "", nearby: "", autocomplete: "", typeHint: "",
    ...over,
  } as FieldSignals;
}

const byLabel = (label: string) => classifyField(signals({ label }));

const profile: UserApplicationProfile = {
  firstName: "Wissam", lastName: "Elmasry",
  email: "elmasry.wissam@gmail.com", phone: "+1 555 0100",
  location: "Toronto, ON", addressStreet: "1 King St", addressCity: "Toronto",
  addressState: "ON", postalCode: "M5H 1A1", country: "Canada",
  linkedin: "", github: "", portfolio: "",
  currentCompany: "Tailrd", currentTitle: "Software Engineer",
  workAuthorization: "Authorized to work in Canada", requiresSponsorship: "No",
  dateOfBirth: "", coverLetter: "", skills: [],
  education: [{ degree: "BSc Computer Science", school: "University of Toronto", graduationYear: "2025" }],
  experience: [{ title: "Software Engineer", company: "Tailrd", startDate: "2023-06", endDate: "", description: "" }],
  eeo: { gender: "Male" },
} as UserApplicationProfile;

// ---------------------------------------------------------------------------
// Bug 1 + 2: currentCompany claiming prose and Yes/No questions
// ---------------------------------------------------------------------------

describe("Lyft/Greenhouse: currentCompany must not claim statements or questions", () => {
  it("does not classify the 431-char certification statement as currentCompany", () => {
    // It says "Employer" three times. It is not an employer field.
    expect(byLabel(CERTIFICATION).category).not.toBe("currentCompany");
  });

  it("does not classify 'May we contact your current employer?' as currentCompany", () => {
    // A Yes/No question ABOUT the employer, not a field asking for its name.
    expect(byLabel("May we contact your current employer? *").category).not.toBe("currentCompany");
  });

  it("still classifies a plain 'Company name' field as currentCompany", () => {
    // The guard must not cost us the field it exists to fill (this one filled
    // correctly on the real form and must keep doing so).
    expect(byLabel("Company name *").category).toBe("currentCompany");
    expect(byLabel("Current employer").category).toBe("currentCompany");
  });

  it("still recognizes the prose relocation question", () => {
    // 30 words of prose, but it carries an exact "open to relocating" phrase,
    // so the prose guard must not swallow it.
    expect(byLabel(RELOCATION).category).toBe("willingToRelocate");
  });
});

// ---------------------------------------------------------------------------
// Bug 3: pronouns are not gender
// ---------------------------------------------------------------------------

describe("Lyft/Greenhouse: gender pronouns", () => {
  it("classifies 'Please share your gender pronouns.' as eeoPronouns", () => {
    expect(byLabel("Please share your gender pronouns.").category).toBe("eeoPronouns");
  });

  it("never proposes a gender answer for a pronouns field", () => {
    // The live report: 'No option matches "Male" (saw: She / Her | He / Him | …)'
    const control: ResolveControl = { controlType: "combobox" };
    expect(resolveProfileValue("eeoPronouns", profile, control, true)).toBeNull();
  });

  it("still classifies a plain gender field as eeoGender", () => {
    expect(byLabel("Gender").category).toBe("eeoGender");
  });

  it("greenhouseAdapter does not answer a pronouns field with a gender option", () => {
    const answer = greenhouseAdapter.resolveAnswer!({
      category: "eeoPronouns", profile, control: { controlType: "combobox" },
      fillEEO: true, el: document.createElement("input"),
    });
    expect(answer).not.toBe("Male");
  });
});

// ---------------------------------------------------------------------------
// Bug 4: the date pickers
// ---------------------------------------------------------------------------

describe("Lyft/Greenhouse: repeating-row index and split dates", () => {
  it("reads the trailing row index off Greenhouse ids", () => {
    // Greenhouse puts the index LAST, with nothing after it.
    expect(detectGroupIndex(signals({ idAttr: "start-date-month-0" }))).toBe(0);
    expect(detectGroupIndex(signals({ idAttr: "end-date-year-0" }))).toBe(0);
    expect(detectGroupIndex(signals({ idAttr: "company-name-0" }))).toBe(0);
    expect(detectGroupIndex(signals({ idAttr: "school--0" }))).toBe(0);
    expect(detectGroupIndex(signals({ idAttr: "title-1" }))).toBe(1);
  });

  it("does not mistake a long question id for a row index", () => {
    // "question_37728581002" ends in digits but is not a row.
    expect(detectGroupIndex(signals({ idAttr: "question_37728581002" }))).toBeNull();
  });

  it("resolves an employment start date once the row index is known", () => {
    const control: ResolveControl = { controlType: "combobox", groupIndex: 0 };
    expect(resolveProfileValue("experienceStartDate", profile, control, false)).toBe("2023-06");
  });

  it("gives a SECOND employment row that row's own dates, not the first job's", () => {
    // This is what the trailing-index fix actually buys. Row 0 mostly survived
    // the old regex by falling back to the first profile row; row 1 quietly
    // resolved to the first job's employer and dates, so a two-job history
    // submitted the same company twice with the wrong dates.
    const twoJobs = {
      ...profile,
      experience: [
        { title: "Software Engineer", company: "Tailrd", startDate: "2023-06", endDate: "", description: "" },
        { title: "Intern", company: "Shopify", startDate: "2022-05", endDate: "2022-08", description: "" },
      ],
    } as UserApplicationProfile;

    expect(detectGroupIndex(signals({ idAttr: "start-date-month-1" }))).toBe(1);

    const row1: ResolveControl = { controlType: "text", groupIndex: 1 };
    expect(resolveProfileValue("currentCompany", twoJobs, row1, false)).toBe("Shopify");
    expect(resolveProfileValue("experienceStartDate", twoJobs, row1, false)).toBe("2022-05");
    expect(resolveProfileValue("experienceEndDate", twoJobs, row1, false)).toBe("2022-08");

    // And the split-date adapter follows the row, not the first job.
    const el = document.createElement("input");
    el.id = "end-date-month-1";
    expect(greenhouseAdapter.resolveAnswer!({
      category: "experienceEndDate", profile: twoJobs,
      control: row1, fillEEO: false, el,
    })).toBe("August");
  });

  it("does not mark a past role as the current one", () => {
    const twoJobs = {
      ...profile,
      experience: [
        { title: "Software Engineer", company: "Tailrd", startDate: "2023-06", endDate: "", description: "" },
        { title: "Intern", company: "Shopify", startDate: "2022-05", endDate: "2022-08", description: "" },
      ],
    } as UserApplicationProfile;
    const row1: ResolveControl = { controlType: "checkbox", groupIndex: 1 };
    expect(resolveProfileValue("currentTitle", twoJobs, row1, false)).toBe("no");
  });

  it("splits the start date into the month name Greenhouse's month list uses", () => {
    const el = document.createElement("input");
    el.id = "start-date-month-0";
    const answer = greenhouseAdapter.resolveAnswer!({
      category: "experienceStartDate", profile,
      control: { controlType: "combobox", groupIndex: 0 }, fillEEO: false, el,
    });
    expect(answer).toBe("June");
  });

  it("splits the start date into a bare year for the year input", () => {
    const el = document.createElement("input");
    el.id = "start-date-year-0";
    const answer = greenhouseAdapter.resolveAnswer!({
      category: "experienceStartDate", profile,
      control: { controlType: "text", groupIndex: 0 }, fillEEO: false, el,
    });
    expect(answer).toBe("2023");
  });

  it("leaves the end date blank for a current role rather than inventing one", () => {
    const el = document.createElement("input");
    el.id = "end-date-month-0";
    const answer = greenhouseAdapter.resolveAnswer!({
      category: "experienceEndDate", profile,
      control: { controlType: "combobox", groupIndex: 0 }, fillEEO: false, el,
    });
    expect(answer ?? null).toBeNull();
  });

  it("checks the 'Current role' checkbox instead of typing a job title into it", () => {
    // id="current-role-0_1", type=checkbox. The profile's row 0 has no end
    // date, so this IS the current role.
    const control: ResolveControl = { controlType: "checkbox", groupIndex: 0 };
    expect(resolveProfileValue("currentTitle", profile, control, false)).toBe("yes");
  });

  it("still fills a text 'Title' field with the job title", () => {
    const control: ResolveControl = { controlType: "text", groupIndex: 0 };
    expect(resolveProfileValue("currentTitle", profile, control, false)).toBe("Software Engineer");
  });
});

// ---------------------------------------------------------------------------
// "It put University of Ottawa in and then removed it" (report #168)
// ---------------------------------------------------------------------------

describe("Lyft/Greenhouse: the Degree dropdown offers LEVELS, not titles", () => {
  // The real stored value for this user, from resume_profiles.
  const REAL_DEGREE = "Bachelor of Applied Science (Honours) in Software Engineering";

  it("reduces a full degree title to the level a dropdown actually lists", () => {
    expect(deriveDegreeLevel(REAL_DEGREE)).toBe("Bachelor");
  });

  it("snaps that level onto Greenhouse's option text", () => {
    // The whole point: "Bachelor" matches, the full title matches nothing, and
    // a no-match makes the combobox engine wipe what it typed.
    const options = ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree"];
    const snap = (v: string) => matchOption(options, (o) => o, (o) => o, v);
    expect(snap(deriveDegreeLevel(REAL_DEGREE)!)).toBe("Bachelor's Degree");
    expect(snap(REAL_DEGREE)).toBeNull(); // what we used to send
  });

  it("reads the level from the other common degree spellings", () => {
    expect(deriveDegreeLevel("BSc Computer Science")).toBe("Bachelor");
    expect(deriveDegreeLevel("M.Sc. in Statistics")).toBe("Master");
    expect(deriveDegreeLevel("Master of Business Administration")).toBe("MBA");
    expect(deriveDegreeLevel("Ph.D. in Physics")).toBe("Doctorate");
    expect(deriveDegreeLevel("Associate's Degree")).toBe("Associate");
  });

  it("abstains rather than bucketing something it does not recognize", () => {
    expect(deriveDegreeLevel("Licence professionnelle")).toBeNull();
    expect(deriveDegreeLevel("")).toBeNull();
  });

  it("sends the level to a dropdown and the full title to a text field", () => {
    const p = {
      ...profile,
      education: [{ degree: REAL_DEGREE, school: "University of Ottawa", graduationYear: "2028" }],
    } as UserApplicationProfile;
    expect(resolveProfileValue("degree", p, { controlType: "combobox" }, false)).toBe("Bachelor");
    expect(resolveProfileValue("degree", p, { controlType: "text" }, false)).toBe(REAL_DEGREE);
  });

  it("keeps an unrecognized degree verbatim even on a dropdown", () => {
    const p = {
      ...profile,
      education: [{ degree: "Licence professionnelle", school: "X", graduationYear: "" }],
    } as UserApplicationProfile;
    expect(resolveProfileValue("degree", p, { controlType: "combobox" }, false)).toBe(
      "Licence professionnelle"
    );
  });
});

// ---------------------------------------------------------------------------
// The multiplier: an AI outage must not blank fields we already know
// ---------------------------------------------------------------------------

describe("Lyft/Greenhouse: known answers recover without the backend", () => {
  function field(over: Partial<DetectedField>): DetectedField {
    return {
      id: "f1", category: "unknown", confidence: 0.9, label: "Q",
      controlType: "combobox", required: false, proposedValue: null,
      fillable: true, sensitive: false, ...over,
    };
  }
  // The same matcher the write engine uses, injected so the planner stays pure.
  const snap = (options: string[], value: string) =>
    matchOption(options, (o) => o, (o) => o, value);

  it("snaps a stated profile answer to a harvested option on device", () => {
    // Work Authorization, School and Degree each had a profile answer and each
    // submitted BLANK on the real form: their fills missed, and the only
    // recovery path ran through a backend that was returning 429.
    const fields = [
      field({ id: "auth", category: "workAuthorization", proposedValue: "Yes" }),
      field({ id: "school", category: "school", proposedValue: "University of Toronto" }),
    ];
    const { targets, remaining } = planOnDeviceReask(fields, [
      { fieldId: "auth", options: ["Yes", "No"] },
      { fieldId: "school", options: ["University of Waterloo", "University of Toronto"] },
    ], snap);
    expect(targets).toEqual([
      { fieldId: "auth", value: "Yes" },
      { fieldId: "school", value: "University of Toronto" },
    ]);
    expect(remaining).toEqual([]);
  });

  it("leaves a genuine question for the backend", () => {
    // No profile value: this one really is a question, and guessing it on
    // device would be exactly the invention the grounding contract forbids.
    const fields = [field({ id: "q", label: "Why do you want to work at Lyft?" })];
    const candidates = [{ fieldId: "q", options: ["A", "B"] }];
    const { targets, remaining } = planOnDeviceReask(fields, candidates, snap);
    expect(targets).toEqual([]);
    expect(remaining).toEqual(candidates);
  });

  it("leaves a stated value that matches no option for the backend", () => {
    // "Authorized to work in Canada" against citizenship options: the backend
    // is option-aware and can map it; writing it raw would fail.
    const fields = [field({ id: "auth", proposedValue: "Authorized to work in Canada" })];
    const candidates = [{ fieldId: "auth", options: ["Canadian Citizen", "Permanent Resident"] }];
    const { targets, remaining } = planOnDeviceReask(fields, candidates, snap);
    expect(targets).toEqual([]);
    expect(remaining).toEqual(candidates);
  });
});
