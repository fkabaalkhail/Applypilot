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
