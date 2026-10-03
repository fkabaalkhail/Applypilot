/**
 * The deterministic question resolver: screening-question SHAPES answered from
 * derived profile facts, rendered into what the field accepts. Abstentions are
 * asserted as carefully as answers: an abstention is what keeps a field blank
 * instead of filled with a confident guess.
 */
import { describe, expect, it } from "vitest";
import { profileFacts } from "../src/content/profileFacts";
import { countryNamedIn, formatDateFor, resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import type { AnswerKind } from "../src/content/answerKind";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../src/shared/types";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

const YES_NO = ["Yes", "No"];

function ask(
  label: string,
  opts: { options?: string[]; controlType?: ControlType; kind?: AnswerKind; category?: FieldCategory; inputType?: string; placeholder?: string } = {},
  profile: UserApplicationProfile = SPARSE_CANADIAN,
  ctx = { jobCountry: null as string | null, company: "" }
) {
  const q: QuestionInput = {
    label,
    controlType: opts.controlType ?? (opts.options ? "radioGroup" : "text"),
    options: opts.options,
    category: opts.category ?? "unknown",
    kind: opts.kind ?? (opts.options ? (opts.options.length === 2 && opts.options[0] === "Yes" ? "boolean" : "choice") : "text"),
    inputType: opts.inputType,
    placeholder: opts.placeholder,
  };
  return resolveQuestion(q, profileFacts(profile, TEST_TODAY), profile, ctx);
}

const value = (r: ReturnType<typeof ask>) => (r && r.status === "answer" ? r.value : r?.status ?? null);

describe("work authorization, country-aware", () => {
  it("Canadian citizen: Canada Yes, United States ABSTAIN (never Yes)", () => {
    expect(value(ask("Are you legally authorized to work in Canada?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Are you legally authorized to work in the United States?", { options: YES_NO }))).toBe("abstain");
    expect(value(ask("Are you authorized to work in the U.S.?", { options: YES_NO }))).toBe("abstain");
  });

  it("'this country' follows the job's country, and abstains when it is unknown", () => {
    expect(value(ask("Are you authorized to work in this country?", { options: YES_NO }))).toBe("abstain");
    expect(value(ask("Are you authorized to work in this country?", { options: YES_NO }, SPARSE_CANADIAN, { jobCountry: "CA", company: "" }))).toBe("Yes");
    expect(value(ask("Are you authorized to work in this country?", { options: YES_NO }, SPARSE_CANADIAN, { jobCountry: "US", company: "" }))).toBe("abstain");
  });

  it("'eligible to work in Canada without sponsorship?' is authorized AND no sponsorship", () => {
    expect(value(ask("Are you eligible to work in Canada without sponsorship?", { options: ["YES", "NO"] }))).toBe("YES");
    expect(value(ask("Are you eligible to work in the US without sponsorship?", { options: ["YES", "NO"] }))).toBe("abstain");
  });

  it("sponsorship: the applicant's stated No covers their own country, not another", () => {
    const p = { ...SPARSE_CANADIAN, workAuthorization: "Authorized to work in Canada", requiresSponsorship: "No" };
    expect(value(ask("Will you now or in the future require sponsorship?", { options: YES_NO }, p))).toBe("No");
    expect(value(ask("Will you now or in the future require visa sponsorship to work in the United States?", { options: YES_NO }, p))).toBe("abstain");
  });

  it("a stated 'Yes' to sponsorship is answered Yes", () => {
    const p = { ...SPARSE_CANADIAN, location: "Boston, MA", workAuthorization: "F-1 student visa", requiresSponsorship: "Yes" };
    expect(value(ask("Will you require sponsorship for employment visa status (e.g. H-1B)?", { options: YES_NO }, p))).toBe("Yes");
  });

  it("renders into sentence options by polarity", () => {
    const opts = ["Yes, I am authorized to work in Canada", "No, I am not authorized to work in Canada"];
    expect(value(ask("Are you legally entitled to work in Canada?", { options: opts }))).toBe(opts[0]);
  });

  it("free-text authorization gets the statement only for the country it covers", () => {
    expect(value(ask("Please describe your work authorization status in Canada", { kind: "text" }))).toBe("Canadian citizen");
    expect(value(ask("Please describe your work authorization status in the United States", { kind: "text" }))).toBe("abstain");
  });

  it("WHICH sponsorship is needed is no profile answer, never the authorization statement (Brex, live 2026-10-03)", () => {
    const label = "If you're not authorized to work at the stated location, what sponsorship would you require for the role?";
    // With the US answer on file the statement "covers" the US: that is how it got written.
    const p = { ...SPARSE_CANADIAN, authorizedUS: "No", authorizedCanada: "Yes" };
    const r = ask(label, { kind: "text" }, p, { jobCountry: "US", company: "Brex" });
    expect(value(r)).toBe("abstain");
    expect(r && r.status === "abstain" && r.blockBackend).toBe(true);
    expect(value(ask("What type of visa sponsorship will you require?", { kind: "text" }, p))).toBe("abstain");
  });
});

describe("conditional questions: the condition first", () => {
  const ACTIONET = ["Select an option...", "Yes", "No", "I am not a current or former government employee"];
  it("a false condition picks the option saying so (ActioNet on Jobvite, live 2026-10-03)", () => {
    expect(value(ask("If you are a current or former government employee, have you recused yourself in writing to the appropriate government official from working on all contracts or programs involving ActioNet?*", { options: ACTIONET, kind: "choice" }))).toBe("I am not a current or former government employee");
    expect(value(ask("If you are a current or former government employee, are you currently or were you ever previously involved in any ActioNet contracts or programs?*", { options: ACTIONET, kind: "choice" }))).toBe("I am not a current or former government employee");
  });
  it("…or stays blank, and away from the backend, when no option says so", () => {
    const r = ask("If you were referred, who referred you?", { kind: "text" });
    expect(value(r)).toBe("abstain");
    const yn = ask("If you are a current or former government employee, have you recused yourself?", { options: YES_NO });
    expect(value(yn)).toBe("abstain");
    expect(yn && yn.status === "abstain" && yn.blockBackend).toBe(true);
    // Brex (live 2026-10-03): never worked at Capital One, so no Employee ID.
    expect(value(ask("If you currently work, or have previously worked, at Capital One or a company acquired by Capital One, please provide your Employee ID (EID). This information is required for former/current employees.", { kind: "text" }))).toBe("abstain");
  });
  it("a condition that holds answers the question itself", () => {
    const p = { ...SPARSE_CANADIAN, gpa: "3.7/4.0" };
    expect(value(ask("If you are currently enrolled in or have graduated from a university, what is your GPA?", { kind: "text" }, p))).toBe("3.7/4.0");
  });
  it("a hypothetical holds; an unknown condition stays blank", () => {
    expect(value(ask("If you are offered this position, will you require visa sponsorship?", { options: YES_NO }, SPARSE_CANADIAN, { jobCountry: "CA", company: "" }))).toBe("No");
    expect(value(ask("If you hold an active security clearance, what level is it?", { kind: "text" }))).toBe("abstain");
  });
  it("'currently enrolled OR graduated' is true for either", () => {
    const grad = { ...SPARSE_CANADIAN, education: [{ school: "University of Toronto", degree: "BSc Computer Science", graduationYear: "2022" }] };
    expect(value(ask("Are you currently enrolled in or have graduated from a university?", { options: YES_NO }, grad))).toBe("Yes");
    expect(value(ask("Are you currently enrolled in or have graduated from a university?", { options: YES_NO }))).toBe("Yes");
  });
});

describe("citizenship", () => {
  it("answers citizenship of the stated country and abstains for others", () => {
    expect(value(ask("Are you a Canadian citizen?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Are you a U.S. citizen?", { options: YES_NO }))).toBe("abstain");
  });

  it("a permanent resident is not a citizen, but is a 'citizen or permanent resident'", () => {
    const pr = { ...SPARSE_CANADIAN, workAuthorization: "Permanent resident of Canada" };
    expect(value(ask("Are you a citizen of Canada?", { options: YES_NO }, pr))).toBe("No");
    expect(value(ask("Are you a Canadian citizen or permanent resident?", { options: YES_NO }, pr))).toBe("Yes");
  });
});

describe("residence", () => {
  it("'Do you live in the United States?' → No for Toronto", () => {
    expect(value(ask("Do you live in the United States?", { options: ["YES", "NO"] }))).toBe("NO");
  });

  it("'Are you located in Ontario?' → Yes; 'in Quebec?' → No", () => {
    expect(value(ask("Are you currently located in Ontario?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Are you currently located in Quebec?", { options: YES_NO }))).toBe("No");
  });

  it("a free-text yes/no residence question gets Yes/No, never a place name", () => {
    expect(value(ask("Are you currently located in Quebec?", { kind: "boolean" }))).toBe("No");
  });

  it("'live in or near Seattle? If not, willing to relocate?' depends on relocation, which is unknown", () => {
    expect(value(ask("Do you currently live in or near Seattle? If not, are you willing to relocate?", { options: ["YES", "NO"] }))).toBe("abstain");
    const willing = { ...SPARSE_CANADIAN, willingToRelocate: "Yes" };
    expect(value(ask("Do you currently live in or near Seattle? If not, are you willing to relocate?", { options: ["YES", "NO"] }, willing))).toBe("YES");
  });

  it("another city in the SAME country is a judgment call: abstain", () => {
    expect(value(ask("Do you live in or near Ottawa?", { options: YES_NO }))).toBe("abstain");
  });

  it("'Where are you located?' with continent options → North America", () => {
    expect(value(ask("Where are you located?", { options: ["New York Area", "North America", "South America", "Other"] }))).toBe("North America");
  });

  it("a preferred office question is not a residence question", () => {
    expect(ask("Preferred work location", { options: ["Toronto", "New York"] })).toBeNull();
  });

  it("a US-state select for a Canadian resident picks its explicit outside option", () => {
    const states = ["Select an option...", "Not Applicable", "Alabama", "Alaska", "California", "New York"];
    expect(value(ask("State", { options: states, category: "addressState", controlType: "select" }))).toBe("Not Applicable");
    expect(value(ask("State", { options: states.filter((s) => s !== "Not Applicable"), category: "addressState", controlType: "select" }))).toBe("abstain");
  });
});

describe("age", () => {
  const dob = { ...SPARSE_CANADIAN, dateOfBirth: "2003-06-02" };
  it("answers an age gate from the date of birth", () => {
    expect(value(ask("Are you 18 years of age or older?", { options: YES_NO }, dob))).toBe("Yes");
    expect(value(ask("Are you under the age of 18?", { options: YES_NO }, dob))).toBe("No");
  });
  it("without a date of birth, an adult (18+) gate defaults to Yes; a higher bar stays the applicant's", () => {
    expect(value(ask("Are you age 18 or older?", { options: ["Select an option...", "Yes", "No"] }))).toBe("Yes");
    expect(value(ask("Are you 21 years of age or older?", { options: YES_NO }))).toBe("abstain");
  });
  it("places an exact age in its bucket", () => {
    expect(value(ask("What is your age range?", { options: ["17 or younger", "18-20", "21-29", "30-39"] }, dob))).toBe("21-29");
  });
});

describe("experience", () => {
  it("total years into a bucket", () => {
    expect(value(ask("How many years of professional software development experience do you have?", { options: ["0-1 year", "1-3 years", "4-6 years", "Over 6 years"] }))).toBe("1-3 years");
  });
  it("whole years into a text field", () => {
    expect(value(ask("Please provide the total number of years of relevant experience you have", { kind: "number" }))).toBe("1");
  });
  it("a skill-specific question abstains", () => {
    expect(value(ask("How many years of experience do you have with Kubernetes?", { kind: "number" }))).toBe("abstain");
  });
  it("a domain the titles do not prove abstains", () => {
    expect(value(ask("How many years of sales experience do you have?", { kind: "number" }))).toBe("abstain");
  });
  it("'at least N years' compares", () => {
    expect(value(ask("Do you have at least 1 year of professional experience?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Do you have 3+ years of professional experience?", { options: YES_NO }))).toBe("No");
  });
});

describe("education", () => {
  const levels = ["Select an option...", "High School", "GED", "Associates", "Bachelors", "Masters", "PhD"];
  it("highest education abstains while a higher degree is in progress", () => {
    expect(value(ask("What is your highest education?", { options: levels, controlType: "select" }))).toBe("abstain");
  });
  it("highest education of a graduate → their level", () => {
    const grad = { ...SPARSE_CANADIAN, education: [{ school: "uOttawa", degree: "BSc Computer Science", graduationYear: "2024" }] };
    expect(value(ask("What is your highest education?", { options: levels, controlType: "select" }, grad))).toBe("Bachelors");
  });
  it("'Do you have a bachelor's degree?' is No while still studying, Yes once pursuing counts", () => {
    expect(value(ask("Do you have a Bachelor's degree?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Do you have or are you currently pursuing a Bachelor's degree?", { options: YES_NO }))).toBe("Yes");
  });
  it("school membership from the education list", () => {
    expect(value(ask("Are you currently attending or a recent graduate of the University of Florida?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Are you a student at the University of Waterloo?", { options: YES_NO }))).toBe("Yes");
  });
  it("currently enrolled", () => {
    expect(value(ask("Are you currently a student?", { options: YES_NO }))).toBe("Yes");
  });
  it("school names by role", () => {
    expect(value(ask("What is the name of the school you are currently attending?", { kind: "longText", controlType: "textarea" }))).toBe("University of Waterloo");
    expect(value(ask("Where did you complete your undergraduate degree?", { kind: "text" }))).toBe("University of Waterloo");
  });
  it("graduation year", () => {
    expect(value(ask("Expected graduation year", { kind: "text" }))).toBe("2027");
    expect(value(ask("When is your expected graduation date?", { options: ["2025", "2026", "2027", "2028"], controlType: "select" }))).toBe("2027");
    expect(value(ask("When is your expected graduation date?", { options: ["May 2027", "December 2027"], controlType: "select" }))).toBe("abstain");
  });
});

describe("employment history", () => {
  it("'current or past employee of ActioNet?' → Neither", () => {
    expect(value(ask("Are you current or past employee of ActioNet, Inc.?", { options: ["Current ActioNet Employee", "Past ActioNet Employee", "Neither"], controlType: "select" }))).toBe("Neither");
  });
  it("'Have you ever worked for Shopify?' → Yes", () => {
    expect(value(ask("Have you ever worked for Shopify?", { options: YES_NO }))).toBe("Yes");
  });
  it("'worked for us' uses the job's company", () => {
    expect(value(ask("Have you previously worked for us?", { options: YES_NO }, SPARSE_CANADIAN, { jobCountry: null, company: "Kinaxis" }))).toBe("Yes");
  });
  it("a skill question is not an employer question", () => {
    expect(value(ask("Have you worked with React?", { options: YES_NO }))).not.toBe("No");
  });
  it("an employer the question does not name abstains", () => {
    expect(value(ask("Have you ever worked at a startup?", { options: YES_NO }))).toBe("abstain");
  });
});

describe("availability", () => {
  const notice = { ...SPARSE_CANADIAN, noticePeriod: "2 weeks" };
  it("start date from the notice period, formatted for the field", () => {
    expect(value(ask("Date Available", { kind: "date", placeholder: "mm/dd/yyyy" }, notice))).toBe("10/17/2026");
    expect(value(ask("When can you start?", { kind: "date", inputType: "date" }, notice))).toBe("2026-10-17");
  });
  it("'available to start within 4 weeks?' compares", () => {
    expect(value(ask("Are you available to start within 4 weeks?", { options: YES_NO }, notice))).toBe("Yes");
    expect(value(ask("Are you available to start within 1 week?", { options: YES_NO }, notice))).toBe("No");
  });
  it("a bare 'Start Date' is NOT an availability question (employment rows)", () => {
    expect(ask("Start Date", { kind: "date" }, notice)).toBeNull();
  });
});

describe("never answered from a profile", () => {
  it("opinions and a referrer's name stay unanswered; criminal history too", () => {
    expect(value(ask("Do you think AI will take over the world?", { options: ["Yes", "No", "Maybe So"] }))).toBe("abstain");
    expect(value(ask("Who referred you?"))).toBe("abstain");
    expect(value(ask("Have you ever been convicted of a felony?", { options: YES_NO }))).toBe("abstain");
  });
  it("channels, prior applications and background checks get the documented defaults (defaultAnswers.ts)", () => {
    expect(value(ask("How did you hear about us?", { options: ["LinkedIn", "Indeed"] }))).toBe("LinkedIn");
    expect(value(ask("How did you hear about us?", { options: ["LinkedIn", "Job Board", "Referral"] }))).toBe("Job Board");
    expect(value(ask("Do you anticipate having any challenges with clearing a background check?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Are you willing to undergo a background check?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Have you previously applied to Acme?", { options: YES_NO }))).toBe("No");
    // A free-text question a bare yes/no would not answer stays for the AI.
    expect(ask("Do you anticipate having any challenges with clearing a background check?", { kind: "longText" })).toBeNull();
  });
  it("conditional follow-ups", () => {
    expect(value(ask("If 'Other' selected for School Name, please indicate here"))).toBe("abstain");
    expect(value(ask("If yes, please explain"))).toBe("abstain");
  });
});

describe("stated facts", () => {
  it("relocation, licence, clearance, languages", () => {
    const p = { ...SPARSE_CANADIAN, willingToRelocate: "No", driversLicense: "Yes", securityClearance: "None", languages: "English (Native), French (Professional)" };
    expect(value(ask("Are you willing to relocate?", { options: YES_NO }, p))).toBe("No");
    expect(value(ask("Do you have a valid driver's license?", { options: YES_NO }, p))).toBe("Yes");
    expect(value(ask("Do you have an Active Clearance/Public Trust?", { options: ["Select an option...", "Yes", "No"] }, p))).toBe("No");
    expect(value(ask("Clearance Type", { options: ["Select an option...", "None", "Public Trust", "Secret"], controlType: "select" }, p))).toBe("None");
    expect(value(ask("Are you fluent in French?", { options: YES_NO }, p))).toBe("Yes");
    expect(value(ask("Do you speak Spanish?", { options: YES_NO }, p))).toBe("abstain");
  });
  it("relocation ASSISTANCE is not willingness, and is never defaulted", () => {
    const p = { ...SPARSE_CANADIAN, willingToRelocate: "Yes" };
    expect(value(ask("Will you require relocation assistance?", { options: YES_NO }, p))).not.toBe("Yes");
    expect(value(ask("Will you require relocation assistance?", { options: YES_NO }))).not.toBe("Yes");
  });
});

describe("helpers", () => {
  it("countryNamedIn: capital US only; 'North America' is not the US", () => {
    expect(countryNamedIn("Are you authorized to work in the US?")).toEqual({ code: "US" });
    expect(countryNamedIn("Can you work for us?")).toBeNull();
    expect(countryNamedIn("anywhere in North America")).toBeNull();
    expect(countryNamedIn("in this country")).toBe("this-country");
  });
  it("formatDateFor follows the placeholder", () => {
    const d = new Date(Date.UTC(2026, 9, 17));
    const base = { label: "", controlType: "text" as const, category: "unknown" as const, kind: "date" as const };
    expect(formatDateFor(d, { ...base, placeholder: "DD/MM/YYYY" })).toBe("17/10/2026");
    expect(formatDateFor(d, { ...base, placeholder: "YYYY-MM-DD" })).toBe("2026-10-17");
    expect(formatDateFor(d, { ...base })).toBe("10/17/2026");
  });
});

describe("residence: the applicant must be the subject", () => {
  // Lever, live 2026-10-03: the office is "located", not the applicant.
  it("an office-location commute question is not a residence question", () => {
    const label =
      "This position requires you to work from the Toronto Office located at 196 Spadina Avenue. Are you able to commute to the office 3 days a week?";
    const r = ask(label, { options: YES_NO });
    // Answered as an accepted REQUIREMENT of the posting, never as residence.
    expect(r && r.status === "answer" ? r.rule : "").toBe("default:accepts-requirement");
  });
  it("still answers 'Are you currently based in Toronto?'", () => {
    expect(value(ask("Are you currently based in Toronto?", { options: YES_NO }))).toBe("Yes");
  });
});

describe("'able to work' is a work-right question only with a country and no arrangement", () => {
  // Lever (Kepler), live 2026-10-03, verbatim.
  it("an office-attendance question is not work authorization", () => {
    const label =
      "This position requires you to work from the Toronto Office located at 24 Ward Street, Toronto ON M6H 4A6. Are you able to work from our Kepler office as required?";
    const r = ask(label, { options: YES_NO }, SPARSE_CANADIAN, { jobCountry: "CA", company: "Kepler" });
    // Office attendance is an accepted requirement, not work authorization.
    expect(r && r.status === "answer" ? r.rule : "").toBe("default:accepts-requirement");
  });
  it("'Are you able to work in Canada?' is", () => {
    expect(value(ask("Are you able to work in Canada?", { options: YES_NO }))).toBe("Yes");
  });
  it("'Are you legally able to work in Canada according to the laws…?' is", () => {
    expect(value(ask("Are you legally able to work in Canada according to the laws and regulations of the country?", { options: YES_NO }))).toBe("Yes");
  });
});

describe("which abstentions keep a field from the backend", () => {
  it("legal-status abstentions are blocked from the backend's rule pass", () => {
    const r = ask("Are you legally authorized to work in the United States?", { options: YES_NO });
    expect(r).toMatchObject({ status: "abstain", blockBackend: true });
  });
  it("opinions and essays stay available to the backend AI", () => {
    const r = ask("Do you think AI will take over the world?", { options: ["Yes", "No", "Maybe So"] });
    expect(r).toMatchObject({ status: "abstain", blockBackend: false });
  });
  it("a compound relocation-or-sponsorship question is not answered from one half", () => {
    const p = { ...SPARSE_CANADIAN, requiresSponsorship: "No" };
    expect(value(ask("Will you require relocation assistance or visa sponsorship?", { options: YES_NO }, p))).toBe("abstain");
  });
});

describe("high school questions are not the university's (Palantir on Lever, live 2026-10-03)", () => {
  // "High School Name" got "University of Waterloo" and "Year of High School
  // Graduation" got the university's 2027.
  it("abstains on the high school's name and graduation year", () => {
    expect(value(ask("High School Name", { controlType: "textarea", kind: "longText", category: "school" }))).toBe("abstain");
    expect(value(ask("Year of High School Graduation", { options: ["2020", "2021", "2022", "2023", "2027"], category: "school" }))).toBe("abstain");
    expect(value(ask("Which secondary school did you attend?", { category: "school" }))).toBe("abstain");
  });

  it("leaves the university and education-level questions to their own rules", () => {
    const rule = (r: ReturnType<typeof ask>) => (r && r.status === "abstain" ? r.rule : "");
    expect(rule(ask("Which university are you currently attending or did you last attend?", { category: "school" }))).not.toBe("high-school:not-in-profile");
    expect(rule(ask("What is the highest level of education you have completed?", { options: ["High School", "Bachelor's", "Master's"] }))).not.toBe("high-school:not-in-profile");
    expect(rule(ask("Do you have a high school diploma or GED?", { options: YES_NO }))).not.toBe("high-school:not-in-profile");
  });
});
