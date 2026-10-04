/**
 * Workday's Self Identify page (the CC-305 disability form), as Workday's own
 * bundle names it: selfIdentifiedDisabilityData with name, dateSignedOn and
 * disabilityStatus. Found by the Workday replica (one Autofill click to
 * Review, 2026-10-03): the date's parts read as plain "Month / Day / Year"
 * text and the disability boxes as an unknown question, so the page stayed
 * unanswered and the flow waited on it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { workdayAdapter } from "../src/content/adapters/workday";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { isDefaultSelected } from "../src/shared/selection";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

function mountSelfIdentify(): void {
  document.body.innerHTML = `
    <div data-automation-id="applyFlowPage">
      <h3>Voluntary Self-Identification of Disability</h3>
      <div data-automation-id="formField-name"><label for="sid-name">Name*</label><input id="sid-name" type="text" data-automation-id="name"></div>
      <div data-automation-id="formField-dateSignedOn">
        <div id="sid-date-label">Date*</div>
        <div data-automation-id="dateInputWrapper" role="group" aria-labelledby="sid-date-label">
          <input type="text" role="spinbutton" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input" data-automation-id="dateSectionMonth-input" aria-label="Month">
          <input type="text" role="spinbutton" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input" data-automation-id="dateSectionDay-input" aria-label="Day">
          <input type="text" role="spinbutton" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input" data-automation-id="dateSectionYear-input" aria-label="Year">
        </div>
      </div>
      <fieldset data-automation-id="formField-disabilityStatus">
        <legend>Please check one of the boxes below:*</legend>
        <div><input type="checkbox" id="d1"><label for="d1">Yes, I have a disability, or have had one in the past</label></div>
        <div><input type="checkbox" id="d2"><label for="d2">No, I do not have a disability and have not had one in the past</label></div>
        <div><input type="checkbox" id="d3"><label for="d3">I do not want to answer</label></div>
      </fieldset>
    </div>`;
}

describe("Workday Self Identify", () => {
  it("the signed-on date's parts are today's date, not three unknown text boxes", () => {
    mountSelfIdentify();
    const { fields } = scanPage(MOCK_PROFILE, true, workdayAdapter);
    const parts = fields.filter((f) => /dateSignedOn/.test(document.querySelector(`[data-ap-field="${f.id}"]`)?.id ?? ""));
    expect(parts.length).toBe(3);
    for (const f of parts) {
      expect(f.category, f.label).toBe("signatureDate");
      // Read before only weakly, the parts were never chosen to fill.
      expect(isDefaultSelected(f), f.label).toBe(true);
    }
  });

  it("the disability boxes are the disability question, answered from the profile", () => {
    mountSelfIdentify();
    const { fields } = scanPage({ ...MOCK_PROFILE, eeo: { ...MOCK_PROFILE.eeo, disabilityStatus: "Prefer not to say" } }, true, workdayAdapter);
    const group = fields.find((f) => f.controlType === "checkboxGroup");
    expect(group?.category).toBe("eeoDisability");
    expect(group?.proposedValue).toBe("I do not want to answer");
    // The page's own heading reads "disability" weakly (0.66, under the fill
    // threshold); the boxes say it plainly, and they decide.
    expect(isDefaultSelected(group!)).toBe(true);
  });
});

describe("answers whose option text has commas of its own", () => {
  const OPTS_HTML = (type: string): string => `<fieldset><legend>Please check one of the boxes below:*</legend>
    <div><input type="${type}" name="d" id="d1"><label for="d1">Yes, I have a disability, or have had one in the past</label></div>
    <div><input type="${type}" name="d" id="d2"><label for="d2">No, I do not have a disability and have not had one in the past</label></div>
    <div><input type="${type}" name="d" id="d3"><label for="d3">I do not want to answer</label></div></fieldset>`;

  it("one answer is one option, not the same option twice", () => {
    document.body.innerHTML = OPTS_HTML("checkbox");
    const { fields } = scanPage({ ...MOCK_PROFILE, eeo: { ...MOCK_PROFILE.eeo, disabilityStatus: "No, I do not have a disability" } }, true, workdayAdapter);
    expect(fields[0].proposedValue).toBe("No, I do not have a disability and have not had one in the past");
  });

  it("'Prefer not to say' is the form's 'I do not want to answer', as radios or boxes", () => {
    for (const type of ["radio", "checkbox"]) {
      document.body.innerHTML = OPTS_HTML(type);
      const { fields } = scanPage({ ...MOCK_PROFILE, eeo: { ...MOCK_PROFILE.eeo, disabilityStatus: "Prefer not to say" } }, true, workdayAdapter);
      expect(fields[0].proposedValue, type).toBe("I do not want to answer");
    }
  });

  it("a box whose label is the whole answer is ticked alone, and verifies", async () => {
    const { writeControl, verifyControl } = await import("../src/content/writeEngine");
    document.body.innerHTML = OPTS_HTML("checkbox");
    const boxes = [...document.querySelectorAll<HTMLInputElement>("input")];
    const control = { id: "g", controlType: "checkboxGroup" as const, checkboxes: boxes };
    const value = "Yes, I have a disability, or have had one in the past";
    expect(writeControl(control, value).written).toBe(true);
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
    expect(verifyControl(control, value)).toBe(true);
  });
});
