import { describe, it, expect } from "vitest";
import {
  answersWorthRemembering,
  planAnswerSaves,
  selectAnswerGaps,
  MAX_GAPS,
} from "../src/content/answerGaps";
import type { AnswerGap } from "../src/content/answerGaps";
import type { ControlType, DetectedField, FieldCategory } from "../src/shared/types";

let seq = 0;
function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    id: `f${seq++}`,
    category: "unknown" as FieldCategory,
    confidence: 0,
    label: "Are you willing to relocate?",
    controlType: "select" as ControlType,
    required: false,
    proposedValue: null,
    fillable: true,
    sensitive: false,
    options: ["Yes", "No"],
    ...over,
  };
}

const NO_JOB = { company: null, jobTitle: null };

describe("selectAnswerGaps, candidacy", () => {
  it("asks about an unanswered dropdown", () => {
    expect(selectAnswerGaps([field()], NO_JOB)).toHaveLength(1);
  });

  // Was: "skips a field autofill already answered". A proposed value is a plan,
  // not an outcome, gating on it hid every field whose write missed, which is
  // exactly when the user needs to be asked (BMO gender identity / military
  // service, 2026-08-09). What proves a field is answered is the PAGE holding a
  // value, which the next test pins.
  it("asks again when the proposed answer never landed on the page", () => {
    expect(selectAnswerGaps([field({ proposedValue: "Yes" })], NO_JOB)).toHaveLength(1);
  });

  it("skips a field autofill answered and actually wrote", () => {
    expect(
      selectAnswerGaps([field({ proposedValue: "Yes", currentValue: "Yes" })], NO_JOB)
    ).toEqual([]);
  });

  it("skips a field the page already has a value in", () => {
    expect(selectAnswerGaps([field({ currentValue: "No" })], NO_JOB)).toEqual([]);
  });

  it("treats a whitespace-only current value as empty", () => {
    expect(selectAnswerGaps([field({ currentValue: "   " })], NO_JOB)).toHaveLength(1);
  });

  it("skips fields the engine cannot write", () => {
    expect(selectAnswerGaps([field({ fillable: false })], NO_JOB)).toEqual([]);
  });

  it("skips file uploads and signup passwords", () => {
    const fields = [
      field({ controlType: "file", label: "Resume" }),
      field({ controlType: "password", label: "Password" }),
    ];
    expect(selectAnswerGaps(fields, NO_JOB)).toEqual([]);
  });

  it("skips a field with no usable label", () => {
    expect(selectAnswerGaps([field({ label: "  " })], NO_JOB)).toEqual([]);
  });
});

describe("selectAnswerGaps, askable-looking only", () => {
  const constrained: ControlType[] = [
    "select",
    "radioGroup",
    "checkboxGroup",
    "combobox",
    "ariaRadioGroup",
    "customDropdown",
    "checkbox",
  ];

  it.each(constrained)("always asks about a %s", (controlType) => {
    expect(selectAnswerGaps([field({ controlType })], NO_JOB)).toHaveLength(1);
  });

  it("asks about a short generic text question", () => {
    const f = field({ controlType: "text", label: "Years of experience with Python", options: [] });
    expect(selectAnswerGaps([f], NO_JOB)).toHaveLength(1);
  });

  it("never asks about a textarea, the essay compose path owns those", () => {
    const f = field({ controlType: "textarea", label: "Additional information", options: [] });
    expect(selectAnswerGaps([f], NO_JOB)).toEqual([]);
  });

  it.each([
    "Why do you want to work here?",
    "Describe a time you led a team",
    "Tell us about yourself",
    "Explain your interest in this field",
    "In your own words, what motivates you?",
  ])("skips the essay-shaped text question %j", (label) => {
    expect(selectAnswerGaps([field({ controlType: "text", label, options: [] })], NO_JOB)).toEqual(
      []
    );
  });

  it("skips a text question too long to be a short prompt", () => {
    const label = "Please provide a summary of ".repeat(5);
    expect(selectAnswerGaps([field({ controlType: "text", label, options: [] })], NO_JOB)).toEqual(
      []
    );
  });

  it("still asks about an essay-worded DROPDOWN, the options make it answerable", () => {
    const f = field({ controlType: "select", label: "Why are you leaving your current role?" });
    expect(selectAnswerGaps([f], NO_JOB)).toHaveLength(1);
  });
});

