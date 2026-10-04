/**
 * Round 3 (2026-10-03, evening): new ATS families (JazzHR, Breezy, Recruitee,
 * Pinpoint, Paylocity, ADP, iCIMS, Oracle) and five new personas. Each test is
 * a write a live page got wrong, or a blank a stated fact answers; labels and
 * options are verbatim from the live pages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { degreeRank, profileFacts } from "../src/content/profileFacts";
import { classifyField, deriveFieldOfStudy, resolveProfileValue } from "../src/content/fieldMatcher";
import type { FieldSignals } from "../src/content/domUtils";
import { resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import { scanPage } from "../src/content/formScanner";
import { matchOption } from "../src/content/writeEngine";
import { looksLikePlaces } from "../src/content/placeMatch";
import { pickOption } from "../src/content/mainWorldDriver";
import { fillAriaCombobox, readComboboxValue } from "../src/content/comboboxEngine";
import { snapToOption } from "../src/content/fieldResolver";
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

describe("a salary's currency and pay period, each its own select (Breezy)", () => {
  const CURRENCIES = ["US Dollar ($)", "Canadian Dollar ($)", "Euro (€)", "Australian Dollar ($)", "British Pound Sterling (£)", "Indian Rupee (₹)", "Japanese Yen (￥)"];
  const PERIODS = ["Hourly", "Weekly", "Monthly", "Yearly"];
  const Q = "Desired Salary*";
  const sel = (options: string[]) => ({ options, controlType: "select" as const, kind: "choice" as const });
  const who = (salaryExpectation: string, country: string) => ({ ...SPARSE_CANADIAN, salaryExpectation, country, location: "" });
  it("the currency the applicant states, '$' read by their country", () => {
    expect(value(ask(Q, sel(CURRENCIES), who("$135,000", "United States")))).toBe("US Dollar ($)");
    expect(value(ask(Q, sel(CURRENCIES), who("75 000 $", "Canada")))).toBe("Canadian Dollar ($)");
    expect(value(ask(Q, sel(CURRENCIES), who("£95,000", "United Kingdom")))).toBe("British Pound Sterling (£)");
  });
  it("the period it is stated per: an hourly rate is Hourly, an annual figure Yearly", () => {
    expect(value(ask(Q, sel(PERIODS), who("$45/hour", "United States")))).toBe("Hourly");
    expect(value(ask(Q, sel(PERIODS), who("$135,000", "United States")))).toBe("Yearly");
    // A bare small number says neither.
    expect(value(ask(Q, sel(PERIODS), who("45", "United States")))).not.toBe("Yearly");
  });
});

describe("a student's questions asked of a graduate (Superhuman on Ashby, batch C)", () => {
  const GRADUATE: UserApplicationProfile = {
    ...CHANGER,
    expectedGraduation: undefined,
    education: [
      { school: "Université de Montréal", degree: "Baccalauréat en psychologie", graduationYear: "2017" },
      { school: "Concordia University", degree: "Certificate in Computer Science", graduationYear: "2023" },
    ],
  };
  const GRAD_DATES = ["2026", "January - June 2027", "December 2027", "May/June 2028", "December 2028", "2029"];
  const PURSUING = ["Bachelors", "Masters", "PhD"];

  it("'When is your expected graduation date?': a graduate has none, and the AI is not asked to invent one", () => {
    const r = ask("When is your expected graduation date?", { options: GRAD_DATES }, GRADUATE);
    expect(r?.status).toBe("abstain");
    expect(r && r.status === "abstain" && r.blockBackend).toBe(true);
  });

  it("a graduate whose year IS offered still gets it", () => {
    const r = ask("When is your expected graduation date?", { options: ["2022", "2023", "2024"] }, GRADUATE);
    expect(value(r)).toBe("2023");
  });

  it("'Which degree are you currently pursuing?': the degree in progress", () => {
    expect(value(ask("Which degree are you currently pursuing?", { options: PURSUING }))).toBe("Bachelors");
  });

  it("'Which degree are you currently pursuing?': a graduate pursues none, and the AI is not asked", () => {
    const r = ask("Which degree are you currently pursuing?", { options: PURSUING }, GRADUATE);
    expect(r?.status).toBe("abstain");
    expect(r && r.status === "abstain" && r.blockBackend).toBe(true);
  });

  it("a graduate takes the list's own 'not a student' option when it has one", () => {
    expect(value(ask("What degree are you currently pursuing?", { options: [...PURSUING, "Not currently pursuing a degree"] }, GRADUATE))).toBe(
      "Not currently pursuing a degree"
    );
  });

  it("a degree in progress the list does not rank stays the applicant's", () => {
    const certificate = { ...GRADUATE, education: [{ school: "Concordia University", degree: "Certificate in Computer Science", graduationYear: "2027" }] };
    expect(ask("Which degree are you currently pursuing?", { options: PURSUING }, certificate)?.status).toBe("abstain");
  });
});

describe("a profile link without a scheme, into a URL input (Superhuman on Ashby, batch C)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const scanLink = (type: string) => {
    document.body.innerHTML = `<form><label for="li">LinkedIn</label><input id="li" type="${type}"></form>`;
    return scanPage({ ...SPARSE_CANADIAN, linkedin: "linkedin.com/in/alexcote" }, false).fields[0];
  };
  it("a type=url input takes it with https:// (the page rejects a URL without a scheme)", () => {
    expect(scanLink("url").proposedValue).toBe("https://linkedin.com/in/alexcote");
  });
  it("a text input takes it as written", () => {
    expect(scanLink("text").proposedValue).toBe("linkedin.com/in/alexcote");
  });
});

describe("French degree names (a Montreal applicant; Superhuman on Ashby, batch C)", () => {
  it("Quebec's university degrees are ranked", () => {
    expect(degreeRank("Baccalauréat en psychologie")).toBe(4);
    expect(degreeRank("Baccalauréat ès sciences en informatique")).toBe(4);
    expect(degreeRank("Maîtrise en informatique")).toBe(5);
    expect(degreeRank("Doctorat en chimie")).toBe(6);
    expect(degreeRank("Certificat en administration")).toBe(2);
  });
  it("France's baccalauréat is a high-school diploma, not a bachelor's: unranked", () => {
    expect(degreeRank("Baccalauréat scientifique")).toBeNull();
  });
  it("the field of study follows 'en'", () => {
    expect(deriveFieldOfStudy("Baccalauréat en psychologie")).toBe("Psychologie");
    expect(deriveFieldOfStudy("Maîtrise ès sciences en génie logiciel")).toBe("Génie logiciel");
    expect(deriveFieldOfStudy("Certificat en administration des affaires")).toBe("Administration des affaires");
  });
});

describe("permanent residency taken after the latest citizenship (Amazon's export questions; Twitch, batch C)", () => {
  const Q =
    "Since obtaining your most recent citizenship, did you afterwards become a permanent resident in any other country/region? This does not include temporary statuses such as student visas or time-limited work permits.*";
  const US_CITIZEN: UserApplicationProfile = { ...SPARSE_CANADIAN, location: "Austin, TX", country: "United States", workAuthorization: "U.S. citizen" };
  const GREEN_CARD: UserApplicationProfile = { ...SPARSE_CANADIAN, location: "San Jose, CA", country: "USA", workAuthorization: "U.S. permanent resident (green card)" };

  it("a citizen living in their own country: No, before and after the options load (it was answered 'United States')", () => {
    expect(value(ask(Q, { controlType: "combobox", kind: "choice" }, US_CITIZEN))).toBe("No");
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, US_CITIZEN))).toBe("No");
  });
  it("a green-card holder became a permanent resident of a country not theirs: Yes", () => {
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, GREEN_CARD))).toBe("Yes");
  });
  it("no stated status: left to the applicant", () => {
    const unknown = { ...US_CITIZEN, workAuthorization: "" };
    expect(ask(Q, { options: YES_NO, controlType: "combobox" }, unknown)?.status).toBe("abstain");
  });
});

describe("work authorization offered as statements (SpaceX on Greenhouse, batch C)", () => {
  const Q = "Are you legally authorized to work in the United States?*";
  const SPACEX = [
    "I am authorized to work in the United States for any employer",
    "I am authorized to work in the United States for my present employer only",
    "I require sponsorship to work in the United States",
    "I am not authorized to work in the United States",
    "My status to work in the United States is unknown",
  ];
  const at = (profile: UserApplicationProfile) => value(ask(Q, { options: SPACEX, controlType: "combobox", kind: "choice" }, profile, { jobCountry: "US", company: "SpaceX" }));
  const base = { ...SPARSE_CANADIAN, location: "San Jose, CA", country: "USA" };

  it("a green-card holder who needs no sponsorship: authorized for any employer (it went to the AI)", () => {
    expect(at({ ...base, workAuthorization: "U.S. permanent resident (green card)", requiresSponsorship: "No" })).toBe(SPACEX[0]);
  });
  it("a citizen: authorized for any employer", () => {
    expect(at({ ...base, workAuthorization: "U.S. citizen" })).toBe(SPACEX[0]);
  });
  it("a student who will need sponsorship: requires sponsorship", () => {
    expect(at({ ...base, workAuthorization: "F-1 student visa", requiresSponsorship: "Yes" })).toBe(SPACEX[2]);
  });
  it("a Canadian in Toronto, not authorized in the US: not authorized", () => {
    expect(at({ ...SPARSE_CANADIAN, authorizedUS: "No" })).toBe(SPACEX[3]);
  });
});

describe("a major the list lacks, among technical and non-technical 'Other's (SpaceX on Greenhouse, batch C)", () => {
  // SpaceX's Discipline list, verbatim (live 2026-10-03).
  const SPACEX = [
    "Aerospace and Mechanical Engineering", "Aerospace Engineering", "Astronautical Engineering", "Business Administration", "Chemical Engineering",
    "Chemistry", "Civil Engineering", "Communications", "Computer Engineering", "Computer Information Systems", "Computer Science",
    "Electrical and Computer Engineering", "Electrical Engineering", "Engineering (General)", "Environmental Science / Engineering", "Finance",
    "Industrial Engineering", "Information Technology", "International Affairs", "Management", "Manufacturing Engineering", "Marketing",
    "Materials Science / Engineering", "Mathematics", "Mechanical Engineering", "Mechatronics Engineering", "Metallurgical Engineering",
    "Not Applicable", "Other", "Other (Non-Technical)", "Other (Technical)", "Physics", "Political Science",
    "Supply Chain / Logistics / Operations", "Welding Engineering",
  ];
  it("Software Engineering is Other (Technical), not a sibling engineering", () => {
    expect(snapToOption(SPACEX, "Software Engineering", "fieldOfStudy")).toBe("Other (Technical)");
  });
  it("Psychology is Other (Non-Technical)", () => {
    expect(snapToOption(SPACEX, "Psychologie", "fieldOfStudy")).toBe("Other (Non-Technical)");
    expect(snapToOption(SPACEX, "Psychology", "fieldOfStudy")).toBe("Other (Non-Technical)");
  });
  it("a major the list has is itself", () => {
    expect(snapToOption(SPACEX, "Computer Science", "fieldOfStudy")).toBe("Computer Science");
    expect(snapToOption(SPACEX, "Mechatronics Engineering", "fieldOfStudy")).toBe("Mechatronics Engineering");
  });
});

describe("'Citizenship Status' is a status, answered once its options load (SpaceX on Greenhouse, batch C)", () => {
  const STATUS = [
    "(a) U.S. citizen or national of the United States",
    "(b) U.S. lawful permanent resident",
    "(c) Refugee under 8 U.S.C. 1157",
    "(d) Asylee under 8 U.S.C. 1158",
    "(e) Authorized to work in the United States under the Deferred Action for Childhood Arrivals (DACA) program",
    "(f) Other (please explain)",
  ];
  const base = { ...SPARSE_CANADIAN, location: "San Jose, CA", country: "USA" };
  const GREEN_CARD = { ...base, workAuthorization: "U.S. permanent resident (green card)", requiresSponsorship: "No" };
  const ctx = { jobCountry: "US", company: "SpaceX" };

  it("before the options load it is not settled (it was blocked for good as an unknown country)", () => {
    const r = ask("Citizenship Status*", { controlType: "combobox", kind: "choice" }, GREEN_CARD, ctx);
    expect(r === null || r.status !== "abstain" || r.blockBackend !== true).toBe(true);
  });
  it("a green-card holder: (b) lawful permanent resident", () => {
    expect(value(ask("Citizenship Status*", { options: STATUS, controlType: "combobox" }, GREEN_CARD, ctx))).toBe(STATUS[1]);
  });
  it("a citizen: (a)", () => {
    expect(value(ask("Citizenship Status*", { options: STATUS, controlType: "combobox" }, { ...base, workAuthorization: "U.S. citizen" }, ctx))).toBe(STATUS[0]);
  });
});

describe("the 'type relocating' instruction, for an applicant who will not move (Anthropic on Greenhouse, batch C)", () => {
  const Q = 'What is the address from which you plan on working? If you would need to relocate, please type "relocating".';
  const AUSTIN: UserApplicationProfile = {
    ...SPARSE_CANADIAN, location: "Austin, TX", addressStreet: "4120 Duval St", addressCity: "Austin", addressState: "TX", postalCode: "78751",
    country: "United States", willingToRelocate: "No",
  };
  it("not moving: they work from where they live, so their address, never 'relocating' and never blank", () => {
    const r = ask(Q, { controlType: "text", kind: "text" }, AUSTIN, { jobCountry: "US", company: "Anthropic", jobCity: "San Francisco" });
    expect(r?.status === "abstain").toBe(false);
    expect(value(r)).not.toBe("relocating");
  });
});

describe("'in-person in one of our offices', the offices being the posting's places (Anthropic on Greenhouse, batch C)", () => {
  const Q = "Are you open to working in-person in one of our offices 25% of the time?*";
  const OFFICES = { jobCountry: "US", company: "Anthropic", jobPlaces: ["San Francisco, CA", "New York City, NY", "Washington, DC"] };
  const notMoving = (location: string): UserApplicationProfile => ({ ...SPARSE_CANADIAN, location, country: "United States", willingToRelocate: "No" });

  it("every office in another state, for an applicant who will not move: No (it went to the AI)", () => {
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, notMoving("Austin, TX"), OFFICES))).toBe("No");
  });
  it("an office in their own city: Yes", () => {
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, notMoving("New York City, NY"), OFFICES))).toBe("Yes");
  });
  it("an office elsewhere in their own state: theirs to judge", () => {
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, notMoving("San Jose, CA"), OFFICES))).not.toBe("No");
    expect(value(ask(Q, { options: YES_NO, controlType: "combobox" }, notMoving("San Jose, CA"), OFFICES))).not.toBe("Yes");
  });
});

describe("a government employer in the history leaves government questions to the applicant, not the AI (ActioNet on Jobvite, batch C)", () => {
  const ARMY: UserApplicationProfile = {
    ...CHANGER,
    experience: [
      { company: "U.S. Army", title: "Signal Support Systems Specialist", startDate: "Jun 2012", endDate: "May 2016", description: "" },
      { company: "Dell Technologies", title: "Software Engineer II", startDate: "Jan 2023", endDate: "Present", description: "" },
    ],
  };
  const MAIN = "Are you a current or former government employee?*";
  const FOLLOW = "If you are a current or former government employee, are you currently or were you ever previously involved in any ActioNet contracts or programs?*";
  const FOLLOW_OPTS = ["Select an option...", "Yes", "No", "I am not a current or former government employee"];
  const blocked = (r: ReturnType<typeof ask>) => r?.status === "abstain" && r.blockBackend === true;

  it("served in the Army: whether that is a 'government employee' is theirs to say (it went to the AI)", () => {
    expect(blocked(ask(MAIN, { options: ["Select an option...", "Yes", "No"], controlType: "select", kind: "boolean" }, ARMY))).toBe(true);
  });
  it("its follow-up waits on it, also kept from the AI", () => {
    expect(blocked(ask(FOLLOW, { options: FOLLOW_OPTS, controlType: "select", kind: "choice" }, ARMY))).toBe(true);
  });
  it("no government in the history: No, and the follow-up does not apply", () => {
    expect(value(ask(MAIN, { options: ["Select an option...", "Yes", "No"], controlType: "select", kind: "boolean" }, CHANGER))).toBe("No");
    expect(value(ask(FOLLOW, { options: FOLLOW_OPTS, controlType: "select", kind: "choice" }, CHANGER))).toBe(FOLLOW_OPTS[3]);
  });
});

describe("'Clearance Type' from a stated clearance (ActioNet on Jobvite, batch C)", () => {
  const TYPES = [
    "Select an option...", "None", "Public Trust", "Interim Secret Clearance", "Secret Clearance", "Interim Top Secret Clearance", "Top Secret Clearance",
    "Top Secret Full Scope Polygraph Clearance", "Top Secret/ SCI Clearance", "DOE Badge Access Only", "DOE L Clearance", "DOE Q Clearance",
  ];
  const US = { ...CHANGER, location: "Austin, TX", country: "United States" };
  const type = (securityClearance: string) => ask("Clearance Type", { options: TYPES, controlType: "select", kind: "choice" }, { ...US, securityClearance });
  it("a level the profile names is that option, exactly", () => {
    expect(value(type("Active Secret clearance"))).toBe("Secret Clearance");
    expect(value(type("Top Secret"))).toBe("Top Secret Clearance");
    expect(value(type("None"))).toBe("None");
  });
  it("'Active clearance' names no level: the applicant's, kept from the AI (it went to the AI)", () => {
    const r = type("Active clearance");
    expect(r?.status).toBe("abstain");
    expect(r && r.status === "abstain" && r.blockBackend).toBe(true);
  });
});

describe("Palantir on Lever, answered by a London senior engineer (batch C)", () => {
  const LONDON: UserApplicationProfile = {
    ...SPARSE_CANADIAN,
    location: "London, United Kingdom",
    country: "United Kingdom",
    expectedGraduation: undefined,
    education: [
      { school: "Imperial College London", degree: "Master of Science in Computing", graduationYear: "2016" },
      { school: "Trinity College Dublin", degree: "Bachelor of Arts in Computer Science", graduationYear: "2015" },
    ],
  };
  const YEARS = ["Select...", "2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027", "2028", "2029", "2030", "Other"];
  const blocked = (r: ReturnType<typeof ask>) => r?.status === "abstain" && r.blockBackend === true;

  it("a graduation year the list does not offer is its 'Other' (it went to the AI)", () => {
    const q = "Please include your intended graduation year for the degree or relevant learning program that you are currently pursuing or have completed.✱";
    expect(value(ask(q, { options: YEARS.filter((y) => !/^202[01]$/.test(y)), controlType: "select", kind: "choice" }, LONDON))).toBe("Other");
  });
  it("high school ended before a 2015 bachelor's: not 2020 or later, so 'Other'", () => {
    expect(value(ask("Year of High School Graduation✱", { options: YEARS, controlType: "select", kind: "choice" }, LONDON))).toBe("Other");
  });
  it("a student's high-school year is unknown: theirs, kept from the AI", () => {
    expect(blocked(ask("Year of High School Graduation✱", { options: YEARS, controlType: "select", kind: "choice" }))).toBe(true);
  });
  it("a high school's name is not in the profile: kept from the AI", () => {
    expect(blocked(ask("High School Name✱", { controlType: "textarea", kind: "longText" }, LONDON))).toBe(true);
  });
  it("consent to AI notetakers is the applicant's own choice, not the AI's", () => {
    const q =
      "As part of our interview process, we may use AI notetakers to transcribe conversations for accuracy and efficiency. Please see our candidate privacy policy for more information on how we process your data. Your decision to opt in or out of this tooling will not impact your candidacy.✱";
    expect(blocked(ask(q, { options: ["Yes, I consent", "No, I do not consent"], controlType: "radioGroup", kind: "boolean" }, LONDON))).toBe(true);
  });
  it("a major in Computing is Computer Science, not 'Other'", () => {
    const MAJORS = ["Computer Science", "Computer Engineering", "Applied Mathematics", "Physics", "Electrical Engineering", "Mathematics", "Statistics", "Data Science", "Data Engineering", "Other"];
    expect(snapToOption(MAJORS, "Computing", "fieldOfStudy")).toBe("Computer Science");
  });
});

describe("'currently attending or did you last attend' (Palantir on Lever, batch C)", () => {
  const LONDON: UserApplicationProfile = {
    ...SPARSE_CANADIAN, location: "London, United Kingdom", country: "United Kingdom", expectedGraduation: undefined,
    education: [
      { school: "Imperial College London", degree: "Master of Science in Computing", graduationYear: "2016" },
      { school: "Trinity College Dublin", degree: "Bachelor of Arts in Computer Science", graduationYear: "2015" },
    ],
  };
  const Q = 'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.✱';
  const LIST = ["Click Here (If you encounter an issue, make sure your browser is updated and try clearing cache & cookies)", "Aalborg University", "Imperial College London", "Trinity College Dublin", "Other (School Not Listed)"];
  it("a graduate last attended their most recent school (it was left blank)", () => {
    expect(value(ask(Q, { options: LIST, controlType: "select", kind: "choice" }, LONDON))).toBe("Imperial College London");
  });
  it("a school the full list lacks is its 'not listed' option", () => {
    const without = LIST.filter((o) => !/Imperial|Trinity/.test(o));
    expect(value(ask(Q, { options: without, controlType: "select", kind: "choice" }, LONDON))).toBe("Other (School Not Listed)");
  });
  it("a search box's loaded options are no full list: no 'not listed' from them", () => {
    const without = LIST.filter((o) => !/Imperial|Trinity/.test(o));
    expect(value(ask(Q, { options: without, controlType: "combobox", kind: "choice" }, LONDON))).not.toBe("Other (School Not Listed)");
  });
});

describe("Mindex on Workable, answered by a veteran in Austin (batch C)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const AUSTIN: UserApplicationProfile = {
    ...CHANGER,
    location: "Austin, TX",
    country: "United States",
    willingToRelocate: "No",
    expectedGraduation: undefined,
    education: [{ school: "The University of Texas at Austin", degree: "Bachelor of Science in Computer Science", graduationYear: "2019" }],
    experience: [
      { company: "Indeed", title: "Software Engineer", startDate: "Jul 2019", endDate: "Dec 2022", description: "" },
      { company: "Dell Technologies", title: "Software Engineer II", startDate: "Jan 2023", endDate: "Present", description: "" },
    ],
  };
  const ROCHESTER = { jobCountry: "US", company: "Mindex", jobCity: "Rochester", jobPlaces: ["Rochester, New York, United States"] };
  const YN = ["YES", "NO"];

  it("onsite at the Rochester office, for an Austin applicant who will not move: NO (it went to the AI)", () => {
    const q = "Are you able to work onsite at Mindex’s Rochester office at least three days per week throughout the co-op?";
    expect(value(ask(q, { options: YN, controlType: "radioGroup", kind: "boolean" }, AUSTIN, ROCHESTER))).toBe("NO");
  });
  it("a co-op takes enrolled students: a graduate is not available for one", () => {
    const q = "Are you available to participate in a full double-block co-op from January 2027 through August 2027?";
    expect(value(ask(q, { options: YN, controlType: "radioGroup", kind: "boolean" }, AUSTIN, ROCHESTER))).toBe("NO");
  });
  it("'I currently work here' beside an unnumbered row holding the current job is ticked; its label loses the SVG fallback text", () => {
    document.body.innerHTML = `<form>
      <label><span>Title</span><input id="title" name="title" type="text"></label>
      <label><span>Company</span><input id="company" name="company" type="text"></label>
      <label><input type="checkbox" name="current"><span><svg><desc>SVGs not supported by this browser.</desc></svg>SVGs not supported by this browser.</span>I currently work here</label>
    </form>`;
    const fields = scanPage(AUSTIN, false).fields;
    const box = fields.find((f) => f.controlType === "checkbox");
    expect(box?.label).not.toMatch(/SVGs/);
    expect(box?.proposedValue).toBe("yes");
    expect(fields.find((f) => f.category === "currentCompany")?.proposedValue).toBe("Dell Technologies");
  });
});

describe("Zoox on Lever, answered by a Montreal developer who is not a student (batch C)", () => {
  const MTL: UserApplicationProfile = {
    ...CHANGER,
    country: "Canada",
    willingToRelocate: "No",
    expectedGraduation: undefined,
    education: [
      { school: "Université de Montréal", degree: "Baccalauréat en psychologie", graduationYear: "2017" },
      { school: "Concordia University", degree: "Certificate in Computer Science", graduationYear: "2023" },
    ],
  };
  const ZOOX = { jobCountry: "US", company: "Zoox", jobCity: "Foster City", jobPlaces: ["Foster City, CA, United States"] };
  const blocked = (r: ReturnType<typeof ask>) => r?.status === "abstain" && r.blockBackend === true;
  const SCHEDULE = "Do you have a school schedule that allows you to work part-time from our Foster City office during normal business hours?✱";

  it("a school schedule, asked of someone not in school: No (it was 'Yes')", () => {
    expect(value(ask(SCHEDULE, { options: YES_NO, controlType: "radioGroup", kind: "boolean" }, MTL, ZOOX))).toBe("No");
  });
  it("a student's schedule is theirs to know, not the AI's", () => {
    expect(blocked(ask(SCHEDULE, { options: YES_NO, controlType: "radioGroup", kind: "boolean" }, SPARSE_CANADIAN, ZOOX))).toBe(true);
  });
  it("working 'from our Foster City office' is in person: No for a Montrealer who will not move", () => {
    const q = "Are you able to work from our Foster City office three days a week?";
    expect(value(ask(q, { options: YES_NO, controlType: "radioGroup", kind: "boolean" }, MTL, ZOOX))).toBe("No");
  });
  it("research and outside funding, for someone not in school: No", () => {
    const YNU = ["Yes", "No", "Unsure"];
    expect(value(ask("Are you currently conducting research related to the subject matter of this role?", { options: YNU, controlType: "radioGroup", kind: "choice" }, MTL, ZOOX))).toBe("No");
    expect(value(ask("Do you currently receive any active funding (e.g., grants, sponsorships)?✱", { options: YNU, controlType: "radioGroup", kind: "choice" }, MTL, ZOOX))).toBe("No");
  });
  it("'If yes or unsure, please describe.' depends on another answer: kept from the AI", () => {
    expect(blocked(ask("If yes or unsure, please describe.", { controlType: "textarea", kind: "longText" }, MTL, ZOOX))).toBe(true);
  });
});

describe("a Lever Yes/No asked with checkboxes is labelled by its question (Zoox, batch C)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  // Verbatim from the live page (2026-10-03).
  const CARD = `<form><div class="application-question custom-question"><div><div class="application-label full-width multiple-select"><div class="text">Are you currently enrolled in a 2-year or 4-year college or university program pursuing a degree or certificate in Software Engineering, Computer Science, Systems Engineering, Mechanical Engineering, Electrical Engineering, or a related field?<span class="required">✱</span></div></div><div class="application-field full-width required-field"><ul data-qa="checkboxes"><li><label><input type="checkbox" name="cards[18631c8a-d2a4-41d9-ba8a-8fccf4193494][field0]" value="Yes" required=""><span class="application-answer-alternative">Yes</span></label></li><li><label><input type="checkbox" name="cards[18631c8a-d2a4-41d9-ba8a-8fccf4193494][field0]" value="No" required=""><span class="application-answer-alternative">No</span></label></li></ul></div></div></div></form>`;
  it("its label is the question, not the field's name, and a graduate answers No", () => {
    document.body.innerHTML = CARD;
    const grad: UserApplicationProfile = {
      ...CHANGER,
      expectedGraduation: undefined,
      education: [{ school: "Concordia University", degree: "Certificate in Computer Science", graduationYear: "2023" }],
    };
    const f = scanPage(grad, false).fields[0];
    expect(f.label).toMatch(/^Are you currently enrolled/);
    expect(f.proposedValue).toBe("No");
  });
});

describe("Hermeus on Lever, answered by a green-card student (batch C)", () => {
  const MEI: UserApplicationProfile = {
    ...SPARSE_CANADIAN,
    location: "San Jose, CA",
    country: "USA",
    workAuthorization: "U.S. permanent resident (green card)",
    requiresSponsorship: "No",
    authorizedUS: "Yes",
    expectedGraduation: "2027-12",
    education: [{ school: "San José State University", degree: "Bachelor of Science in Software Engineering", graduationYear: "2027" }],
    experience: [
      { company: "San José State University", title: "Teaching Assistant", startDate: "Aug 2025", endDate: "Present", description: "" },
      { company: "Cisco", title: "Software Engineering Intern", startDate: "May 2025", endDate: "Aug 2025", description: "" },
    ],
  };
  const blocked = (r: ReturnType<typeof ask>) => r?.status === "abstain" && r.blockBackend === true;
  const INTERNSHIP = "Have you completed at least one previous internship? Please provide details.✱";

  it("a finished internship in the history: Yes, with the details (it went to the AI)", () => {
    expect(value(ask(INTERNSHIP, { controlType: "text", kind: "text" }, MEI))).toBe("Yes, Software Engineering Intern at Cisco (May 2025 to Aug 2025)");
    expect(value(ask("Have you completed at least one previous internship?", { options: YES_NO, controlType: "radioGroup", kind: "boolean" }, MEI))).toBe("Yes");
  });
  it("no internship in the history: No", () => {
    const none = { ...MEI, experience: MEI.experience!.filter((e) => !/intern/i.test(e.title)) };
    expect(value(ask(INTERNSHIP, { controlType: "text", kind: "text" }, none))).toBe("No");
  });
  it("'If no, will you require sponsorship in the future?' is a question of its own: answered", () => {
    const opts = ["Yes, I will require sponsorship in the future", "No, I will not require sponsorship in the future"];
    expect(value(ask("If no, will you require sponsorship in the future?✱", { options: opts, controlType: "radioGroup", kind: "choice" }, MEI))).toBe(opts[1]);
  });
  it("a bare 'Other' box beside a choice is a follow-up: kept from the AI", () => {
    expect(blocked(ask("Other", { controlType: "text", kind: "text" }, MEI))).toBe(true);
  });
  it("'What is your location?' over a country list is the country", () => {
    const COUNTRIES = ["Select...", "Afghanistan", "Albania", "Algeria", "Canada", "Mexico", "United Kingdom", "United States", "Vietnam", "Zambia", "Zimbabwe"];
    expect(snapToOption(COUNTRIES, "San Jose, CA", "location")).toBe("United States");
  });
});

describe("a country list asked as 'What is your location?' on a Lever form (Hermeus, batch C)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("takes the country the applicant lives in", () => {
    // The live list also names the US inside two territories' names.
    const countries = ["Afghanistan", "Albania", "Canada", "Mexico", "United Kingdom", "United States", "United States Minor Outlying Islands", "Vietnam", "Virgin Islands, U.S."];
    // Verbatim from the live page (2026-10-03), the option list trimmed.
    const codes: Record<string, string> = {
      Afghanistan: "AF", Albania: "AL", Canada: "CA", Mexico: "MX", "United Kingdom": "GB", "United States": "US",
      "United States Minor Outlying Islands": "UM", Vietnam: "VN", "Virgin Islands, U.S.": "VI",
    };
    document.body.innerHTML = `<form><label><div class="application-label">What is your location?</div><div class="application-field"><div class="application-dropdown"><select class="candidate-location" data-qa="candidate-location-select"><option value="">Select...</option>${countries.map((c) => `<option value="${codes[c]}">${c}</option>`).join("")}</select></div></div></label></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN, location: "San Jose, CA", country: "USA" }, false).fields[0];
    expect(f.proposedValue).toBe("United States");
  });
});

describe("an accent never splits a word in option matching (Ramp on Ashby, batch C)", () => {
  it("'San José State University' is Ashby's 'San Jose State University' (option text glued to its country and domain)", () => {
    const SJ = ["San Jose State UniversityUnited Statessjsu.edu", "San Diego State UniversityUnited Statessdsu.edu", "Salem State UniversityUnited Statessalemstate.edu"];
    expect(matchOption(SJ, (o) => o, (o) => o, "San José State University")).toBe(SJ[0]);
  });
  it("'Université de Montréal' is 'Universite de Montreal'", () => {
    expect(matchOption(["Universite de Montreal", "Universite Laval"], (o) => o, (o) => o, "Université de Montréal")).toBe("Universite de Montreal");
  });
});

describe("French labels once accents are folded in matching (2026-10-03)", () => {
  const sig = (label: string): FieldSignals =>
    ({ label, ariaLabel: "", placeholder: "", nameAttr: "", testId: "", idAttr: "", nearby: "", autocomplete: "", typeHint: "" }) as FieldSignals;
  it("'Adresse électronique' is the email, never the street", () => {
    expect(classifyField(sig("Adresse électronique")).category).toBe("email");
    expect(classifyField(sig("Adresse courriel")).category).toBe("email");
  });
  it("'Adresse' and 'Région' keep their address parts", () => {
    expect(classifyField(sig("Adresse")).category).toBe("addressStreet");
    expect(classifyField(sig("Région")).category).toBe("addressState");
  });
});

describe("Address Line 2 is never a copy of line 1 (Pinpoint, live re-run 2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const lines = (addressStreet: string) => {
    document.body.innerHTML = `<form><label for="address1">Address Line 1</label><input id="address1" type="text"><label for="address2">Address Line 2</label><input id="address2" type="text"><label for="town">Town</label><input id="town" type="text"></form>`;
    const fields = scanPage({ ...SPARSE_CANADIAN, addressStreet, addressCity: "San Jose", location: "San Jose, CA" }, false).fields;
    const at = (id: string) => fields.find((f) => document.getElementById(id)!.getAttribute("data-ap-field") === f.id);
    return { one: at("address1"), two: at("address2") };
  };
  it("a street with no unit: line 2 stays blank, and away from the AI (it got '1 Washington Sq' twice)", () => {
    const { one, two } = lines("1 Washington Sq");
    expect(one?.proposedValue).toBe("1 Washington Sq");
    expect(two?.proposedValue ?? null).toBeNull();
    expect(two?.deviceAbstained).toBe(true);
  });
  it("a street with a unit: line 2 is the unit, and line 1 the street without it", () => {
    const { one, two } = lines("4520 rue Saint-Denis, app. 3");
    expect(two?.proposedValue).toBe("app. 3");
    expect(one?.proposedValue).toBe("4520 rue Saint-Denis");
  });
});

describe("Paylocity's education rows: school type and 'Did you Graduate?' (live re-run 2026-10-03)", () => {
  const LONDON: UserApplicationProfile = {
    ...SPARSE_CANADIAN,
    expectedGraduation: undefined,
    education: [
      { school: "Imperial College London", degree: "Master of Science in Computing", graduationYear: "2016" },
      { school: "Trinity College Dublin", degree: "Bachelor of Arts in Computer Science", graduationYear: "2015" },
    ],
  };
  const TYPES = ["--", "Unspecified", "High School", "Community College", "Vocational College", "College / University"];
  const row = (category: "school" | "degree", options: string[], groupIndex: number, profile = LONDON) =>
    resolveProfileValue(category, profile, { controlType: "combobox", options, groupIndex }, false);
  it("School Type is the kind of school, not its name (it got 'Imperial College London')", () => {
    expect(row("school", TYPES, 0)).toBe("College / University");
    expect(row("school", TYPES, 1)).toBe("College / University");
  });
  it("'Did you Graduate?' is that row's own: Yes for a finished degree, No for one in progress", () => {
    expect(row("degree", ["--", "Yes", "No"], 0)).toBe("Yes");
    expect(row("degree", ["--", "Yes", "No"], 0, SPARSE_CANADIAN)).toBe("No");
  });
});

describe("able to obtain a U.S. security clearance, for someone who is not a U.S. citizen (Pinpoint, live re-run 2026-10-03)", () => {
  const Q = "Are you able to obtain/maintain a U.S. security clearance?";
  const base = { ...SPARSE_CANADIAN, location: "San Jose, CA", country: "USA", securityClearance: "None" };
  it("a green-card holder: No (clearances go to U.S. citizens)", () => {
    expect(value(ask(Q, { options: YES_NO }, { ...base, workAuthorization: "U.S. permanent resident (green card)" }))).toBe("No");
  });
  it("a citizen with none yet: theirs to say", () => {
    expect(ask(Q, { options: YES_NO }, { ...base, workAuthorization: "U.S. citizen" })?.status).toBe("abstain");
  });
  it("'willing to obtain' is willingness, not eligibility: not answered from citizenship", () => {
    expect(value(ask("Are you willing to obtain a U.S. security clearance?", { options: YES_NO }, { ...base, workAuthorization: "U.S. permanent resident (green card)" }))).not.toBe("No");
  });
});

describe("Paylocity's react-widgets dropdowns and education labels (final run, 2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  /** react-widgets' DropdownList as Paylocity renders it: a div combobox whose
   *  own text is the selection, owning a listbox inside it. */
  const dropdownList = (options: string[], sticks = true) => {
    document.body.innerHTML = `<form><label>Did you Graduate?</label><div id="dd" role="combobox" aria-owns="dd__listbox" aria-expanded="false" aria-haspopup="true" tabindex="0" class="rw-dropdownlist rw-widget"><span class="rw-select" aria-hidden="true"></span><div class="rw-input">--</div></div></form>`;
    const box = document.getElementById("dd")!;
    box.addEventListener("click", () => {
      if (box.getAttribute("aria-expanded") === "true") return;
      box.setAttribute("aria-expanded", "true");
      // Mounted on first open and kept, hidden, once closed (live).
      const kept = document.getElementById("dd__listbox");
      if (kept) {
        kept.style.display = "";
        return;
      }
      const lb = document.createElement("ul");
      lb.id = "dd__listbox";
      lb.setAttribute("role", "listbox");
      for (const o of options) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = o;
        li.addEventListener("click", (e) => {
          e.stopPropagation(); // the list is inside the widget: a pick never reopens it (live)
          if (sticks) box.querySelector(".rw-input")!.textContent = o;
          box.setAttribute("aria-expanded", "false");
          lb.style.display = "none";
        });
        lb.append(li);
      }
      box.append(lb);
    });
    return box;
  };
  it("a selection shown as the widget's own text is a selection (it read 'didn't stick')", async () => {
    const box = dropdownList(["--", "Yes", "No"]);
    const res = await fillAriaCombobox(box, "Yes", { sleep: async () => {}, openWaitMs: 50, commitWaitMs: 50, pollMs: 5 });
    expect(box.querySelector(".rw-input")?.textContent).toBe("Yes");
    expect(res.reason ?? "").toBe("");
    expect(res.filled).toBe(true);
  });
  it("a pick that did not stick is no fill, though the kept list still holds the option", async () => {
    const box = dropdownList(["--", "Yes", "No"], false);
    const res = await fillAriaCombobox(box, "Yes", { sleep: async () => {}, openWaitMs: 50, commitWaitMs: 50, pollMs: 5 });
    expect(box.querySelector(".rw-input")?.textContent).toBe("--");
    expect(res.filled).toBe(false);
  });
  it("the scanner reads the shown choice, not the kept list", async () => {
    const box = dropdownList(["--", "Yes", "No"]);
    await fillAriaCombobox(box, "No", { sleep: async () => {}, openWaitMs: 50, commitWaitMs: 50, pollMs: 5 });
    expect(readComboboxValue(box)).toBe("No");
  });
  it("'Area of Study' is the field of study", () => {
    const sig = { label: "Area of Study", ariaLabel: "", placeholder: "", nameAttr: "", testId: "", idAttr: "educationHistory.areaOfStudy.0", nearby: "", autocomplete: "", typeHint: "" } as FieldSignals;
    expect(classifyField(sig).category).toBe("fieldOfStudy");
  });
  it("Paylocity's full School Type list (with 'Graduate School', 'Specialized', 'Other') is still a list of kinds", () => {
    const TYPES = ["--", "Unspecified", "High School", "Community College", "Vocational College", "College / University", "Graduate School", "Specialized", "Other"];
    const p = { ...SPARSE_CANADIAN, education: [{ school: "Imperial College London", degree: "Master of Science in Computing", graduationYear: "2016" }] };
    expect(resolveProfileValue("school", p, { controlType: "combobox", options: TYPES, groupIndex: 0 }, false)).toBe("College / University");
  });
});

