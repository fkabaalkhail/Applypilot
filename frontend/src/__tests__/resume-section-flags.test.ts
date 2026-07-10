// frontend/src/__tests__/resume-section-flags.test.ts
import { describe, it, expect } from "vitest";
import { sectionFlags } from "../lib/resumeProfile";
import type { AnalysisIssue, AnalysisReport } from "../lib/resumeProfile";

const report = (issues: AnalysisIssue[]): AnalysisReport => ({
  overall_grade: "GOOD", letter_grade: "B", score: 70,
  urgent_fix_count: 0, critical_fix_count: 0, optional_fix_count: 0,
  summary: "", highlights: [], strengths: [],
  categories: [{ id: "c", name: "Cat", score: 50, why_it_matters: "", issues }],
  analyzed_at: null,
});

const issue = (over: Partial<AnalysisIssue>): AnalysisIssue => ({
  id: "i", title: "", severity: "optional", count: 1,
  description: "", evidence: [], suggestion: "", section: "Education", ...over,
});

describe("sectionFlags", () => {
  it("returns nothing when the report is null", () => {
    expect(sectionFlags(null, "Education")).toEqual([]);
  });

  it("sums counts by severity for the matching section, ordered urgent→critical→optional", () => {
    const r = report([
      issue({ id: "1", severity: "optional", count: 1, section: "Education" }),
      issue({ id: "2", severity: "urgent", count: 2, section: "Education" }),
      issue({ id: "3", severity: "urgent", count: 1, section: "Skills" }),
    ]);
    expect(sectionFlags(r, "Education")).toEqual([
      { severity: "urgent", count: 2 },
      { severity: "optional", count: 1 },
    ]);
  });
});