// A one-off question (one naming this employer or role) is asked like any
// other, because the form still needs it filled. Dropping it from the modal
// outright (the previous behavior) left a required question with no way to
// answer it: BMO's "…that would continue after obtaining employment with BMO
// Financial Group?" was silently absent from the modal on 2026-08-09.
describe("selectAnswerGaps, one-off questions", () => {
  const job = { company: "Acme Corp", jobTitle: "Software Engineer" };

  it("asks a question naming this company, marked one-off", () => {
    const f = field({ label: "Have you applied to Acme Corp before?" });
    const [gap] = selectAnswerGaps([f], job);
    expect(gap.question).toBe("Have you applied to Acme Corp before?");
    expect(gap.oneOff).toBe(true);
  });

  it("marks a question naming this job title one-off", () => {
    const f = field({ label: "Why this Software Engineer role?" });
    expect(selectAnswerGaps([f], job)[0].oneOff).toBe(true);
  });

  it("marks it one-off when the help text (not the label) names the company", () => {
    const f = field({ label: "How did you hear about us?", helpText: "Acme Corp uses this to..." });
    expect(selectAnswerGaps([f], job)[0].oneOff).toBe(true);
  });

  it("keeps a generic question on a page that has a company, and does not mark it", () => {
    const gaps = selectAnswerGaps([field()], job);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].oneOff).toBe(false);
  });

  it("ignores a company name too short to match safely", () => {
    const f = field({ label: "Do you have a driver's license?" });
    expect(selectAnswerGaps([f], { company: "Hi", jobTitle: null })).toHaveLength(1);
  });
});

describe("selectAnswerGaps, shape of the result", () => {
  it("dedupes repeated questions by normalized label, keeping the first", () => {
    const a = field({ id: "a", label: "Are you willing to relocate?" });
    const b = field({ id: "b", label: "Are you  willing to Relocate? " });
    const gaps = selectAnswerGaps([a, b], NO_JOB);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].fieldId).toBe("a");
  });

  it("caps the list so the modal is never a wall of questions", () => {
    const many = Array.from({ length: MAX_GAPS + 5 }, (_, i) =>
      field({ label: `Screening question ${i}` })
    );
    expect(selectAnswerGaps(many, NO_JOB)).toHaveLength(MAX_GAPS);
  });

  it("carries the page's own options and flags through to the modal", () => {
    const f = field({
      label: "Do you require sponsorship?",
      options: ["Yes", "No", "Prefer not to say"],
      required: true,
      sensitive: true,
      category: "sponsorship" as FieldCategory,
      helpText: "Visa status",
      inputType: "text",
    });
    expect(selectAnswerGaps([f], NO_JOB)[0]).toMatchObject({
      question: "Do you require sponsorship?",
      options: ["Yes", "No", "Prefer not to say"],
      required: true,
      sensitive: true,
      category: "sponsorship",
      helpText: "Visa status",
      controlType: "select",
    });
  });

  it("returns an empty list for an empty scan", () => {
    expect(selectAnswerGaps([], NO_JOB)).toEqual([]);
  });
});

// ─── Persistence routing ─────────────────────────────────────────────────────

const gap = (over: Partial<AnswerGap> = {}): AnswerGap => ({
  fieldId: "f",
  question: "Are you willing to relocate?",
  controlType: "select",
  category: "unknown" as FieldCategory,
  options: ["Yes", "No"],
  required: false,
  sensitive: false,
  ...over,
});

