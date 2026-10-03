/**
 * Default answers (defaultAnswers.ts): questions no profile fact settles, that
 * a typical applicant who ACCEPTS the posting's terms and is UNENCUMBERED
 * answers the same way. Labels and options are verbatim from live forms
 * (Brex on Greenhouse, 2026-10-03, unless noted).
 */
import { describe, expect, it } from "vitest";
import { profileFacts } from "../src/content/profileFacts";
import { resolveQuestion, type QuestionInput } from "../src/content/questionResolver";
import type { AnswerKind } from "../src/content/answerKind";
import type { ControlType, UserApplicationProfile } from "../src/shared/types";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

const YES_NO = ["Yes", "No"];

function ask(
  label: string,
  opts: { options?: string[]; controlType?: ControlType; kind?: AnswerKind } = {},
  profile: UserApplicationProfile = SPARSE_CANADIAN,
  ctx: { jobCountry: string | null; company: string; jobCity?: string | null } = { jobCountry: null, company: "" }
) {
  const q: QuestionInput = {
    label,
    controlType: opts.controlType ?? (opts.options ? "select" : "combobox"),
    options: opts.options,
    category: "unknown",
    kind: opts.kind ?? (opts.options && opts.options.length === 2 && opts.options[0] === "Yes" ? "boolean" : "choice"),
  };
  return resolveQuestion(q, profileFacts(profile, TEST_TODAY), profile, ctx);
}
const value = (r: ReturnType<typeof ask>) => (r && r.status === "answer" ? r.value : r?.status ?? null);
const rule = (r: ReturnType<typeof ask>) => (r ? r.rule : null);

const BREX_CONSENT =
  "Do you consent to Brex processing your personal information for the purpose of assessing your candidacy for this position in accordance with Brex’s Applicant Privacy Policy?*";
const BREX_IN_OFFICE =
  "This role requires in-office work three days per week (Mon, Wed, Thurs). Do you acknowledge and agree to this requirement?*";
const BREX_LOCATED = ["Yes, I’m currently located here", "Yes, I’d relocate prior to the start of the role", "No, I’m not located nearby"];

describe("consent the application needs", () => {
  it("is given, whether the options are known or arrive later", () => {
    expect(value(ask(BREX_CONSENT, { options: YES_NO }))).toBe("Yes");
    expect(value(ask(BREX_CONSENT))).toBe("Yes"); // react-select, options not mounted yet
    expect(rule(ask(BREX_CONSENT))).toBe("default:consent");
  });
  it("certifying the application is accurate is given too", () => {
    expect(value(ask("I certify that the information I have provided is true and complete", { options: ["I agree", "I do not agree"] }))).toBe("I agree");
  });
  it("marketing and SMS opt-ins are answered No", () => {
    expect(value(ask("By selecting YES, I consent to receive recruiting SMS messages from Astranis", { options: YES_NO }))).toBe("No");
    expect(value(ask("Would you like to receive our newsletter?", { options: YES_NO }))).toBe("No");
  });
  it("being kept on file for future roles is Yes", () => {
    expect(value(ask("Would you like to be considered for future opportunities at Twitch when a role matches your profile?", { options: YES_NO }))).toBe("Yes");
  });
  it("recording / AI-notetaker consent is a preference, never defaulted", () => {
    expect(ask("As part of our interview process, we may use AI notetakers to transcribe interviews. Do you consent?", { options: ["Yes, I consent", "No, I do not consent"] })).toBeNull();
  });
});

