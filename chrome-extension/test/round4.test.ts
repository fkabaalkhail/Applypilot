/**
 * Round 4 (2026-10-05): what live pages and the last real fills in prod
 * telemetry showed the current build getting wrong. Each test fails on the
 * code before its fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

describe("a job still running has no end date to write (Workday replica, 2026-10-05)", () => {
  let restore: () => void;
  beforeAll(() => { restore = stubLayout(); });
  afterAll(() => restore());

  /** Workday's work-experience row: the "To" date is on the page until the
   *  "I currently work here" box is ticked, then Workday removes it. */
  function row(n: number): string {
    const p = `workExperience-${21 + n}`;
    const part = (date: string, cap: string) =>
      `<input type="text" role="spinbutton" id="${p}--${date}-dateSection${cap}-input" data-automation-id="dateSection${cap}-input" aria-label="${cap}" aria-valuemin="1" aria-valuemax="${cap === "Year" ? "2100" : "12"}">`;
    const date = (key: string, label: string) =>
      `<div data-automation-id="formField-${key}"><div id="${p}-${key}-l">${label}*</div><div data-automation-id="dateInputWrapper" role="group" aria-labelledby="${p}-${key}-l">${part(key, "Month")}${part(key, "Year")}</div></div>`;
    return `<div class="row" role="group" data-automation-id="workExperience-${n + 1}" aria-labelledby="${p}-heading">
      <h4 id="${p}-heading">Work Experience ${n + 1}</h4>
      <div data-automation-id="formField-company"><label for="${p}--company">Company*</label><input type="text" id="${p}--company" data-automation-id="company"></div>
      <div data-automation-id="formField-currentlyWorkHere"><input type="checkbox" id="${p}--currentlyWorkHere" data-automation-id="currentlyWorkHere"><label for="${p}--currentlyWorkHere">I currently work here</label></div>
      ${date("startDate", "From")}${date("endDate", "To")}
    </div>`;
  }

  it("the current job's To parts get nothing; a past job's get its date", () => {
    document.body.innerHTML = `<div data-automation-id="workExperienceSection"><h3>Work Experience</h3>${row(0)}${row(1)}</div>`;
    const profile = {
      ...MOCK_PROFILE,
      experience: [
        { company: "Dell Technologies", title: "Software Engineer II", startDate: "Jan 2023", endDate: "Present", description: "" },
        { company: "Indeed", title: "Software Engineer", startDate: "Jul 2019", endDate: "Dec 2022", description: "" },
      ],
    };
    const { fields } = scanPage(profile, false);
    const to = (n: number, cap: string) => fields.find((f) => fieldEl(f.id)?.id === `workExperience-${21 + n}--endDate-dateSection${cap}-input`);
    expect(to(1, "Year"), "the past job's To year is scanned").toBeDefined();
    // Typed into a Month box, "Present" could only fail: Workday removes the
    // date once the box is ticked, and the fill reported two failed fields.
    expect(to(0, "Month")?.proposedValue ?? null).toBeNull();
    expect(to(0, "Year")?.proposedValue ?? null).toBeNull();
    expect(to(1, "Year")?.proposedValue).toBe("Dec 2022");
    document.body.innerHTML = "";
  });
});

/** The element a scanned field was registered on. */
function fieldEl(id: string): HTMLElement | null {
  return document.querySelector(`[data-ap-field="${id}"]`);
}

describe("a phone widget that adds the country code (Waymo's embedded Greenhouse, live 2026-10-05)", () => {
  it("'(416) 555-0142' read back as '+14165550142' was written, not 'did not stick'", async () => {
    // Also in prod telemetry (2026-09-28): "Phone Number: Value did not stick.
    // Fill manually" on a page that held the right number.
    const { verifyControl } = await import("../src/content/writeEngine");
    const el = document.createElement("input");
    el.type = "tel";
    document.body.append(el);
    const control = { id: "p", controlType: "text" as const, el };
    el.value = "+14165550142";
    expect(verifyControl(control, "(416) 555-0142")).toBe(true);
    el.value = "+1 512-555-0143";
    expect(verifyControl(control, "512-555-0143")).toBe(true);
    // Another number, or a code that swallows a trunk zero, is not the number.
    el.value = "+14165550199";
    expect(verifyControl(control, "(416) 555-0142")).toBe(false);
    el.value = "+12079460958";
    expect(verifyControl(control, "020 7946 0958")).toBe(false);
    el.remove();
  });
});
