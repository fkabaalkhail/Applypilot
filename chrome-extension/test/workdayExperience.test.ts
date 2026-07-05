import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { getAdapter } from "../src/content/adapters";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const workday = getAdapter("acme.wd5.myworkdayjobs.com", "https://acme.wd5.myworkdayjobs.com/apply")!;

const profile = {
  experience: [
    { company: "Acme Corp", title: "Senior Engineer", startDate: "", endDate: "", description: "" },
    { company: "Beta LLC", title: "Engineering Manager", startDate: "", endDate: "", description: "" },
  ],
  education: [],
} as unknown as UserApplicationProfile;

/** A real Workday work-experience row: fields keyed by an arbitrary instance
 *  number ("workExperience-<n>--jobTitle") and tagged data-automation-id. */
function wdRow(instance: number): string {
  const f = (auto: string, name: string, label: string) =>
    `<div data-automation-id="formField-${auto}" data-fkit-id="workExperience-${instance}--${auto}">
       <label for="workExperience-${instance}--${auto}">${label}</label>
       <input type="text" id="workExperience-${instance}--${auto}" name="${name}" value="">
     </div>`;
  return `<div data-fkit-id="workExperience-${instance}--null">
    ${f("jobTitle", "jobTitle", "Job Title")}
    ${f("companyName", "companyName", "Company")}
  </div>`;
}

describe("Workday work-experience section", () => {
  it("classifies Job Title / Company and fills the instance-numbered row from experience[0]", () => {
    document.body.innerHTML = wdRow(8);
    const { fields } = scanPage(profile, false, workday);
    const title = fields.find((f) => f.category === "currentTitle");
    const company = fields.find((f) => f.category === "currentCompany");
    expect(title, "Job Title classified as currentTitle").toBeTruthy();
    expect(company, "Company classified as currentCompany").toBeTruthy();
    // instance "8" must resolve to experience[0], not experience[8] (undefined)
    expect(title!.proposedValue).toBe("Senior Engineer");
    expect(company!.proposedValue).toBe("Acme Corp");
    expect(title!.groupIndex).toBe(0);
  });

  it("maps multiple instance-numbered rows to positional 0,1 (experience[0],[1])", () => {
    document.body.innerHTML = wdRow(8) + wdRow(12);
    const { fields } = scanPage(profile, false, workday);
    const titles = fields
      .filter((f) => f.category === "currentTitle")
      .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
    expect(titles.map((t) => t.proposedValue)).toEqual(["Senior Engineer", "Engineering Manager"]);
    const companies = fields
      .filter((f) => f.category === "currentCompany")
      .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
    expect(companies.map((c) => c.proposedValue)).toEqual(["Acme Corp", "Beta LLC"]);
  });
});
