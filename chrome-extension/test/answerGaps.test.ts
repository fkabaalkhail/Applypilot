import { describe, it, expect } from "vitest";
import { selectAnswerGaps, planAnswerSaves, MAX_GAPS } from "../src/content/answerGaps";
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

describe("selectAnswerGaps — candidacy", () => {
  it("asks about an unanswered dropdown", () => {
    expect(selectAnswerGaps([field()], NO_JOB)).toHaveLength(1);
  });

  it("skips a field autofill already answered", () => {
    expect(selectAnswerGaps([field({ proposedValue: "Yes" })], NO_JOB)).toEqual([]);
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

describe("selectAnswerGaps — reusable-looking only", () => {
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

  it("never asks about a textarea — the essay compose path owns those", () => {
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

  it("skips a text question too long to be a reusable prompt", () => {
    const label = "Please provide a summary of ".repeat(5);
    expect(selectAnswerGaps([field({ controlType: "text", label, options: [] })], NO_JOB)).toEqual(
      []
    );
  });

  it("still asks about an essay-worded DROPDOWN — the options make it reusable", () => {
    const f = field({ controlType: "select", label: "Why are you leaving your current role?" });
    expect(selectAnswerGaps([f], NO_JOB)).toHaveLength(1);
  });
});

describe("selectAnswerGaps — one-off questions", () => {
  const job = { company: "Acme Corp", jobTitle: "Software Engineer" };

  it("skips a question naming this company", () => {
    const f = field({ label: "Have you applied to Acme Corp before?" });
    expect(selectAnswerGaps([f], job)).toEqual([]);
  });

  it("skips a question naming this job title", () => {
    const f = field({ label: "Why this Software Engineer role?" });
    expect(selectAnswerGaps([f], job)).toEqual([]);
  });

  it("skips when the help text — not the label — names the company", () => {
    const f = field({ label: "How did you hear about us?", helpText: "Acme Corp uses this to..." });
    expect(selectAnswerGaps([f], job)).toEqual([]);
  });

  it("keeps a generic question on a page that has a company", () => {
    expect(selectAnswerGaps([field()], job)).toHaveLength(1);
  });

  it("ignores a company name too short to match safely", () => {
    const f = field({ label: "Do you have a driver's license?" });
    expect(selectAnswerGaps([f], { company: "Hi", jobTitle: null })).toHaveLength(1);
  });
});

describe("selectAnswerGaps — shape of the result", () => {
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

describe("planAnswerSaves — where each answer is remembered", () => {
  it("sends a question with no profile slot to the answer bank", () => {
    const plan = planAnswerSaves([{ gap: gap(), value: "Yes" }]);
    expect(plan.profilePatch).toEqual({});
    expect(plan.local).toEqual([]);
    expect(plan.bank).toEqual([
      { question: "Are you willing to relocate?", answer: "Yes", fieldType: "select" },
    ]);
  });

  it("sends a profile-slot category to the profile, not the bank", () => {
    const plan = planAnswerSaves([
      { gap: gap({ category: "linkedin" as FieldCategory, controlType: "text" }), value: "u/me" },
    ]);
    expect(plan.profilePatch).toEqual({ linkedin: "u/me" });
    expect(plan.bank).toEqual([]);
  });

  it("keeps a sensitive answer with no profile slot on the device", () => {
    const g = gap({
      category: "eeoGenderIdentity" as FieldCategory,
      question: "Do you identify as transgender?",
      sensitive: true,
    });
    const plan = planAnswerSaves([{ gap: g, value: "Prefer not to say" }]);
    expect(plan.local).toEqual([
      { question: "Do you identify as transgender?", answer: "Prefer not to say" },
    ]);
    expect(plan.bank).toEqual([]);
    expect(plan.profilePatch).toEqual({});
  });

  it("still persists the five standard EEO answers to the profile", () => {
    const g = gap({ category: "eeoGender" as FieldCategory, question: "Gender", sensitive: true });
    const plan = planAnswerSaves([{ gap: g, value: "Man" }]);
    expect(plan.profilePatch.eeo).toEqual({ gender: "Man" });
    expect(plan.local).toEqual([]);
  });

  it("never transmits a sensitive answer, whichever bucket it misses", () => {
    const plan = planAnswerSaves([
      { gap: gap({ sensitive: true, question: "Pronouns" }), value: "they/them" },
    ]);
    expect(plan.bank).toEqual([]);
    expect(plan.local).toHaveLength(1);
  });

  it("merges several profile answers into one patch", () => {
    const plan = planAnswerSaves([
      { gap: gap({ category: "phone" as FieldCategory }), value: "555" },
      { gap: gap({ category: "country" as FieldCategory }), value: "Canada" },
    ]);
    expect(plan.profilePatch).toEqual({ phone: "555", country: "Canada" });
  });

  it("drops blank and whitespace-only answers everywhere", () => {
    const plan = planAnswerSaves([
      { gap: gap(), value: "   " },
      { gap: gap({ category: "phone" as FieldCategory }), value: "" },
      { gap: gap({ sensitive: true }), value: " " },
    ]);
    expect(plan).toEqual({ profilePatch: {}, local: [], bank: [] });
  });

  it("trims the stored answer", () => {
    const plan = planAnswerSaves([{ gap: gap(), value: "  Yes  " }]);
    expect(plan.bank[0].answer).toBe("Yes");
  });
});
