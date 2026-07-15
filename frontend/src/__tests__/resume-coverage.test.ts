import { describe, expect, it } from "vitest";
import { skillCovered } from "../lib/resumeCoverage";

const RESUME =
  "Built ETL pipelines in Python and SQL; led stakeholder engagement for finance teams using Microsoft Excel and C++.";

describe("skillCovered", () => {
  it("whole-word match", () => {
    expect(skillCovered(RESUME, "Python")).toBe(true);
    expect(skillCovered(RESUME, "SQL")).toBe(true);
    expect(skillCovered(RESUME, "C++")).toBe(true);
  });
  it("multi-word phrases match when all words present", () => {
    expect(skillCovered(RESUME, "Stakeholder engagement")).toBe(true);
    expect(skillCovered(RESUME, "Microsoft Excel")).toBe(true);
  });
  it("misses honestly", () => {
    expect(skillCovered(RESUME, "Hyperion Planning")).toBe(false);
    expect(skillCovered(RESUME, "CPA certification")).toBe(false);
    expect(skillCovered(RESUME, "Java")).toBe(false);
  });
  it("does not substring-match short tokens", () => {
    expect(skillCovered("we use rust daily", "R")).toBe(false);
  });
  it("empty inputs never match", () => {
    expect(skillCovered("", "Python")).toBe(false);
    expect(skillCovered(RESUME, "")).toBe(false);
  });
});
