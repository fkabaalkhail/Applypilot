import { describe, it, expect, beforeEach } from "vitest";
import { collectSignals, bestDisplayLabel } from "../src/content/domUtils";
import { classifyField } from "../src/content/fieldMatcher";
import { AUTOFILL_CONFIDENCE_THRESHOLD } from "../src/shared/constants";

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * Reproduction: react-select style custom dropdown. The visible "Select…"
 * placeholder is a PRECEDING SIBLING of the inner role=combobox input, while the
 * real question lives in a <label> above. nearbyText grabs "Select…" first, which
 * poisons both the display label and the classifier.
 */
describe("react-select combobox, label must be the question, not the placeholder", () => {
  function mount(question: string): HTMLElement {
    document.body.innerHTML = `
      <div class="field">
        <label>${question}</label>
        <div class="select">
          <div class="select__control">
            <div class="select__value-container">
              <div class="select__placeholder">Select...</div>
              <div class="select__input-container">
                <input role="combobox" aria-expanded="false" aria-autocomplete="list" />
              </div>
            </div>
          </div>
        </div>
      </div>`;
    return document.querySelector('input[role="combobox"]') as HTMLElement;
  }

  it("country dropdown: label is 'Country', classified as country and confident enough to autofill", () => {
    const el = mount("Country");
    const signals = collectSignals(el);
    expect(bestDisplayLabel(signals)).toBe("Country");
    const c = classifyField(signals);
    expect(c.category).toBe("country");
    // Must clear the autofill bar, otherwise it's detected but never filled.
    expect(c.confidence).toBeGreaterThanOrEqual(AUTOFILL_CONFIDENCE_THRESHOLD);
  });

  it("gender dropdown: classified as eeoGender (sensitive) and autofill-confident", () => {
    const el = mount("What is your gender?");
    const signals = collectSignals(el);
    expect(bestDisplayLabel(signals)).toContain("gender");
    const c = classifyField(signals);
    expect(c.category).toBe("eeoGender");
    expect(c.sensitive).toBe(true);
    expect(c.confidence).toBeGreaterThanOrEqual(AUTOFILL_CONFIDENCE_THRESHOLD);
  });

  it("disability dropdown: classified as eeoDisability and autofill-confident", () => {
    const el = mount("Disability status");
    const signals = collectSignals(el);
    const c = classifyField(signals);
    expect(c.category).toBe("eeoDisability");
    expect(c.confidence).toBeGreaterThanOrEqual(AUTOFILL_CONFIDENCE_THRESHOLD);
  });
});
