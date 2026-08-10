import { afterEach, describe, expect, it } from "vitest";
import {
  setOverrideRules,
  applyOverride,
  clearOverrideRules,
  hasOverrideRules,
} from "../src/content/overrides";
import type { Classification } from "../src/content/fieldMatcher";
import type { FieldContext } from "../src/content/adapters/types";
import type { AutofillOverrideRule } from "../src/shared/types";

function ctx(labels: Partial<{ label: string; ariaLabel: string; placeholder: string; nearby: string }>): FieldContext {
  return {
    el: document.createElement("input"),
    controlType: "text",
    signals: { label: "", ariaLabel: "", placeholder: "", nearby: "", ...labels },
  } as unknown as FieldContext;
}

const rule = (host: string, labelPattern: string, category: string): AutofillOverrideRule => ({
  host,
  labelPattern,
  category,
  valueSynonyms: {},
});

const base: Classification = { category: "unknown", confidence: 0, sensitive: false };

afterEach(() => clearOverrideRules());

describe("overrides, server hot-fix classification", () => {
  it("forces a category when host + label match", () => {
    setOverrideRules([rule("greenhouse.io", "work authorization", "workAuthorization")], "boards.greenhouse.io");
    const out = applyOverride(ctx({ label: "Work Authorization Status" }), base);
    expect(out.category).toBe("workAuthorization");
    expect(out.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("matches host '*' on any host", () => {
    setOverrideRules([rule("*", "sponsorship", "requiresSponsorship")], "jobs.lever.co");
    expect(applyOverride(ctx({ label: "Will you require sponsorship?" }), base).category).toBe(
      "requiresSponsorship"
    );
  });

  it("does not apply when the host does not match", () => {
    setOverrideRules([rule("greenhouse.io", "work auth", "workAuthorization")], "jobs.lever.co");
    expect(applyOverride(ctx({ label: "Work Auth" }), base).category).toBe("unknown");
  });

  it("is a no-op (same object) with no rules", () => {
    expect(hasOverrideRules()).toBe(false);
    expect(applyOverride(ctx({ label: "anything" }), base)).toBe(base);
  });

  it("skips a rule with an invalid regex without throwing", () => {
    setOverrideRules([rule("*", "(unclosed", "x")], "h");
    expect(hasOverrideRules()).toBe(false);
    expect(applyOverride(ctx({ label: "anything" }), base).category).toBe("unknown");
  });

  it("matches against ariaLabel / placeholder / nearby, not just label", () => {
    setOverrideRules([rule("*", "linkedin", "linkedin")], "h");
    expect(applyOverride(ctx({ placeholder: "Your LinkedIn URL" }), base).category).toBe("linkedin");
  });
});
