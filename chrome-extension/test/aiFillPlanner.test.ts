import { describe, it, expect } from "vitest";
import {
  isAiCandidate,
  aiFillCandidates,
  toAiFillField,
  planAiFill,
  tallyOutcomes,
  planFillRoute,
  needsOptionHarvest,
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

describe("needsOptionHarvest", () => {
  it("harvests a combobox with no known options", () => {
    expect(needsOptionHarvest(field({ controlType: "combobox", options: [] }), false)).toBe(true);
  });
  it("harvests a driver-backed field with no options", () => {
    expect(needsOptionHarvest(field({ controlType: "customDropdown", options: [] }), true)).toBe(true);
  });
  it("skips when options are already known", () => {
    expect(needsOptionHarvest(field({ controlType: "combobox", options: ["A", "B"] }), false)).toBe(false);
  });
  it("skips a native select with options / a plain text field", () => {
    expect(needsOptionHarvest(field({ controlType: "select", options: ["A"] }), false)).toBe(false);
    expect(needsOptionHarvest(field({ controlType: "text", options: [] }), false)).toBe(false);
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
  it("maps a custom dropdown (combobox) to a select choice field", () => {
    expect(toAiFillField(field({ controlType: "combobox", options: ["A", "B"] })).type).toBe("select");
    expect(toAiFillField(field({ controlType: "combobox", options: ["A", "B"] })).options).toEqual(["A", "B"]);
  });
});

describe("planAiFill", () => {
  it("fills every non-empty answer silently, ignoring needsReview (no review gate)", () => {
    const candidates = [
      // needsReview AI suggestion — used to be drafted; now fills inline.
      field({ id: "essay", controlType: "textarea", label: "Why us?" }),
      field({ id: "summary", controlType: "textarea", label: "Professional summary" }),
      // Short field, needsReview AI suggestion — also fills inline now.
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
    // Every non-empty answer lands in simpleTargets, in candidate order.
    expect(plan.simpleTargets).toEqual([
      { fieldId: "essay", value: "Because I love it." },
      { fieldId: "summary", value: "Seasoned engineer." },
      { fieldId: "exp", value: "5 years" },
      { fieldId: "auth", value: "Yes" },
    ]);
    // The review gate is gone — the plan carries no drafts.
    expect(plan).not.toHaveProperty("drafts");
  });
});

describe("tallyOutcomes", () => {
  it("dedupes by fieldId with later groups winning", () => {
    const local = [{ fieldId: "a", ok: true }, { fieldId: "b", ok: false }];
    const ai = [{ fieldId: "b", ok: true }, { fieldId: "c", ok: true }];
    expect(tallyOutcomes(local, ai)).toEqual({ ok: 3, fail: 0, total: 3 });
  });
});

function pfField(over: Partial<DetectedField>): DetectedField {
  return {
    id: "f", category: "unknown", confidence: 1, label: "", controlType: "text",
    required: false, proposedValue: "v", fillable: true, sensitive: false,
    ...over,
  } as DetectedField;
}

describe("planFillRoute", () => {
  it("routes a deterministic high-confidence profile field to localTargets", () => {
    const r = planFillRoute([pfField({ id: "a", category: "email", confidence: 0.9, proposedValue: "me@x.com" })], 0.7);
    expect(r.localTargets).toEqual([{ fieldId: "a", value: "me@x.com" }]);
    expect(r.backendFields).toEqual([]);
  });
  it("routes a deterministic category with LOW confidence to the backend", () => {
    const r = planFillRoute([pfField({ id: "a", category: "email", confidence: 0.5, controlType: "select", options: ["x"], proposedValue: "x" })], 0.7);
    expect(r.backendFields.map((f) => f.id)).toEqual(["a"]);
    expect(r.localTargets).toEqual([]);
  });
  it("routes a judgment field (workAuthorization) to the backend even with a local value", () => {
    const r = planFillRoute([pfField({ id: "a", category: "workAuthorization", confidence: 0.9, controlType: "radioGroup", proposedValue: "Yes" })], 0.7);
    expect(r.backendFields.map((f) => f.id)).toEqual(["a"]);
    expect(r.localTargets).toEqual([]);
  });
  it("keeps a sensitive (EEO) field local and never routes it to the backend", () => {
    const r = planFillRoute([pfField({ id: "a", category: "eeoGender", confidence: 0.9, controlType: "select", options: ["Female"], proposedValue: "Female", sensitive: true })], 0.7);
    expect(r.localTargets).toEqual([{ fieldId: "a", value: "Female" }]);
    expect(r.backendFields).toEqual([]);
  });
  it("routes a deterministic field at exactly the confidence threshold to localTargets (>= is inclusive)", () => {
    const r = planFillRoute([pfField({ id: "a", category: "email", confidence: 0.7, proposedValue: "me@x.com" })], 0.7);
    expect(r.localTargets).toEqual([{ fieldId: "a", value: "me@x.com" }]);
    expect(r.backendFields).toEqual([]);
  });
});

import { planReaskFields, type ReaskCandidate } from "../src/content/aiFillPlanner";

describe("planReaskFields", () => {
  const base = {
    confidence: 0.9, controlType: "combobox" as const, required: true,
    proposedValue: null, fillable: true, sensitive: false,
  };

  it("builds select-typed AI fields carrying the harvested options", () => {
    const fields = [{ ...base, id: "f1", category: "unknown" as const, label: "Citizenship" }];
    const out = planReaskFields(fields, [{ fieldId: "f1", options: ["Canadian", "American"] }]);
    expect(out).toEqual([
      { id: "f1", label: "Citizenship", type: "select", options: ["Canadian", "American"], required: true },
    ]);
  });

  it("skips sensitive fields and empty option lists", () => {
    const fields = [
      { ...base, id: "s1", category: "eeoGender" as const, label: "Gender", sensitive: true },
      { ...base, id: "f2", category: "unknown" as const, label: "State" },
    ];
    const out = planReaskFields(fields, [
      { fieldId: "s1", options: ["Male", "Female"] },
      { fieldId: "f2", options: [] },
      { fieldId: "missing", options: ["X"] },
    ]);
    expect(out).toEqual([]);
  });
});
