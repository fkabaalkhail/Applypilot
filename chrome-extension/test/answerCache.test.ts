import { describe, it, expect, beforeEach } from "vitest";
import { normalizeQuestion, splitByCache, cacheAnswers, __resetCache } from "../src/content/answerCache";
import type { DetectedField } from "../src/shared/types";

beforeEach(() => __resetCache());

function acField(id: string, label: string): DetectedField {
  return {
    id, label, category: "unknown", confidence: 1, controlType: "text",
    required: false, proposedValue: null, fillable: true, sensitive: false,
  } as DetectedField;
}

describe("normalizeQuestion", () => {
  it("collapses case, whitespace and punctuation", () => {
    expect(normalizeQuestion("  Are you  AUTHORIZED to work?  ")).toBe("are you authorized to work");
  });
});

describe("splitByCache / cacheAnswers", () => {
  it("returns a hit (with the current field id re-attached) for a cached question, others miss", () => {
    cacheAnswers([acField("id1", "Work authorization?")], [{ id: "id1", answer: "Yes", needsReview: false, source: "rule" }]);
    const { hits, misses } = splitByCache([acField("id2", "work  AUTHORIZATION?"), acField("id3", "Salary?")]);
    expect(hits).toEqual([{ id: "id2", answer: "Yes", needsReview: false, source: "rule" }]);
    expect(misses.map((f) => f.id)).toEqual(["id3"]);
  });
  it("does not cache empty answers or empty-label fields", () => {
    cacheAnswers([acField("a", "")], [{ id: "a", answer: "X" }]);       // empty label
    cacheAnswers([acField("b", "Q")], [{ id: "b", answer: "   " }]);    // empty answer
    const { hits, misses } = splitByCache([acField("c", "Q")]);
    expect(hits).toEqual([]);
    expect(misses.map((f) => f.id)).toEqual(["c"]);
  });
  it("__resetCache clears everything", () => {
    cacheAnswers([acField("a", "Q")], [{ id: "a", answer: "Yes" }]);
    __resetCache();
    expect(splitByCache([acField("b", "Q")]).misses.map((f) => f.id)).toEqual(["b"]);
  });
});
