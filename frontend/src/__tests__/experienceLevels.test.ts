import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { EXPERIENCE_OPTIONS, normalizeExperienceLevels } from "../components/JobFilterBar";

const CANONICAL = EXPERIENCE_OPTIONS.map((o) => o.value);

/**
 * Saved filters outlive the options that produced them. A user who picked "Senior"
 * under the old taxonomy still has it in localStorage; if it survived rehydration it
 * would be an invisible filter, no checkbox renders for it, so it cannot be cleared,
 * and it silently returns zero jobs.
 */
describe("normalizeExperienceLevels", () => {
  it("offers only levels that exist in the job catalogue", () => {
    expect(CANONICAL).toEqual(["internship", "new_grad"]);
  });

  it("keeps canonical values untouched", () => {
    expect(normalizeExperienceLevels(["internship", "new_grad"])).toEqual(["internship", "new_grad"]);
  });

  it("migrates legacy values onto the current taxonomy", () => {
    expect(normalizeExperienceLevels(["intern_new_grad"])).toEqual(["internship", "new_grad"]);
    expect(normalizeExperienceLevels(["entry"])).toEqual(["new_grad"]);
  });

  it("drops dead levels the catalogue never had", () => {
    expect(normalizeExperienceLevels(["mid", "senior", "lead", "director"])).toEqual([]);
  });

  it("keeps the live levels when mixed with dead ones", () => {
    expect(normalizeExperienceLevels(["senior", "internship", "director"])).toEqual(["internship"]);
  });

  it("dedupes overlapping legacy and canonical values", () => {
    expect(normalizeExperienceLevels(["intern_new_grad", "internship", "entry"])).toEqual([
      "internship",
      "new_grad",
    ]);
  });

  it("survives malformed persisted state", () => {
    expect(normalizeExperienceLevels(undefined)).toEqual([]);
    expect(normalizeExperienceLevels(null)).toEqual([]);
    expect(normalizeExperienceLevels("internship")).toEqual(["internship"]);
    expect(normalizeExperienceLevels([42, null, {}, "", "  "])).toEqual([]);
  });

  it("only ever yields canonical values, and is idempotent", () => {
    const anyValue = fc.oneof(
      fc.constantFrom(...CANONICAL, "intern_new_grad", "entry", "mid", "senior", "lead", "director"),
      fc.string(),
      fc.constant(null),
      fc.integer(),
    );
    fc.assert(
      fc.property(fc.oneof(fc.array(anyValue), anyValue), (input) => {
        const once = normalizeExperienceLevels(input);
        expect(once.every((v) => CANONICAL.includes(v))).toBe(true);
        expect(new Set(once).size).toBe(once.length);
        // Re-running on already-normalized state must not drift.
        expect(normalizeExperienceLevels(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});
