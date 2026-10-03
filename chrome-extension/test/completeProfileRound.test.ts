/**
 * The "complete profile" round (2026-10-03): a Canadian applicant who filled in
 * every Profile answer, run against 18 live application pages. Each test below
 * is a question that page left blank or answered wrong; labels and options are
 * verbatim from the live pages (read with the dropdowns opened).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { profileFacts } from "../src/content/profileFacts";
import { resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import { scanPage } from "../src/content/formScanner";
import type { AnswerKind } from "../src/content/answerKind";
import type { ControlType, UserApplicationProfile } from "../src/shared/types";
import { stubLayout } from "./helpers/layout";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

const COMPLETE: UserApplicationProfile = {
  ...SPARSE_CANADIAN,
  country: "Canada",
  requiresSponsorship: "No",
  authorizedUS: "No",
  authorizedCanada: "Yes",
  willingToRelocate: "Yes",
  workPreference: "Hybrid",
  earliestStartDate: "2027-05-03",
  howDidYouHear: "LinkedIn",
  expectedGraduation: "2027-04",
  gpa: "3.7/4.0",
  securityClearance: "None",
  eeo: { gender: "Female", genderIdentity: "Cisgender", race: "White" },
};
const YES_NO = ["Yes", "No"];

function ask(
  label: string,
  opts: { options?: string[]; controlType?: ControlType; kind?: AnswerKind } = {},
  profile: UserApplicationProfile = COMPLETE,
  ctx: { jobCountry: string | null; company: string; jobCity?: string | null } = { jobCountry: "US", company: "" }
) {
  const q: QuestionInput = {
    label,
    controlType: opts.controlType ?? (opts.options ? "select" : "text"),
    options: opts.options,
    category: "unknown",
    kind: opts.kind ?? (opts.options ? (opts.options.length === 2 && opts.options[0] === "Yes" ? "boolean" : "choice") : "text"),
  };
  return resolveQuestion(q, profileFacts(profile, TEST_TODAY), profile, ctx);
}
const value = (r: ReturnType<typeof ask>) => (r && r.status === "answer" ? r.value : r?.status ?? null);

describe("work authorization and employment (Twitch on Greenhouse)", () => {
  it("'legally eligible to begin employment' is a work-right question for the job's country", () => {
    const q = "If offered employment by Amazon, would you be legally eligible to begin employment immediately?*";
    expect(value(ask(q, { options: YES_NO }))).toBe("No");
    expect(value(ask(q, { options: YES_NO }, COMPLETE, { jobCountry: "CA", company: "" }))).toBe("Yes");
  });
  it("H-1B HISTORY is not 'will you need sponsorship?' (it was answered Yes)", () => {
    const q = "Have you held H-1B status, or had an H-1B petition approved on your behalf in the past 6 years?*";
    expect(value(ask(q, { options: YES_NO }))).toBe("No");
    expect(value(ask(q, { options: YES_NO }, { ...COMPLETE, workAuthorization: "H-1B visa holder" }))).toBe("Yes");
    // A US student visa: maybe, maybe not. The applicant's to answer.
    expect(value(ask(q, { options: YES_NO }, { ...COMPLETE, workAuthorization: "F-1 student visa (OPT eligible)" }))).toBe("abstain");
  });
  it("'Are you currently a Twitch employee?' names the company with 'a … employee'", () => {
    expect(value(ask("Are you currently a Twitch employee?*", { options: YES_NO }))).toBe("No");
  });
  it("relocation answered with WHERE: the job's city, 'No', or the remote alternative", () => {
    const opts = ["No", "No, but I'm open to a remote position", "San Francisco, CA", "Irvine, CA", "Los Angeles, CA", "Seattle, WA", "New York, NY", "Salt Lake City, UT", "Chicago, IL", "London, UK", "Seoul, Korea", "Tokyo, Japan", "Taipei, Taiwan", "Berlin, Germany", "Hamburg, Germany", "Singapore", "Sydney, Australia"];
    const sf = { jobCountry: "US", company: "Twitch", jobCity: "San Francisco" };
    expect(value(ask("Are you open to relocation? *", { options: opts }, COMPLETE, sf))).toBe("San Francisco, CA");
    expect(value(ask("Are you open to relocation? *", { options: opts }, { ...COMPLETE, willingToRelocate: "No" }, sf))).toBe("No");
    expect(value(ask("Are you open to relocation? *", { options: opts }, { ...COMPLETE, willingToRelocate: "No", workPreference: "Remote" }, sf))).toBe("No, but I'm open to a remote position");
    // The job's city unknown: no city is picked.
    expect(value(ask("Are you open to relocation? *", { options: opts }))).toBe("abstain");
  });
});

describe("SpaceX on Greenhouse", () => {
  it("employment history from its options: never worked there", () => {
    const opts = [
      "I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter",
      "I am a former SpaceX, SpaceXAI, xAI, X, or Twitter employee",
      "I am a current or former SpaceX, SpaceXAI, xAI, X, or Twitter Intern",
      "I am a current SpaceX employee",
      "I am a current SpaceXAI employee",
      "I am currently working or have worked at a SpaceX, SpaceXAI, xAI, X, or Twitter facility for another employer (i.e. contracted by a third-party employer)",
    ];
    expect(value(ask("SpaceX & SpaceXAI Employment History*", { options: opts }))).toBe(opts[0]);
  });
  it("U.S. citizenship status: not authorized in the US is none of (a)-(e)", () => {
    const opts = [
      "(a) U.S. citizen or national of the United States",
      "(b) U.S. lawful permanent resident",
      "(c) Refugee under 8 U.S.C. 1157",
      "(d) Asylee under 8 U.S.C. 1158",
      "(e) Authorized to work in the United States under the Deferred Action for Childhood Arrivals (DACA) program",
      "(f) Other (please explain)",
    ];
    expect(value(ask("Citizenship Status*", { options: opts }))).toBe("(f) Other (please explain)");
    expect(value(ask("Citizenship Status*", { options: opts }, { ...SPARSE_CANADIAN, workAuthorization: "U.S. citizen" }))).toBe(opts[0]);
    // Nothing said about the US: blank, never a guess.
    expect(value(ask("Citizenship Status*", { options: opts }, SPARSE_CANADIAN))).toBe("abstain");
    // Its follow-up stays the applicant's.
    expect(value(ask("If (f) Other, please explain:"))).toBe("abstain");
  });
  it("graduate GPA without a graduate degree, and test scores the profile has none of", () => {
    const gpa = ["Other/Not Applicable", "4.0 out of 4.0", "3.9 out of 4.0", "3.8 out of 4.0", "3.7 out of 4.0", "Below 3.0 out of 4.0"];
    expect(value(ask("GPA (Graduate)*", { options: gpa }))).toBe("Other/Not Applicable");
    expect(value(ask("GPA (Undergraduate)*", { options: gpa }))).toBe("3.7 out of 4.0");
    const sat = ["Did not take/Do not recall", "1600 out of 1600", "1590 out of 1600", "1580 out of 1600"];
    expect(value(ask("SAT Score*", { options: sat }))).toBe("Did not take/Do not recall");
  });
});

describe("Astranis on Greenhouse", () => {
  it("export-control status: 'None of the above.' for an applicant not authorized in the US", () => {
    const opts = ["I am a U.S. Citizen.", "I am a lawful permanent resident of the U.S. and Green Card Holder.", "I am a refugee under 8 U.S.C. 1157.", "I am an asylee under 8 U.S.C. 1158.", "None of the above."];
    expect(value(ask("Astranis complies with U.S. Government space technology export regulations, therefore will you state which of the following applies to you:*", { options: opts }))).toBe("None of the above.");
  });
  it("'When are you able to join … as an intern?' is the start date", () => {
    expect(value(ask("When are you able to join Astranis as an intern? (12 week minimum)*"))).toBe("05/03/2027");
  });
  it("a confirmation whose only option is the season", () => {
    expect(value(ask("Please confirm the season you are applying for. *", { options: ["Summer 2027"] }))).toBe("Summer 2027");
  });
});

describe("channels, acknowledgements, opt-outs", () => {
  it("'how you heard' and 'how did you connect' are the channel question", () => {
    const palantir = ["Please select one...", "Agency or Non-Palantir Recruiter", "America's Job Exchange", "BuiltIn", "Campus Ambassador", "Friend or Family", "Glassdoor", "Hackajob", "Hallo", "Handshake", "Job Board (Indeed, Monster, etc.)", "LinkedIn", "Palantir Event", "Palantir Medium Blog", "Palantir Recruiter", "Palantir Website", "Rewriting the Code", "Tapia", "University Job Board", "University or University Organization"];
    const q = "Please tell us how you heard about this internship opportunity.✱";
    expect(value(ask(q, { options: palantir }))).toBe("LinkedIn");
    expect(value(ask(q, { options: palantir }, SPARSE_CANADIAN))).toBe("Job Board (Indeed, Monster, etc.)");
    expect(value(ask("How did you connect with us?*", { controlType: "combobox", kind: "choice" }))).toBe("LinkedIn");
  });
  it("an unlabeled list of channels is the channel question (Hermeus on Lever)", () => {
    const opts = ["Company Website", "LinkedIn", "YouTube", "X (formerly Twitter)", "University – Career Services", "Facebook", "Glassdoor", "Indeed", "Built In", "Event – Recruiting", "Event – Industry", "Referral", "Recruiter Outreach", "HyTech - Fall 2026", "PDK Airshow 2026"];
    expect(value(ask("Select One✱", { options: opts, controlType: "radioGroup" }))).toBe("LinkedIn");
  });
  it("a required list whose only option acknowledges (Anthropic's arbitration agreement)", () => {
    expect(value(ask("Please read the arbitration agreement below*", { options: ["I will read the arbitration agreement below."] }))).toBe("I will read the arbitration agreement below.");
    const agree = "I understand and agree to the terms of the Agreement to Arbitrate set forth above.";
    expect(value(ask("Agreement to Arbitrate*", { options: [agree] }))).toBe(agree);
  });
  it("a titled policy with Yes / No is consent (Anthropic 'AI Policy for Application')", () => {
    expect(value(ask("AI Policy for Application*", { options: YES_NO }))).toBe("Yes");
  });
  it("SMS consent asked by its options under a 'Phone' label is declined (Ramp on Ashby)", () => {
    const opts = ["Yes - I consent to receiving text messages", "No - I do not consent to receiving text messages"];
    expect(value(ask("Phone", { options: opts, controlType: "radioGroup" }))).toBe(opts[1]);
  });
  it("the unencumbered 'No' typed into a text box", () => {
    expect(value(ask("*Were you referred to this job by a Mindex employee? If so, who?"))).toBe("No");
    expect(value(ask("Do you have a family member/relative that currently works at ActioNet?"))).toBe("No");
  });
});

describe("Palantir on Lever", () => {
  it("languages, check all that apply: the profile's, any level but a beginner's", () => {
    const opts = ["English (ENG)", "Spanish (SPA)", "French (FRA)", "German (DEU)", "Japanese (JPN)", "Choose not to disclose", "Other"];
    const p = { ...COMPLETE, languages: "English (Native), French (Professional), Spanish (Basic)" };
    expect(value(ask("Language Skill(s) (Check all that apply)✱", { options: opts, controlType: "checkboxGroup", kind: "multiChoice" }, p))).toBe("English (ENG), French (FRA)");
  });
});

describe("gender identity asked three ways (fieldResolver)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_TODAY);
  });
  afterAll(() => {
    restore();
    vi.useRealTimers();
  });
  const radios = (label: string, name: string, options: string[]) =>
    `<fieldset><legend>${label}</legend>${options.map((o, i) => `<label><input type="radio" name="${name}" value="${i}">${o}</label>`).join("")}</fieldset>`;
  const scan = (html: string) => {
    document.body.innerHTML = `<form>${html}</form>`;
    return scanPage(COMPLETE, false, null).fields;
  };

  it("'Do you identify as transgender?' is No for a cisgender identity (Ashby)", () => {
    const f = scan(radios("Do you identify as transgender?", "t", ["Yes", "No", "I don't wish to answer"]));
    expect(f[0].proposedValue).toBe("No");
  });
  it("an LGBTQ+ question is not answered from the gender identity", () => {
    const f = scan(radios("Do you identify as a member of the LGBTQ+ Community?", "l", ["Yes", "No", "Prefer not to disclose"]));
    expect(f[0].proposedValue).not.toBe("No");
  });
  it("plain gender options take the gender answer (PointClickCare on Lever)", () => {
    const f = scan(radios("Gender Identity", "g", ["Female", "Male", "Gender non-binary", "Not Listed", "Prefer not to disclose"]));
    expect(f[0].proposedValue).toBe("Female");
  });
  it("the disability form's signature date is today (Lever names it eeo[disabilitySignatureDate] under a bare 'Date')", () => {
    const f = scan(`<div class="application-question"><div class="application-label">Date</div><input type="text" name="eeo[disabilitySignatureDate]"></div>`);
    expect(f[0].category).toBe("signatureDate");
    expect(f[0].proposedValue).toBe("10/03/2026"); // TEST_TODAY
    // A bare "Date" with nothing saying it is a signature's stays as it was.
    const g = scan(`<label for="d">Date</label><input id="d" type="text">`);
    expect(g[0]?.category ?? "unknown").not.toBe("signatureDate");
  });

  it("a major the list does not carry is 'Other', never a sibling (Palantir on Lever)", () => {
    const opts = ["Select...", "Computer Science", "Computer Engineering", "Applied Mathematics", "Physics", "Economics", "Cognitive Science", "Information Science", "Data Science", "Data Engineering", "Other"];
    const f = scan(`<label for="m">What is your major? Please choose the closest response, and the one closer to the top of the list if you are double majoring.</label><select id="m">${opts.map((o) => `<option>${o}</option>`).join("")}</select>`);
    expect(f[0].proposedValue).toBe("Other");
  });

  it("qualified options need identity AND gender: never 'Cisgender man' for a cisgender woman", () => {
    const f = scan(radios("What is your gender identity?", "q", ["Cisgender man", "Cisgender woman", "Transgender man", "Transgender woman", "Non-binary", "I don't wish to answer"]));
    expect(f[0].proposedValue).toBe("Cisgender woman");
  });
});

describe("fresh postings, blind round (2026-10-03): wrong writes", () => {
  it("'enrolled in a PhD program' is No for a bachelor's student (Neighbor on Lever answered Yes)", () => {
    expect(value(ask("Are you currently enrolled in a PhD program, completing by May of 2028?✱", { options: YES_NO }))).toBe("No");
    expect(value(ask("Are you currently an advanced PhD candidate (or equivalent research stage)?", { options: YES_NO }))).toBe("No");
  });
  it("'any impediments to traveling internationally?' is No (Veeva answered Yes)", () => {
    expect(value(ask("Do you have any impediments to traveling internationally?✱", { options: YES_NO }))).toBe("No");
  });
  it("'under 2 years' holds for 1.4 years: the GPA, never 'I have more than 2 years' (Veeva)", () => {
    const opts = ["3.7 - 4.0", "3.3 - 3.69", "3.0 - 3.29", "2.7 - 2.99", "< 2.7", "N/A - I have more than 2 years of professional experience"];
    expect(value(ask("If you have under 2 years of related professional experience, please provide your GPA.", { options: opts }))).toBe("3.7 - 4.0");
  });
  it("'1–2 years of experience' is met from 1 year (FSSI on Workable answered NO; label as captured, truncated)", () => {
    expect(value(ask("1–2 years of experience in software engineering, full stack application development", { options: ["YES", "NO"], kind: "boolean" }))).toBe("YES");
  });
  it("a yes/no US-citizenship requirement is No for an applicant not authorized in the US, never 'Canada' (Striveworks)", () => {
    const q = "Due to the nature of this role, this role requires US citizenship and eligibility to obtain a US security clearance (Secret or above), do you meet that requirement?*";
    expect(value(ask(q, { controlType: "combobox", kind: "choice" }))).toBe("No");
  });
  it("school, program and graduation month together, not '2027' (Arc'teryx on Lever)", () => {
    const q = "Please indicate your school, program/faculty, and expected month/year of graduation✱";
    expect(value(ask(q, { controlType: "textarea", kind: "longText" }))).toBe(
      "University of Waterloo, Bachelor of Applied Science in Mechatronics Engineering, expected graduation April 2027"
    );
  });
});

describe("fresh postings, blind round (2026-10-03): blanks the profile answers", () => {
  it("authorized to work 'in the country that you are located' is the applicant's own country (Netlify)", () => {
    expect(value(ask("Are you legally authorized to work in the country that you are located?", { controlType: "combobox", kind: "choice" }, COMPLETE, { jobCountry: null, company: "" }))).toBe("Yes");
  });
  it("'at least 18 years or older' (Commvault)", () => {
    expect(value(ask("Are you at least 18 years or older?", { options: YES_NO }, { ...COMPLETE, dateOfBirth: "2004-02-11" }))).toBe("Yes");
  });
  it("'previously worked for this organization' with the company unnamed: No (Commvault)", () => {
    expect(value(ask("Have you previously worked for this organization", { options: YES_NO }))).toBe("No");
  });
  it("'How did you first hear about …' (Planet)", () => {
    expect(value(ask("How did you first hear about Planet before applying for this position?", { controlType: "combobox", kind: "choice" }))).toBe("LinkedIn");
  });
  it("channel options under 'how candidates find us' (Grow Therapy on Ashby; options as captured, truncated)", () => {
    const opts = ["Social media ad (M", "LinkedIn", "Job board (Indeed,", "Grow website/caree", "Grow Engineering B", "Referral from a fr"];
    expect(value(ask("This helps us understand how candidates find us and does not affect your application", { options: opts, controlType: "radioGroup" }))).toBe("LinkedIn");
  });
  it("a preferred start date among offered dates: the earliest start (The Exploration Company)", () => {
    expect(value(ask("If selected for the internship, what would be your preferred start date?", { options: ["May 3, 2027", "May 17, 2027", "June 1, 2027"] }))).toBe("May 3, 2027");
  });
  it("'living in the US or Canada?' and the time zone, from where the applicant lives (Veeva)", () => {
    expect(value(ask("Are you currently living in the US or Canada?✱", { options: ["USA", "Canada"] }))).toBe("Canada");
    expect(value(ask("Which timezone are you currently located in?✱", { options: ["PST", "MST", "CST", "EST"] }))).toBe("EST");
  });
  it("'consent to communication via text?' is the SMS opt-in: No (FSSI)", () => {
    expect(value(ask("Do you consent to communication via text?", { options: ["YES", "NO"], kind: "boolean" }))).toBe("NO");
  });
});

describe("fresh postings, blind round: scan-level (2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  const scan = (html: string) => {
    document.body.innerHTML = `<form>${html}</form>`;
    return scanPage(COMPLETE, false, null).fields;
  };

  it("'Preferred first and last name' is the full name, not the last name (Voldex on Ashby got 'Tremblay')", () => {
    const f = scan(`<label for="n">Preferred first and last name</label><input id="n" type="text">`);
    expect(f[0].category).toBe("fullName");
    expect(f[0].proposedValue).toBe("Maya Tremblay");
  });

  it("Veeva's acknowledgement and future-roles boxes are ticked", () => {
    const ack = scan(`<label><input type="checkbox" name="a"> I understand that next steps will be sent via email and I have marked the sender as safe.</label>`);
    expect(ack[0].proposedValue).toBe("yes");
    const future = scan(`<label><input type="checkbox" name="b"> Yes, Veeva Systems can contact me about future job opportunities for up to 2 years.</label>`);
    expect(future[0].proposedValue).toBe("yes");
  });

  it("the form's own work-authorization questions imply the job's country when the page states none (RAVE on Workable)", async () => {
    const { formCountryHint } = await import("../src/content/questionResolver");
    expect(formCountryHint(["Are you authorized to work in the US?", "Will you now, or in the future require sponsorship to be employed at RAVE?", "Are you able to work onsite in Laramie, WY?"])).toBe("US");
    expect(formCountryHint(["Are you legally authorized to work in Canada?", "Are you legally authorized to work in the United States?"])).toBeNull();
    expect(formCountryHint(["Where are you located?", "Are you willing to relocate to Canada?"])).toBeNull();
  });
});

describe("the education summary answers only compound questions (2026-10-03)", () => {
  it("'What school … / did you graduate from?' is the school alone (ZipRecruiter got school + graduation)", () => {
    expect(value(ask("What school are you currently attending / did you graduate from?", { kind: "text" }))).toBe("University of Waterloo");
  });
});

describe("default rules that must not over-reach (2026-10-03)", () => {
  it("a lone 'Yes' option is not an acknowledgement unless the question asks to confirm", () => {
    expect(value(ask("Have you applied to this company before?", { options: ["Yes"] }))).not.toBe("Yes");
    expect(value(ask("Please confirm you have read the job description", { options: ["Yes"] }))).toBe("Yes");
  });
  it("'Professional Certification' with Yes/No asks whether you hold one: never consent", () => {
    expect(value(ask("Professional Certification", { options: YES_NO }))).not.toBe("Yes");
  });
  it("an obstacle ruled out by the question is not an obstacle question", () => {
    expect(value(ask("Do you have the ability to travel with no restrictions?", { options: YES_NO }))).not.toBe("No");
  });
});

describe("start-time spans and demographic synonyms (2026-10-03, second pass)", () => {
  const STRIVE = ["Immediately", "2 to 4 weeks from offer acceptance", "4-8 weeks from offer acceptance", "8-12 weeks from offer acceptance", "12+ weeks from offer acceptance"];
  it("the span holding the days until the earliest start (Agiloft 'Availability?', Striveworks)", () => {
    expect(value(ask("Availability?✱", { options: ["Immediately", "Two weeks from offer", "Over a month from offer"], controlType: "checkboxGroup", kind: "multiChoice" }))).toBe("Over a month from offer");
    const q = "What is your earliest available start date for full-time employment in this role?*";
    expect(value(ask(q, { options: STRIVE }))).toBe("12+ weeks from offer acceptance");
    // 17 days out: "2 to 4 weeks". The old matcher read the date's year (2026) as a number: "12+ weeks".
    expect(value(ask(q, { options: STRIVE }, { ...COMPLETE, earliestStartDate: "2026-10-20" }))).toBe("2 to 4 weeks from offer acceptance");
  });
  it("a date is never placed in numeric buckets by its digits", async () => {
    const { matchOption } = await import("../src/content/optionMatch");
    expect(matchOption(STRIVE, (o) => o, (o) => o, "2026-10-20")).toBeNull();
  });
});

describe("demographic synonyms at scan time (Ashby gender checkboxes, live 2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  it("'Female' ticks 'Woman' among Man / Woman / Non-binary", () => {
    const opts = ["Man", "Woman", "Non-binary", "I prefer to self-describe", "I don't wish to answer"];
    document.body.innerHTML = `<form><fieldset><legend>Gender identity</legend>${opts
      .map((o, i) => `<label><input type="checkbox" name="g" value="${i}">${o}</label>`)
      .join("")}</fieldset></form>`;
    const f = scanPage(COMPLETE, false, null).fields;
    expect(f[0].proposedValue).toBe("Woman");
  });
});

describe("a stated channel offered several ways (Planet on Greenhouse, live 2026-10-03)", () => {
  it("LinkedIn among Company Post / Employee Post / Job Search: the job search", () => {
    const opts = ["BuiltIn Article", "BuiltIn Job Search", "Conference", "Event", "Glassdoor Article", "Glassdoor Job Search", "Indeed", "Instagram", "LinkedIn Company Post", "LinkedIn Employee Post", "LinkedIn Job Search", "News Article", "Other - Event", "Other - Job Site", "Other - Social Media", "Other - Webinar", "Otta", "Planet Event", "Planet Webinar"];
    expect(value(ask("How did you first hear about Planet before applying for this position?", { options: opts }))).toBe("LinkedIn Job Search");
  });
});

describe("one checkbox per demographic option (Superhuman on Ashby, live 2026-10-03)", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = stubLayout();
  });
  afterAll(() => restore());
  // Verbatim structure: each box is its own control, NAMED after its option.
  const OPTS = ["Man", "Woman", "Non-binary", "I prefer to self-describe", "I don't wish to answer"];
  const FIELDSET = `<fieldset><label for="gh_quest_8662">How would you describe your gender identity? (mark all that apply)</label>${OPTS
    .map((o, i) => `<div><span data-disabled="false"><input type="checkbox" id="U_gh_quest_8662-labeled-checkbox-${i}" name="${o}"></span><label for="U_gh_quest_8662-labeled-checkbox-${i}">${o}</label></div>`)
    .join("")}</fieldset>`;
  it("the fieldset is one group proposing 'Woman' for a Female profile whose identity is Cisgender", () => {
    // It stayed blank before the demographic synonyms applied at scan time; with
    // them it was ticked live (results/final-1).
    document.body.innerHTML = `<form>${FIELDSET}</form>`;
    const fields = scanPage(COMPLETE, false, null).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].controlType).toBe("checkboxGroup");
    expect(fields[0].proposedValue).toBe("Woman");
  });
});
