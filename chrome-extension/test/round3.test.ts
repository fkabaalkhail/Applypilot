/**
 * Round 3 (2026-10-03, evening): new ATS families (JazzHR, Breezy, Recruitee,
 * Pinpoint, Paylocity, ADP, iCIMS, Oracle) and five new personas. Each test is
 * a write a live page got wrong, or a blank a stated fact answers; labels and
 * options are verbatim from the live pages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileFacts } from "../src/content/profileFacts";
import { resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import { scanPage } from "../src/content/formScanner";
import type { AnswerKind } from "../src/content/answerKind";
import type { ControlType, UserApplicationProfile } from "../src/shared/types";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";
import { stubLayout } from "./helpers/layout";

const YES_NO = ["Yes", "No"];

/** A career changer: six years teaching, then software since 2024. */
const CHANGER: UserApplicationProfile = {
  ...SPARSE_CANADIAN,
  location: "Montréal, QC",
  country: "Canada",
  skills: ["TypeScript", "React", "Node.js"],
  experience: [
    { company: "Commission scolaire de Montréal", title: "Teacher", startDate: "2017-08", endDate: "2023-06", description: "" },
    { company: "Lightspeed Commerce", title: "Junior Software Developer", startDate: "2024-02", endDate: "Present", description: "" },
  ],
};

function ask(
  label: string,
  opts: { options?: string[]; controlType?: ControlType; kind?: AnswerKind } = {},
  profile: UserApplicationProfile = SPARSE_CANADIAN,
  ctx: { jobCountry: string | null; company: string; jobCity?: string | null } = { jobCountry: "US", company: "" }
) {
  const q: QuestionInput = {
    label,
    controlType: opts.controlType ?? (opts.options ? "radioGroup" : "text"),
    options: opts.options,
    category: "unknown",
    kind: opts.kind ?? (opts.options ? (opts.options.length === 2 && opts.options[0] === "Yes" ? "boolean" : "choice") : "text"),
  };
  return resolveQuestion(q, profileFacts(profile, TEST_TODAY), profile, ctx);
}
const value = (r: ReturnType<typeof ask>) => (r && r.status === "answer" ? r.value : r?.status ?? null);

describe("experience narrowed to a skill, however it is phrased (Vagaro on Breezy)", () => {
  const VAGARO = ["No Experience / Experience with other but no C# / ASP.NET Core", "Less than 1 year", "1-2 years", "3+ years"];
  it("'years … developing applications using C# and ASP.NET Core' is not the career total", () => {
    const q = "How many years of hands-on experience do you have developing applications using C# and ASP.NET Core?* A response is required";
    expect(value(ask(q, { options: VAGARO }, CHANGER))).not.toBe("3+ years");
  });
  it("a plain career-total question still gets the total", () => {
    expect(value(ask("How many years of professional experience do you have?", { options: ["0-1", "1-3", "3-5", "5+"] }, CHANGER))).toBe("5+");
  });
});

