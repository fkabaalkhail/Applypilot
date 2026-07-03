import { describe, it, expect, beforeEach } from "vitest";
import { collectSignals, bestDisplayLabel } from "../src/content/domUtils";
import { classifyField } from "../src/content/fieldMatcher";

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * Reproduction: react-select style custom dropdown. The visible "Select…"
 * placeholder is a PRECEDING SIBLING of the inner role=combobox input, while the
 * real question lives in a <label> above. nearbyText grabs "Select…" first, which
 * poisons both the display label and the classifier.
 */
describe("react-select combobox — label must be the question, not the placeholder", () => {
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

  it("country dropdown: label is 'Country', classified as country", () => {
    const el = mount("Country");
    const signals = collectSignals(el);
    expect(bestDisplayLabel(signals)).toBe("Country");
    expect(classifyField(signals).category).toBe("country");
  });

  it("gender dropdown: label is the question, classified as eeoGender (sensitive)", () => {
    const el = mount("What is your gender?");
    const signals = collectSignals(el);
    expect(bestDisplayLabel(signals)).toContain("gender");
    const c = classifyField(signals);
    expect(c.category).toBe("eeoGender");
    expect(c.sensitive).toBe(true);
  });

  it("disability dropdown: classified as eeoDisability", () => {
    const el = mount("Disability status");
    const signals = collectSignals(el);
    expect(classifyField(signals).category).toBe("eeoDisability");
  });
});
