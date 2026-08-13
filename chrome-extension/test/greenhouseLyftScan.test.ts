// chrome-extension/test/greenhouseLyftScan.test.ts
/**
 * End-to-end scan of the REAL Lyft application form (fixtures/greenhouseLyftReal),
 * the form behind autofill_reports #167 on 2026-08-12: 24 fields, 11 filled,
 * 13 failed.
 *
 * The unit tests in greenhouseLyftReal.test.ts pin each fix in isolation. This
 * one runs the whole scanner over the actual markup and asserts what the user
 * would have seen in the panel, which is the level the bugs were reported at:
 * "some answers were answered weirdly" and "date pickers were not working".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { getAdapter } from "../src/content/adapters/registry";
import { GH_LYFT_FORM, GH_CERTIFICATION_STATEMENT } from "./fixtures/greenhouseLyftReal";
import type { DetectedField, UserApplicationProfile } from "../src/shared/types";
import "../src/content/adapters/greenhouse";

let restore: () => void;
beforeAll(() => { restore = stubLayout(); });
afterAll(() => restore());
beforeEach(() => { document.body.innerHTML = ""; });

const profile: UserApplicationProfile = {
  firstName: "Wissam", lastName: "Elmasry",
  email: "elmasry.wissam@gmail.com", phone: "+1 555 0100",
  location: "Toronto, ON", addressStreet: "1 King St", addressCity: "Toronto",
  addressState: "ON", postalCode: "M5H 1A1", country: "Canada",
  linkedin: "", github: "", portfolio: "",
  currentCompany: "Tailrd", currentTitle: "Software Engineer",
  workAuthorization: "Authorized to work in Canada", requiresSponsorship: "No",
  dateOfBirth: "", coverLetter: "", skills: [],
  education: [{ degree: "BSc Computer Science", school: "University of Toronto", graduationYear: "2025" }],
  experience: [{ title: "Software Engineer", company: "Tailrd", startDate: "2023-06", endDate: "", description: "" }],
  eeo: { gender: "Male" },
} as UserApplicationProfile;

function scan(): DetectedField[] {
  document.body.innerHTML = GH_LYFT_FORM;
  // The Greenhouse adapter is what splits the dates; resolve it the way the
  // content script does rather than passing null and testing a path that
  // never runs on greenhouse.io.
  const adapter = getAdapter("job-boards.greenhouse.io", "https://job-boards.greenhouse.io/embed/job_app?for=lyft");
  return scanPage(profile, true, adapter).fields;
}

const find = (fields: DetectedField[], needle: string) =>
  fields.find((f) => f.label.toLowerCase().includes(needle.toLowerCase()));

describe("Lyft on Greenhouse: nothing is answered weirdly", () => {
  it("does not type the applicant's employer into the certification statement", () => {
    // The bug as shipped: category currentCompany, proposedValue "Tailrd",
    // outcome "filled". Lyft received the company name in their legal box.
    const f = find(scan(), GH_CERTIFICATION_STATEMENT.slice(0, 60));
    expect(f, "certification field detected").toBeTruthy();
    expect(f!.category).not.toBe("currentCompany");
    expect(f!.proposedValue).not.toBe("Tailrd");
  });

  it("does not answer 'May we contact your current employer?' with a company name", () => {
    const f = find(scan(), "may we contact your current employer");
    expect(f, "contact-employer question detected").toBeTruthy();
    expect(f!.category).not.toBe("currentCompany");
    expect(f!.proposedValue).not.toBe("Tailrd");
  });

  it("does not offer a gender answer to the pronouns question", () => {
    // Live report: 'No option matches "Male" (saw: She / Her | He / Him | …)'
    const f = find(scan(), "gender pronouns");
    expect(f, "pronouns field detected").toBeTruthy();
    expect(f!.category).toBe("eeoPronouns");
    expect(f!.proposedValue).not.toBe("Male");
  });

  it("does not type a job title into the 'Current role' checkbox", () => {
    const fields = scan();
    const f = fields.find((x) => x.controlType === "checkbox" && /current role/i.test(x.label));
    expect(f, "current-role checkbox detected").toBeTruthy();
    expect(f!.proposedValue).not.toBe("Software Engineer");
    expect(f!.proposedValue).toBe("yes"); // no end date on row 0 → current
  });

  it("still fills the fields it always got right", () => {
    const fields = scan();
    expect(find(fields, "company name")!.proposedValue).toBe("Tailrd");
    expect(find(fields, "title")!.proposedValue).toBe("Software Engineer");
    expect(find(fields, "school")!.proposedValue).toBe("University of Toronto");
    expect(find(fields, "discipline")!.proposedValue).toBe("Computer Science");
  });

  it("offers the Degree dropdown a level, not the full degree title", () => {
    // Greenhouse's Degree control is a combobox listing levels, so the title
    // matched nothing and the engine wiped what it typed (report #168). The
    // three education controls now each get the shape they actually accept:
    // School the institution, Degree the level, Discipline the subject.
    expect(find(scan(), "degree")!.proposedValue).toBe("Bachelor");
  });
});

describe("Lyft on Greenhouse: the date pickers fill", () => {
  it("proposes the spelled-out month for the start-date combobox", () => {
    // Greenhouse's month list reads "June"; the stored value is "2023-06", and
    // writing that raw is why the control stayed empty.
    const f = find(scan(), "start date month");
    expect(f, "start date month detected").toBeTruthy();
    expect(f!.controlType).toBe("combobox");
    expect(f!.proposedValue).toBe("June");
  });

  it("proposes the bare year for the start-date year input", () => {
    const f = find(scan(), "start date year");
    expect(f, "start date year detected").toBeTruthy();
    expect(f!.proposedValue).toBe("2023");
  });

  it("leaves the end date empty for a role with no end date", () => {
    // Row 0 is the current job. Inventing an end month here would be worse
    // than leaving it for the user.
    const fields = scan();
    expect(find(fields, "end date month")!.proposedValue).toBeNull();
    expect(find(fields, "end date year")!.proposedValue).toBeNull();
  });

  it("reads the row index off every suffixed Greenhouse id", () => {
    // The whole employment row hangs off this: groupIndex null meant every
    // date resolved to null no matter what the profile held.
    const fields = scan();
    for (const label of ["start date month", "start date year", "company name", "title"]) {
      expect(find(fields, label)!.groupIndex, `${label} groupIndex`).toBe(0);
    }
  });
});
