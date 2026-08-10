// chrome-extension/test/gapsAfterFailedFill.test.ts
/**
 * Regression: the gap modal asked about what the PLANNER had no answer for,
 * not about what the PAGE still has blank. A field we proposed a value for was
 * never offered again, even when the write missed and the control stayed empty.
 *
 * Reproduced from the BMO Workday questionnaire (screenshot 14:21 UTC
 * 2026-08-09, `saved_answers` 41-45 from the 14:14:32 modal save). Of eleven
 * questions the modal offered seven; the two the user complained about were the
 * two the planner HAD answered:
 *
 *   "What is your gender identity?"            → proposed "Male"
 *   "Have you ever had any Canadian military service?"
 *                                              → proposed "I am not a protected veteran"
 *
 * Both writes missed: the second cannot even be written, since the widget
 * offers only Yes/No, and both dropdowns were still on "Select One" in the
 * screenshot. Neither was ever offered, so there was no way to answer them.
 *
 * The third case is the long "…with BMO Financial Group…" question: naming the
 * employer made it one-off, and a one-off question was dropped from the modal
 * entirely rather than merely asked-and-not-persisted.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { selectAnswerGaps, planAnswerSaves } from "../src/content/answerGaps";
import type { UserApplicationProfile } from "../src/shared/types";
import { stubLayout } from "./helpers/layout";

const restoreLayout = stubLayout();
afterAll(restoreLayout);

beforeEach(() => {
  document.body.innerHTML = "";
});

const PROFILE = {
  firstName: "W", lastName: "E", email: "a@b.c", phone: "1", location: "Toronto",
  addressStreet: "", addressCity: "Toronto", addressState: "ON", postalCode: "M1M 1M1",
  country: "Canada", linkedin: "", github: "", portfolio: "", currentCompany: "",
  currentTitle: "", workAuthorization: "", requiresSponsorship: "", education: [],
  experience: [], skills: [], coverLetter: "",
  eeo: { gender: "Male", veteranStatus: "I am not a protected veteran" },
} as unknown as UserApplicationProfile;

/** A Workday prompt, as the questionnaire renders it. `display` is what the
 *  button shows, "Select One" when nothing is committed. */
function prompt(question: string, display = "Select One"): string {
  const wid = `w${question.length}`;
  return `
    <div data-automation-id="formField-${wid}" data-fkit-id="${wid}">
      <label><span>${question}<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><div>
        <button aria-haspopup="listbox" type="button" aria-label="Select One Required"
                aria-required="true" name="${wid}" id="${wid}">${display}</button>
      </div></div></div>
    </div>`;
}

const questionsOffered = (job: Parameters<typeof selectAnswerGaps>[1] = {}): string[] => {
  const { fields } = scanPage(PROFILE, true);
  return selectAnswerGaps(fields, job).map((g) => g.question);
};

describe("gap modal asks about what the page still has blank", () => {
  it("offers a field whose proposed answer never made it onto the page", () => {
    // "Male" IS proposed for this one, and the widget still shows "Select One".
    document.body.innerHTML = prompt("What is your gender identity?");
    expect(questionsOffered()).toContain("What is your gender identity?");
  });

  it("offers the military question, whose profile value no Yes/No widget can take", () => {
    document.body.innerHTML = prompt("Have you ever had any Canadian military service?");
    expect(questionsOffered()).toContain("Have you ever had any Canadian military service?");
  });

  it("does NOT offer a prompt the fill actually committed", () => {
    // Same field, but the widget now displays a committed value.
    document.body.innerHTML = prompt("What is your gender identity?", "Male");
    expect(questionsOffered()).toEqual([]);
  });

  it("still treats the unset placeholder as blank, whatever it is worded as", () => {
    document.body.innerHTML = prompt("What is your gender identity?", "Select one...");
    expect(questionsOffered()).toContain("What is your gender identity?");
  });
});

describe("one-off questions are asked, and persist nowhere", () => {
  const LONG_Q =
    "Are you presently involved in any outside activities that would continue " +
    "after obtaining employment with BMO Financial Group?";

  it("offers a question that names the employer", () => {
    document.body.innerHTML = prompt(LONG_Q);
    expect(questionsOffered({ company: "BMO Financial Group" })).toContain(LONG_Q);
  });

  it("and persists nothing, the answer is about this application only", () => {
    document.body.innerHTML = prompt(LONG_Q);
    const { fields } = scanPage(PROFILE, true);
    const gaps = selectAnswerGaps(fields, { company: "BMO Financial Group" });
    const gap = gaps.find((g) => g.question === LONG_Q)!;

    const plan = planAnswerSaves([{ gap, value: "No" }]);
    expect(plan).toEqual({ profilePatch: {} });
  });

  it("nor does a generic screening question with no profile slot", () => {
    document.body.innerHTML = prompt("Do you hold a valid social insurance number (SIN)?");
    const { fields } = scanPage(PROFILE, true);
    const gaps = selectAnswerGaps(fields, { company: "BMO Financial Group" });
    const plan = planAnswerSaves([{ gap: gaps[0], value: "Yes" }]);
    expect(plan).toEqual({ profilePatch: {} });
  });
});