describe("a street address box with suggestions that never come keeps the street (Paylocity, final run 2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const fast = { sleep: async () => {}, openWaitMs: 30, commitWaitMs: 30, pollMs: 5 };
  const box = () => {
    document.body.innerHTML = `<form><label for="a1">Address Line 1</label><input id="a1" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="a1-autocomplete-list"></form>`;
    return document.getElementById("a1") as HTMLInputElement;
  };
  it("free text: the typed street stays and counts", async () => {
    const el = box();
    const res = await fillAriaCombobox(el, "12 Bermondsey Street", { ...fast, freeText: true });
    expect(res.filled).toBe(true);
    expect(el.value).toBe("12 Bermondsey Street");
  });
  it("a pick-only box still never keeps a filter string", async () => {
    const el = box();
    const res = await fillAriaCombobox(el, "12 Bermondsey Street", fast);
    expect(res.filled).toBe(false);
    expect(el.value).toBe("");
  });
});

describe("a comma is no place: 'Yes, I live here' is answered as an answer (Brex, regression run 2026-10-03)", () => {
  const BREX = ["Yes, I live here", "Yes, I plan to relocate", "No"];
  it("options naming no state or country are not place suggestions", () => {
    expect(looksLikePlaces(BREX)).toBe(false);
    expect(looksLikePlaces(["Toronto, ON, CAN", "Toronto, OH, US", "Toronto, New South Wales, Australia"])).toBe(true);
    expect(looksLikePlaces(["San Jose, CA, United States", "San José, Costa Rica"])).toBe(true);
  });
  it("the page-world driver picks the answer though the field is a location with a place hint", () => {
    expect(pickOption(BREX, "Yes, I plan to relocate", "Toronto, ON, Canada")).toBe(1);
  });
});
