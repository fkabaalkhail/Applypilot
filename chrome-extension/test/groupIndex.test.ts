import { describe, it, expect } from "vitest";
import { detectGroupIndex } from "../src/content/groupIndex";
import type { FieldSignals } from "../src/content/domUtils";

function sig(over: Partial<FieldSignals>): FieldSignals {
  return {
    label: "", ariaLabel: "", placeholder: "", nameAttr: "", testId: "",
    idAttr: "", nearby: "", typeHint: "", autocomplete: "", ...over,
  } as FieldSignals;
}

describe("detectGroupIndex", () => {
  it("reads a bracketed index from the name", () => {
    expect(detectGroupIndex(sig({ nameAttr: "education[1][school_name]" }))).toBe(1);
  });
  it("reads underscore- and dot- and dash-delimited indices", () => {
    expect(detectGroupIndex(sig({ nameAttr: "job_application_employments_attributes_2_title" }))).toBe(2);
    expect(detectGroupIndex(sig({ nameAttr: "edu.0.degree" }))).toBe(0);
    expect(detectGroupIndex(sig({ nameAttr: "emp-3-company" }))).toBe(3);
  });
  it("falls back to the id when the name has no index", () => {
    expect(detectGroupIndex(sig({ nameAttr: "school", idAttr: "education_1_school" }))).toBe(1);
  });
  it("returns null for a plain field", () => {
    expect(detectGroupIndex(sig({ nameAttr: "first_name", idAttr: "first_name" }))).toBeNull();
  });
  it("ignores spurious huge indices (>= 50)", () => {
    expect(detectGroupIndex(sig({ nameAttr: "token[999]" }))).toBeNull();
  });
  it("prefers a bracketed index over an earlier delimited index (bracket-priority)", () => {
    expect(detectGroupIndex(sig({ nameAttr: "emp_2_education[5]" }))).toBe(5);
  });
});