describe("race asked together with Hispanic origin (EEO-1 combined list; Vagaro on Breezy)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const VAGARO = ["White (not Hispanic or Latino)", "Black or African-American (not Hispanic or Latino)", "Asian (not Hispanic or Latino)", "American Indian or Alaskan Native (not Hispanic or Latino)", "Native Hawaiian or other Pacific islander (not Hispanic or Latino)", "Two or more races/ethnicities (not Hispanic or Latino)", "Hispanic or Latino (including Black individuals whose origins are Hispanic)", "I don't wish to answer"];
  const propose = (eeo: Record<string, string>) => {
    document.body.innerHTML = `<form><fieldset><legend>Race or Ethnicity</legend>${VAGARO.map((o, i) => `<label><input type="radio" name="race_ethnicity" value="${i}">${o}</label>`).join("")}</fieldset></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN, eeo }, false, null).fields;
    expect(f[0].category).toBe("eeoRace");
    return f[0].proposedValue ?? null;
  };
  it("a Hispanic applicant gets the Hispanic or Latino option, never a '(not Hispanic or Latino)' one", () => {
    expect(propose({ race: "Two or More Races", hispanicLatino: "Yes" })).toBe("Hispanic or Latino (including Black individuals whose origins are Hispanic)");
    expect(propose({ race: "White", hispanicLatino: "Yes" })).toBe("Hispanic or Latino (including Black individuals whose origins are Hispanic)");
  });
  it("a non-Hispanic applicant keeps their race option", () => {
    expect(propose({ race: "Two or More Races", hispanicLatino: "No" })).toBe("Two or more races/ethnicities (not Hispanic or Latino)");
    expect(propose({ race: "Asian", hispanicLatino: "No" })).toBe("Asian (not Hispanic or Latino)");
  });
});

describe("graduation asked by month and year (NinjaHoldings on Breezy)", () => {
  const Q = "What is your expected month and year of graduation?*A response is required";
  const STUDENT: UserApplicationProfile = {
    ...SPARSE_CANADIAN,
    expectedGraduation: "2027-12",
    education: [{ school: "San José State University", degree: "Bachelor of Science in Software Engineering", graduationYear: "2027" }],
  };
  it("the month and the year, not the year alone", () => {
    expect(value(ask(Q, {}, STUDENT))).toBe("December 2027");
  });
  it("a year-only profile leaves a month question to the applicant", () => {
    expect(value(ask(Q, {}, { ...STUDENT, expectedGraduation: "" }))).not.toBe("2027");
  });
});

describe("a fact asked together with an essay (NinjaHoldings on Breezy)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("'What is your major? Please describe why…' in a long-text box is not answered with the major alone", () => {
    document.body.innerHTML = `<form><label for="m">What is your major? Please describe why you feel it is applicable to our summer internship.*</label><textarea id="m"></textarea></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN }, false, null).fields;
    expect(f[0].proposedValue ?? null).toBeNull();
  });
  it("a plain 'What is your major?' box still gets the major", () => {
    document.body.innerHTML = `<form><label for="m">What is your major?</label><input id="m" type="text"></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN }, false, null).fields;
    expect(f[0].proposedValue).toBe("Mechatronics Engineering");
  });
});

describe("options with no <label>: the text beside the box (Vagaro on Breezy)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("a checkbox list reads 'C#', 'ASP.NET Core', … not 'on'", () => {
    const opts = ["C#", "ASP.NET Core", "RESTful APIs", "None of the above"];
    document.body.innerHTML = `<form><div class="multiplechoice"><h3>Which of the following have you worked with in a professional, internship, or project environment?<span class="required">*</span></h3><ul class="options">${opts
      .map((o) => `<li class="option"><input type="checkbox" name="section_1786658626286_question_6" required="required"><span class="ng-binding">${o}</span></li>`)
      .join("")}</ul></div></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN }, false, null).fields;
    expect(f).toHaveLength(1);
    expect(f[0].options).toEqual(opts);
  });
});

describe("Paylocity (ATB Technologies, live 2026-10-03)", () => {
  const SOURCES = ["Online Job Board", "Company Website", "Friend or Family Member", "Current Employee", "Other"];
  const Q = "How did you hear about us?(optional)";
  it("a stated channel the list does not offer is 'Other', not the default job board", () => {
    expect(value(ask(Q, { options: SOURCES }, { ...SPARSE_CANADIAN, howDidYouHear: "Career fair" }))).toBe("Other");
  });
  it("a job site the list does not name is still a job board; no stated channel takes the default", () => {
    expect(value(ask(Q, { options: SOURCES }, { ...SPARSE_CANADIAN, howDidYouHear: "LinkedIn" }))).toBe("Online Job Board");
    expect(value(ask(Q, { options: SOURCES }, { ...SPARSE_CANADIAN, howDidYouHear: "" }))).toBe("Online Job Board");
  });
  it("'Did you Graduate?' follows the education the profile has in progress", () => {
    expect(value(ask("Did you Graduate?", { options: YES_NO }, { ...SPARSE_CANADIAN, expectedGraduation: "2027-12" }))).toBe("No");
    const done = { ...SPARSE_CANADIAN, education: [{ school: "University of Waterloo", degree: "Bachelor of Applied Science", graduationYear: "2024" }] };
    expect(value(ask("Did you Graduate?", { options: YES_NO }, done))).toBe("Yes");
  });
});

