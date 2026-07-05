import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

const profile = {
  experience: [
    { company: "Acme", title: "Engineer", startDate: "2020-01", endDate: "2022-06", description: "Built things." },
    { company: "Beta", title: "Lead", startDate: "2022-07", endDate: "Present", description: "Led things." },
  ],
  education: [],
} as unknown as UserApplicationProfile;

function row(i: number): string {
  const f = (name: string, label: string, tag = "input") =>
    `<div><label for="${name}">${label}</label><${tag} id="${name}" name="experience[${i}][${name.split("-").pop()}]"></${tag}></div>`;
  return (
    f(`r${i}-company`, "Company") +
    f(`r${i}-title`, "Job Title") +
    f(`r${i}-startDate`, "Start Date") +
    f(`r${i}-endDate`, "End Date") +
    f(`r${i}-description`, "Responsibilities", "textarea")
  );
}

describe("experience dates + description", () => {
  it("classifies and fills start/end date and description per row", () => {
    document.body.innerHTML = row(0);
    const { fields } = scanPage(profile, false);
    const by = (c: string) => fields.find((f) => f.category === c);
    expect(by("experienceStartDate")?.proposedValue).toBe("2020-01");
    expect(by("experienceEndDate")?.proposedValue).toBe("2022-06");
    expect(by("experienceDescription")?.proposedValue).toBe("Built things.");
  });

  it("fills the correct row for a multi-row form", () => {
    document.body.innerHTML = row(0) + row(1);
    const { fields } = scanPage(profile, false);
    const starts = fields
      .filter((f) => f.category === "experienceStartDate")
      .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
    expect(starts.map((f) => f.proposedValue)).toEqual(["2020-01", "2022-07"]);
  });

  it("does NOT pull an employment date for a standalone availability 'Start Date'", () => {
    document.body.innerHTML = `<div><label for="avail">When can you start? Start Date</label><input id="avail" name="availableStartDate"></div>`;
    const { fields } = scanPage(profile, false);
    // classified as a start date but with no row index → resolves to nothing
    const f = fields[0];
    expect(f?.proposedValue).toBeNull();
  });
});
