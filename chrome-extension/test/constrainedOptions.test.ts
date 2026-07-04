/**
 * A deterministic profile value must never be proposed into a constrained-option
 * control (select / radio / checkbox group) when it cannot match any option.
 * Real-world trigger: Lever's "Which location are you applying for?" is a
 * <select> of company offices — filling the applicant's home city ("Ottawa")
 * can only fail ("No option matches"). The value must be dropped so the field
 * routes to the option-aware AI pass instead.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

function labeledSelect(label: string, id: string, options: string[]): string {
  const opts = ['<option value="">Select…</option>', ...options.map((o) => `<option value="${o}">${o}</option>`)].join("");
  return `<div><label for="${id}">${label}</label><select id="${id}">${opts}</select></div>`;
}

describe("constrained-option guard", () => {
  it("drops a location-category value that matches no office option", () => {
    document.body.innerHTML = `<form>
      <div><label for="fn">First Name</label><input id="fn"></div>
      ${labeledSelect("Which location are you applying for?", "office", ["San Diego", "Washington, DC", "Remote"])}
    </form>`;

    const field = scanPage(MOCK_PROFILE, false).fields.find((f) => f.id === document.getElementById("office")!.getAttribute("data-ap-field"));
    expect(field?.category).toBe("location"); // still classified as location…
    expect(field?.proposedValue).toBeNull(); // …but not filled with the home city
  });

  it("keeps a value that does match an option", () => {
    document.body.innerHTML = `<form>
      <div><label for="fn">First Name</label><input id="fn"></div>
      ${labeledSelect("Country", "country", ["United States", "Canada", "Mexico"])}
    </form>`;

    const field = scanPage(MOCK_PROFILE, false).fields.find((f) => f.id === document.getElementById("country")!.getAttribute("data-ap-field"));
    expect(field?.category).toBe("country");
    expect(field?.proposedValue).toBe("Canada");
  });
});