describe("an education row's city is the school's, not the applicant's (Paylocity)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("educationHistory.city.0 stays blank; the applicant's own City still fills", () => {
    const p = { ...SPARSE_CANADIAN, location: "Gatineau, QC, Canada", addressCity: "Gatineau" };
    document.body.innerHTML = `<form>
      <div class="form-group"><label for="info.city">City</label><input id="info.city" type="text"></div>
      <div class="form-group"><label for="educationHistory.name.0">School Name (required)</label><input id="educationHistory.name.0" type="text"></div>
      <div class="form-group"><label for="educationHistory.city.0">City</label><input id="educationHistory.city.0" type="text"></div>
    </form>`;
    const f = scanPage(p, false, null).fields;
    const cities = f.filter((x) => x.label === "City");
    expect(cities.map((x) => x.proposedValue ?? null)).toEqual(["Gatineau", null]);
  });
});

describe("a decline the PAGE pre-selects is no answer (JazzHR's EEO selects)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  // Verbatim markup: the decline option ships `selected`.
  const JAZZ = `<form>
    <div class="form-group"><div class="resumator-input" id="resumator-eeo_gender-field"><label for="resumator-eeo_gender-value">Gender<select id="resumator-eeo_gender-value" name="resumator-eeo_gender-value" class="form-control"><option value="0" selected="">Decline to answer</option><option value="1">Female</option><option value="2">Male</option></select></label></div></div>
    <div class="form-group"><label for="country">Country<select id="country" name="country"><option value="CA" selected="">Canada</option><option value="US">United States</option></select></label></div>
  </form>`;
  it("the applicant's stated answer replaces the page's default decline", () => {
    document.body.innerHTML = JAZZ;
    const f = scanPage({ ...SPARSE_CANADIAN, eeo: { gender: "Male" } }, true, null).fields;
    const gender = f.find((x) => x.category === "eeoGender")!;
    expect(gender.currentValue).toBeUndefined();
    expect(gender.proposedValue).toBe("Male");
  });
  it("any other pre-selected option still counts as filled (never overwritten)", () => {
    document.body.innerHTML = JAZZ;
    const f = scanPage({ ...SPARSE_CANADIAN, country: "United States" }, true, null).fields;
    expect(f.find((x) => x.category === "country")?.currentValue).toBe("Canada");
  });
});

describe("start availability asked as 'how soon are you able to start?' (Kaizen on JazzHR)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("is the earliest start date", () => {
    document.body.innerHTML = `<form><label for="s">If chosen for the role, how soon are you able to start?*</label><input id="s" type="text"></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN, earliestStartDate: "2027-05-24" }, false, null).fields;
    expect(f[0].category).toBe("startDate");
    expect(f[0].proposedValue).toMatch(/2027/);
  });
});

describe("a long option list is read whole (Kenect on Breezy: 50 states as radios)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
  it("'What state do you live in?' finds Texas, the 43rd option", () => {
    document.body.innerHTML = `<form><fieldset><legend>What state do you live in?* A response is required</legend>${STATES.map((s, i) => `<label><input type="radio" name="st" value="${i}">${s}</label>`).join("")}</fieldset></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN, location: "Austin, TX", addressCity: "Austin", addressState: "TX", country: "United States" }, false, null).fields;
    expect(f[0].options).toHaveLength(50);
    expect(f[0].proposedValue).toBe("Texas");
  });
});

describe("Kenect on Breezy: questions a stated fact answers", () => {
  const AUSTIN: UserApplicationProfile = {
    ...SPARSE_CANADIAN,
    location: "Austin, TX",
    addressCity: "Austin",
    addressState: "TX",
    country: "United States",
    willingToRelocate: "No",
    howDidYouHear: "Company website",
    earliestStartDate: "2026-10-26",
  };
  it("'How did you hear about this position? If referred, by who?' is the channel question", () => {
    expect(value(ask("How did you hear about this position? If referred, by who?*A response is required", {}, AUSTIN))).toBe("Company website");
  });
  it("a follow-up that STARTS with 'if' is still not the channel question", () => {
    expect(value(ask("If you heard about us through a referral, please state the employee's name", {}, AUSTIN))).not.toBe("Company website");
  });
  it("'When are you available for employment?' is the start date", () => {
    expect(value(ask("When are you available for employment?*A response is required", {}, AUSTIN))).toMatch(/2026/);
  });
  it("'able to work a Hybrid schedule out of Pleasant Grove, Utah?': No for an Austin applicant who will not relocate", () => {
    const q = "Are you able to work a Hybrid schedule out of Pleasant Grove, Utah?* A response is required";
    expect(value(ask(q, { options: YES_NO }, AUSTIN, { jobCountry: "US", company: "", jobCity: "Pleasant Grove" }))).toBe("No");
    expect(value(ask(q, { options: YES_NO }, { ...AUSTIN, willingToRelocate: "Yes" }, { jobCountry: "US", company: "", jobCity: "Pleasant Grove" }))).toBe("Yes");
    const local = { ...AUSTIN, location: "Pleasant Grove, UT", addressCity: "Pleasant Grove", addressState: "UT" };
    expect(value(ask(q, { options: YES_NO }, local, { jobCountry: "US", company: "", jobCity: "Pleasant Grove" }))).toBe("Yes");
  });
});

