import { describe, it, expect } from "vitest";
import { collectSignals } from "../src/content/domUtils";
import { classifyField, resolveProfileValue } from "../src/content/fieldMatcher";
import type { UserApplicationProfile } from "../src/shared/types";

/** An <input> carrying only a developer test-id (no label/name/placeholder). */
function elWithTestId(attr: string, value: string): HTMLElement {
  const el = document.createElement("input");
  el.setAttribute(attr, value);
  return el;
}

describe("collectSignals — developer test-ids", () => {
  it("captures data-automation-id as testId", () => {
    expect(collectSignals(elWithTestId("data-automation-id", "legalNameSection_firstName")).testId).toBe(
      "legalNameSection_firstName"
    );
  });

  it("falls back through data-testid / data-test / data-qa", () => {
    expect(collectSignals(elWithTestId("data-qa", "candidate-email")).testId).toBe("candidate-email");
  });

  it("is empty when no test-id attribute is present", () => {
    expect(collectSignals(document.createElement("input")).testId).toBe("");
  });
});

describe("classifyField — test-id drives classification when labels are absent", () => {
  const classifyId = (id: string) => classifyField(collectSignals(elWithTestId("data-automation-id", id)));

  it("classifies a Workday first-name field from data-automation-id alone", () => {
    expect(classifyId("legalNameSection_firstName").category).toBe("firstName");
  });

  it("classifies a Workday country dropdown id as location", () => {
    expect(classifyId("countryDropdown").category).toBe("location");
  });

  it("does not invent a category from a meaningless id", () => {
    expect(classifyId("input-15").category).toBe("unknown");
  });
});

function riProfile(): UserApplicationProfile {
  return {
    education: [
      { school: "MIT", degree: "BS", graduationYear: "2018" },
      { school: "Stanford", degree: "MS", graduationYear: "2020" },
    ],
    experience: [
      { company: "Acme", title: "Engineer", startDate: "2020", endDate: "2022", description: "" },
      { company: "Globex", title: "Senior Engineer", startDate: "2022", endDate: "", description: "" },
    ],
    currentCompany: "Globex",
    currentTitle: "Senior Engineer",
  } as unknown as UserApplicationProfile;
}

describe("resolveProfileValue — index-aware repeating sections", () => {
  const p = riProfile();
  const sel = { controlType: "text" as const };
  it("resolves an indexed education field to that education entry", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: 1 }, false)).toBe("Stanford");
    expect(resolveProfileValue("degree", p, { ...sel, groupIndex: 1 }, false)).toBe("MS");
    expect(resolveProfileValue("graduationYear", p, { ...sel, groupIndex: 0 }, false)).toBe("2018");
  });
  it("resolves education without an index to entry [0] (unchanged)", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: null }, false)).toBe("MIT");
    expect(resolveProfileValue("school", p, sel, false)).toBe("MIT");
  });
  it("resolves an indexed employment field to that experience entry", () => {
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: 0 }, false)).toBe("Acme");
    expect(resolveProfileValue("currentTitle", p, { ...sel, groupIndex: 0 }, false)).toBe("Engineer");
  });
  it("resolves employment without an index to the top-level current fields", () => {
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: null }, false)).toBe("Globex");
    expect(resolveProfileValue("currentTitle", p, sel, false)).toBe("Senior Engineer");
  });
  it("returns null for an out-of-range index (no throw)", () => {
    expect(resolveProfileValue("school", p, { ...sel, groupIndex: 9 }, false)).toBeNull();
    expect(resolveProfileValue("currentCompany", p, { ...sel, groupIndex: 9 }, false)).toBeNull();
  });
});

describe("resolveProfileValue — missing education/experience arrays", () => {
  it("does not throw for education/experience categories when the profile lacks those arrays", () => {
    const bare = { firstName: "A", currentCompany: "", currentTitle: "" } as unknown as UserApplicationProfile;
    const sel = { controlType: "text" as const };
    expect(() => resolveProfileValue("education", bare, sel, false)).not.toThrow();
    expect(() => resolveProfileValue("experience", bare, { controlType: "textarea" as const }, false)).not.toThrow();
    expect(resolveProfileValue("education", bare, sel, false)).toBeNull();
  });
});
