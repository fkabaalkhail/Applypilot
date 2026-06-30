import { describe, it, expect } from "vitest";
import { collectSignals } from "../src/content/domUtils";
import { classifyField } from "../src/content/fieldMatcher";

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
