import { describe, it, expect } from "vitest";
import {
  isLongform,
  isAiCandidate,
  aiFillCandidates,
  toAiFillField,
  planAiFill,
  tallyOutcomes,
} from "../src/content/aiFillPlanner";
import type { DetectedField } from "../src/shared/types";

function field(over: Partial<DetectedField>): DetectedField {
  return {
    id: "f1",
    category: "unknown",
    confidence: 0.2,
    label: "Question",
    controlType: "text",
    required: false,
    proposedValue: null,
    fillable: true,
    sensitive: false,
    ...over,
  };
}

describe("isLongform", () => {
  it("is true for textareas and contenteditable", () => {
    expect(isLongform(field({ controlType: "textarea" }))).toBe(true);
    expect(isLongform(field({ controlType: "contenteditable" }))).toBe(true);
  });
  it("is true for question-like labels on text inputs", () => {
    expect(isLongform(field({ label: "Why do you want to work here?" }))).toBe(true);
  });
  it("is false for a short plain text field", () => {
    expect(isLongform(field({ label: "Middle name" }))).toBe(false);
  });
});

describe("isAiCandidate", () => {
  it("excludes sensitive (EEO) fields", () => {
    expect(isAiCandidate(field({ controlType: "select", sensitive: true, options: ["Male", "Female"] }))).toBe(false);
  });
  it("excludes file and custom dropdowns", () => {
    expect(isAiCandidate(field({ controlType: "file" }))).toBe(false);
    expect(isAiCandidate(field({ controlType: "customDropdown" }))).toBe(false);
  });
  it("includes option-based screening fields", () => {
    expect(isAiCandidate(field({ controlType: "radioGroup", options: ["Yes", "No"] }))).toBe(true);
    expect(isAiCandidate(field({ controlType: "select", options: ["A", "B"] }))).toBe(true);
  });
  it("includes custom dropdowns (comboboxes) so the AI answers them", () => {
    expect(isAiCandidate(field({ controlType: "combobox" }))).toBe(true);
    // …but still skips a sensitive (EEO) dropdown.
    expect(isAiCandidate(field({ controlType: "combobox", sensitive: true }))).toBe(false);
  });
  it("includes long-form free text", () => {
    expect(isAiCandidate(field({ controlType: "textarea" }))).toBe(true);
  });
  it("includes question-like text but excludes plain text", () => {
    expect(isAiCandidate(field({ controlType: "text", label: "Years of experience with React?" }))).toBe(true);
    expect(isAiCandidate(field({ controlType: "text", label: "Address line 2" }))).toBe(false);
  });
});

describe("aiFillCandidates", () => {
  it("keeps only empty, unanswered, AI-eligible fields", () => {
    const fields = [
      field({ id: "a", controlType: "textarea" }), // candidate
      field({ id: "b", controlType: "textarea", proposedValue: "x" }), // profile answered → skip
      field({ id: "c", controlType: "textarea", currentValue: "typed" }), // user typed → skip
      field({ id: "d", controlType: "select", sensitive: true, options: ["M", "F"] }), // EEO → skip
    ];
    expect(aiFillCandidates(fields).map((f) => f.id)).toEqual(["a"]);
  });
});

describe("toAiFillField", () => {
  it("maps control types to the backend field types", () => {
    expect(toAiFillField(field({ controlType: "radioGroup", options: ["Yes", "No"] })).type).toBe("radio");
    expect(toAiFillField(field({ controlType: "contenteditable" })).type).toBe("textarea");
    expect(toAiFillField(field({ controlType: "select", options: ["A"] })).type).toBe("select");
    expect(toAiFillField(field({ controlType: "checkbox" })).type).toBe("checkbox");
    expect(toAiFillField(field({ controlType: "text" })).type).toBe("text");
    expect(toAiFillField(field({ id: "z", options: undefined })).options).toEqual([]);
  });
});

describe("planAiFill", () => {
  it("routes by needsReview, not length (divergent cases pin the behavior)", () => {
    const candidates = [
      field({ id: "essay", controlType: "textarea", label: "Why us?" }),
      // Long-form but a trusted generic memory match → must fill silently.
      field({ id: "summary", controlType: "textarea", label: "Professional summary" }),
      // Short field but an AI suggestion → must go to review.
      field({ id: "exp", controlType: "text", label: "Years of experience?" }),
      field({ id: "auth", controlType: "radioGroup", label: "Authorized?", options: ["Yes", "No"] }),
      field({ id: "blank", controlType: "text", label: "Years?" }),
    ];
    const answers = [
      { id: "essay", answer: "Because I love it.", needsReview: true, source: "ai", category: "company_specific" },
      { id: "summary", answer: "Seasoned engineer.", needsReview: false, source: "memory", category: "general" },
      { id: "exp", answer: "5 years", needsReview: true, source: "ai", category: "general" },
      { id: "auth", answer: "Yes", needsReview: false, source: "rule", category: "work_authorization" },
      { id: "blank", answer: "   ", needsReview: true, source: "ai", category: "general" }, // empty → ignored
    ];
    const plan = planAiFill(candidates, answers);
    expect(plan.drafts).toEqual([
      { fieldId: "essay", label: "Why us?", value: "Because I love it.", source: "ai", category: "company_specific" },
      { fieldId: "exp", label: "Years of experience?", value: "5 years", source: "ai", category: "general" },
    ]);
    expect(plan.simpleTargets).toEqual([
      { fieldId: "summary", value: "Seasoned engineer." },
      { fieldId: "auth", value: "Yes" },
    ]);
  });
});

describe("tallyOutcomes", () => {
  it("dedupes by fieldId with later groups winning", () => {
    const local = [{ fieldId: "a", ok: true }, { fieldId: "b", ok: false }];
    const ai = [{ fieldId: "b", ok: true }, { fieldId: "c", ok: true }];
    expect(tallyOutcomes(local, ai)).toEqual({ ok: 3, fail: 0, total: 3 });
  });
});