/**
 * There is exactly ONE sink left: the user's Tailrd profile. Everything else the
 * modal asks is filled into this page and persisted nowhere, the cross-
 * application answer bank and the device-local sensitive store are both gone.
 */
describe("planAnswerSaves, only profile-slot answers persist", () => {
  it("persists nothing for a question with no profile slot", () => {
    const plan = planAnswerSaves([{ gap: gap(), value: "Yes" }]);
    expect(plan).toEqual({ profilePatch: {} });
  });

  it("sends a profile-slot category to the profile", () => {
    const plan = planAnswerSaves([
      { gap: gap({ category: "linkedin" as FieldCategory, controlType: "text" }), value: "u/me" },
    ]);
    expect(plan.profilePatch).toEqual({ linkedin: "u/me" });
  });

  it("persists nothing for a sensitive answer with no profile slot", () => {
    // eeoOther is the leftover demographic bucket (transgender / LGBTQ /
    // generic "demographic" prompts). Gender identity, pronouns and sexual
    // orientation moved OUT of it into real profile slots, see below.
    const g = gap({
      category: "eeoOther" as FieldCategory,
      question: "Do you identify as transgender?",
      sensitive: true,
    });
    const plan = planAnswerSaves([{ gap: g, value: "Prefer not to say" }]);
    expect(plan).toEqual({ profilePatch: {} });
  });

  it("still persists the five standard EEO answers to the profile", () => {
    const g = gap({ category: "eeoGender" as FieldCategory, question: "Gender", sensitive: true });
    const plan = planAnswerSaves([{ gap: g, value: "Man" }]);
    expect(plan.profilePatch.eeo).toEqual({ gender: "Man" });
  });

  it("persists the three demographics added by the parity contract", () => {
    const answer = (category: string, value: string) =>
      planAnswerSaves([
        { gap: gap({ category: category as FieldCategory, sensitive: true }), value },
      ]).profilePatch.eeo;
    expect(answer("eeoGenderIdentity", "Non-binary")).toEqual({ genderIdentity: "Non-binary" });
    expect(answer("eeoPronouns", "They/Them")).toEqual({ pronouns: "They/Them" });
    expect(answer("eeoSexualOrientation", "Bisexual")).toEqual({ sexualOrientation: "Bisexual" });
  });

  it("merges several profile answers into one patch", () => {
    const plan = planAnswerSaves([
      { gap: gap({ category: "phone" as FieldCategory }), value: "555" },
      { gap: gap({ category: "country" as FieldCategory }), value: "Canada" },
    ]);
    expect(plan.profilePatch).toEqual({ phone: "555", country: "Canada" });
  });

  it("drops blank and whitespace-only answers", () => {
    const plan = planAnswerSaves([
      { gap: gap(), value: "   " },
      { gap: gap({ category: "phone" as FieldCategory }), value: "" },
      { gap: gap({ sensitive: true }), value: " " },
    ]);
    expect(plan).toEqual({ profilePatch: {} });
  });

  it("trims the stored answer", () => {
    const plan = planAnswerSaves([
      { gap: gap({ category: "phone" as FieldCategory }), value: "  555  " },
    ]);
    expect(plan.profilePatch).toEqual({ phone: "555" });
  });

  /**
   * A profile slot is keyed by CATEGORY, never by the form's label, which is
   * why the removed "is this label a real question?" guard is not needed here.
   * An id-shaped label still reaches the right profile field.
   */
  it("saves to the profile even when the form named the field with a widget id", () => {
    const plan = planAnswerSaves([
      {
        gap: gap({
          category: "phone" as FieldCategory,
          question: "b0531cc2ff371001d8a97c876e680000-b0531cc2ff371001d8a9b9c2eef00002",
        }),
        value: "555",
      },
    ]);
    expect(plan.profilePatch).toEqual({ phone: "555" });
  });
});

/**
 * Persistence must not outlive a failed write, but only where the failure
 * proves the answer itself is unusable.
 *
 * A value saved into a profile slot is replayed on every future form, so storing
 * one the widget rejects means the user is never asked again and never sees why.
 * The count of what was dropped is also what the panel's banner reports.
 */
