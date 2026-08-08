/**
 * Workday renders a date as sibling spinbuttons whose EMPTY value is "0", not
 * "". Both fill paths skip a field with a non-empty currentValue, so an empty
 * Workday date was invisible to the AI pass and to the gaps modal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { workdayAdapter } from "../src/content/adapters/workday";
import { dateContainerOf } from "../src/content/adapters/workdaySelectors";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

/** One Workday date widget (month/day/year spinbuttons), as reported live. */
function mountWorkdayDate(prefix = "workExperience-10--startDate"): void {
  document.body.innerHTML = `
    <div data-automation-id="formField-startDate">
      <div data-automation-id="dateWidget">
        <label for="${prefix}-dateSectionMonth-input">Month</label>
        <input role="spinbutton" aria-label="Month" aria-valuemin="1" aria-valuemax="12"
               aria-valuetext="0" aria-valuenow="0" value="0"
               id="${prefix}-dateSectionMonth-input" data-automation-id="dateSectionMonth-input">
        <label for="${prefix}-dateSectionDay-input">Day</label>
        <input role="spinbutton" aria-label="Day" aria-valuemin="1" aria-valuemax="31"
               aria-valuetext="0" aria-valuenow="0" value="0"
               id="${prefix}-dateSectionDay-input" data-automation-id="dateSectionDay-input">
        <label for="${prefix}-dateSectionYear-input">Year</label>
        <input role="spinbutton" aria-label="Year" aria-valuemin="1" aria-valuemax="9999"
               aria-valuetext="0" aria-valuenow="0" value="0" aria-invalid="true"
               id="${prefix}-dateSectionYear-input" data-automation-id="dateSectionYear-input">
      </div>
    </div>`;
}

describe("Workday date spinbuttons", () => {
  it("reads an empty (value=0) spinbutton as empty, not as already filled", () => {
    mountWorkdayDate();
    const { fields } = scanPage(MOCK_PROFILE, false);
    const year = fields.find((f) => f.label.toLowerCase().includes("year"));
    expect(year, "expected the Year spinbutton to be scanned").toBeDefined();
    expect(year!.currentValue).toBeUndefined();
  });

  it("still reports a real spinbutton value", () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    year.value = "2025";
    year.setAttribute("aria-valuetext", "2025");
    year.setAttribute("aria-valuenow", "2025");
    const { fields } = scanPage(MOCK_PROFILE, false);
    const scanned = fields.find((f) => f.label.toLowerCase().includes("year"));
    expect(scanned!.currentValue).toBe("2025");
  });

  it("leaves an ordinary number input alone — 0 is a legitimate answer there", () => {
    document.body.innerHTML = `<label>Years of experience <input type="number" value="0"></label>`;
    const { fields } = scanPage(MOCK_PROFILE, false);
    const n = fields.find((f) => f.label.toLowerCase().includes("years"));
    expect(n!.currentValue).toBe("0");
  });
});

describe("Workday split-date container", () => {
  it("never treats a date PART as its own container", () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input")!;
    const container = dateContainerOf(year);
    expect(container).not.toBe(year);
    expect(container!.getAttribute("data-automation-id")).toBe("dateWidget");
  });

  /** FillContext is `{ control, value, el }` — see adapters/types.ts. */
  const fillCtx = (el: HTMLInputElement, value: string) => ({
    control: { id: "f1", controlType: "text" as const, el },
    value,
    el,
  });

  it("writes month, day and year from one ISO value", async () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    const op = workdayAdapter.fillOperation!(fillCtx(year, "2025-05-14"));
    expect(op, "expected the adapter to claim this field").toBeDefined();
    await op;
    expect((document.getElementById("workExperience-10--startDate-dateSectionMonth-input") as HTMLInputElement).value).toBe("5");
    expect((document.getElementById("workExperience-10--startDate-dateSectionDay-input") as HTMLInputElement).value).toBe("14");
    expect(year.value).toBe("2025");
  });

  it("accepts a year-month profile value (the shape the profile stores)", async () => {
    mountWorkdayDate();
    const year = document.getElementById("workExperience-10--startDate-dateSectionYear-input") as HTMLInputElement;
    await workdayAdapter.fillOperation!(fillCtx(year, "2025-05"));
    expect((document.getElementById("workExperience-10--startDate-dateSectionMonth-input") as HTMLInputElement).value).toBe("5");
    expect(year.value).toBe("2025");
  });

  it("accepts a bare year (graduation year)", async () => {
    mountWorkdayDate("education-11--endDate");
    const year = document.getElementById("education-11--endDate-dateSectionYear-input") as HTMLInputElement;
    await workdayAdapter.fillOperation!(fillCtx(year, "2026"));
    expect(year.value).toBe("2026");
  });
});