describe("'Are you a current MongoDB employee?' (MongoDB's embedded Greenhouse form)", () => {
  it("names the company after a qualifier: No for an applicant employed elsewhere", () => {
    const p = { ...SPARSE_CANADIAN, currentCompany: "Dell Technologies", experience: [{ company: "Dell Technologies", title: "Software Engineer II", startDate: "Jan 2023", endDate: "Present", description: "" }] };
    expect(value(ask("Are you a current MongoDB employee?", { options: YES_NO }, p))).toBe("No");
    expect(value(ask("Are you a current Dell Technologies employee?", { options: YES_NO }, p))).toBe("Yes");
  });
});

describe("a city typeahead filled by the page-world driver picks the PLACE (Zipline's embedded Greenhouse form)", () => {
  it("'San Jose' in California is never 'San José, Costa Rica'", async () => {
    const { pickOption } = await import("../src/content/mainWorldDriver");
    const suggestions = ["San José, Costa Rica", "San Jose, California, United States", "San Jose, Batangas, Philippines"];
    expect(pickOption(suggestions, "San Jose", "San Jose, CA, United States")).toBe(1);
    // A place hint that matches no suggestion picks none (never the nearest name).
    expect(pickOption(["San José, Costa Rica"], "San Jose", "San Jose, CA, United States")).toBe(-1);
    // Options that are not places keep the ordinary matcher.
    expect(pickOption(["Yes", "No"], "Yes", "San Jose, CA, United States")).toBe(0);
  });
});

describe("batch B: availability over a stated period, a lone-Yes consent, no history", () => {
  const MEI = { ...SPARSE_CANADIAN, earliestStartDate: "2027-05-24", willingToRelocate: "Yes" };
  it("'available for … next Spring (January 2027 - April/May 2027)?' is No when the earliest start is late May (Zipline)", () => {
    const q = "Are you available for a full-time onsite internship next Spring (January 2027 - April/May 2027)?*";
    expect(value(ask(q, { options: YES_NO }, MEI))).toBe("No");
    expect(value(ask(q, { options: YES_NO }, { ...MEI, earliestStartDate: "2026-12-14" }))).toBe("Yes");
  });
  it("'Have you read and agree to the below Disclaimer and Consent?' with a lone 'Yes' is Yes (D2L)", () => {
    expect(value(ask("Have you read and agree to the below Disclaimer and Consent?*", { options: ["Yes"] }))).toBe("Yes");
  });
  it("'previously worked for D2L?' is No for an applicant with no work history at all (D2L)", () => {
    const fresh = { ...SPARSE_CANADIAN, experience: [] };
    const q = "Have you previously worked for D2L in any capacity? If yes, please select the most recent type that applies.*";
    expect(value(ask(q, { options: ["No", "Yes - Full time", "Yes - Co-op/Intern"] }, fresh))).toBe("No");
  });
});

describe("a phone widget that keeps the country code apart (Workable, live 2026-10-03)", () => {
  it("'+44 20 7946 0958' shown as '20 7946 0958' was written, not 'did not stick'", async () => {
    const { verifyControl } = await import("../src/content/writeEngine");
    const el = document.createElement("input");
    el.type = "tel";
    document.body.append(el);
    const control = { id: "p", controlType: "text" as const, el };
    el.value = "20 7946 0958";
    expect(verifyControl(control, "+44 20 7946 0958")).toBe(true);
    el.value = "408-555-0172";
    expect(verifyControl(control, "+1 408-555-0172")).toBe(true);
    // A fragment is not the number.
    el.value = "555-0172";
    expect(verifyControl(control, "+1 408-555-0172")).toBe(false);
    el.remove();
  });
});