describe("the posting's requirements are accepted", () => {
  it("an in-office acknowledgement answered with location options: relocate unless local", () => {
    expect(value(ask(BREX_IN_OFFICE, { options: BREX_LOCATED }))).toBe("Yes, I’d relocate prior to the start of the role");
    expect(rule(ask(BREX_IN_OFFICE, { options: BREX_LOCATED }))).toBe("located:relocate-default");
  });
  it("…located here when the applicant lives in the job's city", () => {
    const r = ask(BREX_IN_OFFICE, { options: BREX_LOCATED }, SPARSE_CANADIAN, { jobCountry: "CA", company: "Brex", jobCity: "Toronto" });
    expect(value(r)).toBe("Yes, I’m currently located here");
  });
  it("…No when the applicant said they will not relocate", () => {
    const stays = { ...SPARSE_CANADIAN, willingToRelocate: "No" };
    expect(value(ask(BREX_IN_OFFICE, { options: BREX_LOCATED }, stays))).toBe("No, I’m not located nearby");
  });
  it("a Yes/No in-office question is Yes; a remote-only applicant decides themselves", () => {
    const q = "Do you currently live in, or plan to relocate to, the specified location to meet this in-office requirement?*";
    expect(value(ask(q, { options: YES_NO }))).toBe("Yes");
    expect(ask(q, { options: YES_NO }, { ...SPARSE_CANADIAN, workPreference: "Remote" })).toBeNull();
  });
  it("background checks: willing Yes, obstacles No; essential functions Yes", () => {
    expect(value(ask("Are you willing to undergo a background check?", { options: YES_NO }))).toBe("Yes");
    expect(value(ask("Do you anticipate having any challenges with clearing a background check?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Can you perform all of the essential functions of this role with or without reasonable accommodation?", { options: YES_NO }))).toBe("Yes");
  });
  it("relocation ASSISTANCE is a request, never defaulted", () => {
    expect(value(ask("Will you require relocation assistance?", { options: YES_NO }))).not.toBe("Yes");
  });
});

describe("an unencumbered applicant", () => {
  it("has not applied or interviewed before, was not referred, has no relative inside", () => {
    expect(value(ask("Have you ever interviewed at Anthropic before?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Have you previously applied to Amazon or any Amazon subsidiary?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Were you referred by a current employee?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Do you have any relatives currently employed by Robinhood?", { options: YES_NO }))).toBe("No");
  });
  it("has no conflict of interest, non-compete, or government-official role", () => {
    expect(value(ask("Do you have any conflicts of interest?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Are you subject to a non-competition agreement or other agreement that would restrict your work?", { options: YES_NO }))).toBe("No");
    expect(value(ask("Are you a current or former government official?", { options: YES_NO }))).toBe("No");
  });
  it("criminal history is never defaulted", () => {
    expect(value(ask("Have you ever been convicted of a crime?", { options: YES_NO }))).toBe("abstain");
  });
});

describe("how did you hear about us", () => {
  it("defaults to the job-board channel a Tailrd user actually used, then the careers site", () => {
    expect(value(ask("How did you hear about us?*", { options: ["LinkedIn", "Job Board (Indeed, Glassdoor, etc.)", "Referral", "Other"] }))).toBe("Job Board (Indeed, Glassdoor, etc.)");
    expect(value(ask("How did you hear about us?*", { options: ["LinkedIn", "Company Website", "Referral"] }))).toBe("Company Website");
  });
  it("uses the applicant's stated channel, mapped onto the form's words", () => {
    const p = { ...SPARSE_CANADIAN, howDidYouHear: "LinkedIn" };
    expect(value(ask("How did you hear about this job?", { options: ["Company Website", "LinkedIn", "Indeed", "Other"] }, p))).toBe("LinkedIn");
    const fair = { ...SPARSE_CANADIAN, howDidYouHear: "Career fair" };
    expect(value(ask("How did you hear about us?", { options: ["Website", "University Career Fair", "Referral"] }, fair))).toBe("University Career Fair");
  });
  it("free text gets a phrase; a lazy dropdown gets a value snapped when its options arrive", () => {
    expect(value(ask("How did you hear about us?", { controlType: "text", kind: "text" }))).toBe("Online job board");
    expect(value(ask("How did you hear about us?"))).toBe("Job board");
  });
  it("a referral follow-up is not the channel question", () => {
    expect(value(ask("If you heard about us through a referral, please state the Brex employee's name", { controlType: "text", kind: "text" }))).toBe("abstain");
  });
});