describe("answersWorthRemembering", () => {
  const ok = (...ids: string[]) => new Set(ids);

  it("keeps everything the page accepted", () => {
    const answers = [
      { gap: gap({ fieldId: "a", controlType: "combobox", options: [] }), value: "Canada" },
      { gap: gap({ fieldId: "b", controlType: "text", options: [] }), value: "Ottawa" },
    ];
    expect(answersWorthRemembering(answers, ok("a", "b"))).toEqual(answers);
  });

  it("drops a failed answer typed blind into an option-less dropdown", () => {
    const answers = [{ gap: gap({ fieldId: "a", controlType: "combobox", options: [] }), value: "Yes" }];
    expect(answersWorthRemembering(answers, ok())).toEqual([]);
  });

  it("KEEPS a failed free-text answer, the write failed, the answer did not", () => {
    const answers = [{ gap: gap({ fieldId: "a", controlType: "text", options: [] }), value: "Ottawa" }];
    expect(answersWorthRemembering(answers, ok())).toEqual(answers);
  });

  it("keeps a failed answer picked from options the page itself listed", () => {
    const answers = [{ gap: gap({ fieldId: "a", controlType: "select", options: ["Yes", "No"] }), value: "Yes" }];
    expect(answersWorthRemembering(answers, ok())).toEqual(answers);
  });

  it("keeps a failed bare-checkbox answer, Yes/No is a value the widget knows", () => {
    const answers = [{ gap: gap({ fieldId: "a", controlType: "checkbox", options: [] }), value: "Yes" }];
    expect(answersWorthRemembering(answers, ok())).toEqual(answers);
  });

  it("treats a field missing from the outcomes as a failure", () => {
    const answers = [{ gap: gap({ fieldId: "ghost", controlType: "combobox", options: [] }), value: "Yes" }];
    expect(answersWorthRemembering(answers, ok("someone-else"))).toEqual([]);
  });

  it("judges each answer on its own", () => {
    const good = { gap: gap({ fieldId: "a", controlType: "combobox", options: [] }), value: "Canada" };
    const bad = { gap: gap({ fieldId: "b", controlType: "customDropdown", options: [] }), value: "Nope" };
    const free = { gap: gap({ fieldId: "c", controlType: "text", options: [] }), value: "Ottawa" };
    expect(answersWorthRemembering([good, bad, free], ok("a"))).toEqual([good, free]);
  });

  it("does not mutate the answers it was given", () => {
    const answers = [{ gap: gap({ fieldId: "a", controlType: "combobox", options: [] }), value: "Yes" }];
    answersWorthRemembering(answers, ok());
    expect(answers.length).toBe(1);
  });
});

describe("selectAnswerGaps, fields the page reverted", () => {
  it("asks again about a field the framework reset after the write verified", () => {
    // "Has a value" is not "has the right value". A control the site reset to
    // its own default holds something nobody chose, and the emptiness test
    // alone would skip it forever, which is exactly the case a per-write
    // verification cannot see, because the reset happened after it passed.
    const f = field({ currentValue: "Select One" });
    expect(selectAnswerGaps([f], NO_JOB)).toHaveLength(0);
    expect(selectAnswerGaps([f], NO_JOB, new Set([f.id]))).toHaveLength(1);
  });

  it("leaves a field alone when the page holds what was written", () => {
    const f = field({ currentValue: "Yes" });
    expect(selectAnswerGaps([f], NO_JOB, new Set(["some-other-field"]))).toHaveLength(0);
  });

  it("still respects everything else about candidacy", () => {
    // A reverted field that is not askable is still not worth asking about.
    const f = field({ currentValue: "x", controlType: "file" as ControlType });
    expect(selectAnswerGaps([f], NO_JOB, new Set([f.id]))).toHaveLength(0);
  });
});
