import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { successFactorsEeoHtml, SF_RACE_OPTIONS } from "./fixtures/successfactorsReal";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * Real SuccessFactors self-identification section (rcmpaginatedselect). These
 * are the exact fields failing in production autofill_reports. Verifies the
 * genuine DOM is detected + classified correctly (a prerequisite for filling);
 * the live commit is exercised by browser verification.
 */
describe("SuccessFactors rcmpaginatedselect — real DOM", () => {
  function fields() {
    document.body.innerHTML = successFactorsEeoHtml();
    return scanPage(MOCK_PROFILE, true).fields; // fillEEO=true: user opted into EEO
  }
  const byLabel = (label: string) =>
    fields().find((f) => f.label.toLowerCase().includes(label));

  it("detects each picklist as a combobox (not a text field)", () => {
    for (const label of ["gender", "race/ethnicity", "protected veteran", "conflict of interest"]) {
      const f = byLabel(label);
      expect(f, `${label} detected`).toBeTruthy();
      expect(f!.controlType, `${label} controlType`).toBe("combobox");
    }
  });

  it("classifies the EEO picklists as their sensitive categories", () => {
    const all = fields();
    const cat = (label: string) => all.find((f) => f.label.toLowerCase().includes(label));
    expect(cat("gender")?.category).toBe("eeoGender");
    expect(cat("race/ethnicity")?.category).toBe("eeoRace");
    expect(cat("protected veteran")?.category).toBe("eeoVeteran");
    for (const c of ["gender", "race/ethnicity", "protected veteran"]) {
      expect(cat(c)?.sensitive, `${c} sensitive`).toBe(true);
    }
  });

  it("harvests the real option list from the widget's aria-owns'd listbox", () => {
    const race = byLabel("race/ethnicity");
    expect(race?.options).toBeTruthy();
    // the real SF race options must be readable so the on-device matcher / AI
    // is constrained to what the widget actually offers
    expect(race!.options).toContain("Asian (not Hispanic or Latino)");
    expect(race!.options!.length).toBe(SF_RACE_OPTIONS.length);
  });
});
