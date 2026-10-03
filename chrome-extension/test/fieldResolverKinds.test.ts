/**
 * The kind gate in fieldResolver: a value is coerced into what the field
 * accepts, or refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { stubLayout } from "./helpers/layout";
import { SPARSE_CANADIAN, TEST_TODAY } from "./fixtures/profiles";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TEST_TODAY);
});
afterAll(() => {
  restore();
  vi.useRealTimers();
});

const scan = (html: string, profile = SPARSE_CANADIAN) => {
  document.body.innerHTML = `<form>${html}</form>`;
  return scanPage(profile, false, null).fields;
};

describe("number fields", () => {
  it("'120k' is 120000, not 120; a range is refused", () => {
    const f = scan(`<label for="s">Desired salary</label><input id="s" type="number">`, { ...SPARSE_CANADIAN, salaryExpectation: "120k" });
    expect(f[0].proposedValue).toBe("120000");
    const g = scan(`<label for="s">Desired salary</label><input id="s" type="number">`, { ...SPARSE_CANADIAN, salaryExpectation: "100,000-120,000" });
    expect(g[0].proposedValue).toBeNull();
  });
});

describe("a yes/no free-text question never takes a place name", () => {
  it("'Are you currently located in Quebec?' (text input) → No, not 'Toronto'", () => {
    const f = scan(`<label for="q">Are you currently located in Quebec?</label><input id="q" type="text">`);
    expect(f[0].proposedValue).toBe("No");
  });
  it("an unrecognized yes/no question with a location category gets nothing", () => {
    const f = scan(`<label for="q">Is your current location within commuting distance of our office?</label><input id="q" type="text">`);
    expect(f[0].proposedValue ?? "").not.toMatch(/toronto/i);
  });
});

describe("date controls take a whole date in their own format (dateControl.ts)", () => {
  // Ashby's "What is your graduation date?" as rendered live (2026-10-03): a
  // react-datepicker. The profile knows the YEAR only; the picker turned a
  // typed "2027" into 12/31/2026.
  const ashbyPicker = (label: string) =>
    `<div class="ashby-application-form-field-entry"><label for="d">${label}</label><div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input id="d" type="text" placeholder="Pick date..." class="ashby-application-form-input-date"></div></div></div>`;

  it("a graduation YEAR is never typed into a date picker", () => {
    const f = scan(ashbyPicker("What is your graduation date?"));
    expect(f[0].proposedValue).toBeNull();
    expect(f[0].dateFormat).toBe("MM/DD/YYYY");
  });

  it("nor into a native date input", () => {
    const f = scan(`<label for="d">Graduation date</label><input id="d" type="date">`);
    expect(f[0].proposedValue).toBeNull();
  });

  it("a plain text box asking for the graduation date still gets the year", () => {
    const f = scan(`<label for="d">Graduation date</label><input id="d" type="text">`);
    expect(f[0].proposedValue).toBe("2027");
    expect(f[0].dateFormat).toBeUndefined();
  });

  it("a whole computed date goes into the picker in the picker's format", () => {
    // TEST_TODAY 2026-10-03 + "2 weeks" notice → 2026-10-17.
    const f = scan(ashbyPicker("Earliest start date"), { ...SPARSE_CANADIAN, noticePeriod: "2 weeks" });
    expect(f[0].proposedValue).toBe("10/17/2026");
  });
});

describe("a high school field never gets the university (Palantir on Lever, live 2026-10-03)", () => {
  it("leaves High School Name and its graduation year blank", () => {
    const f = scan(
      `<label for="hs">High School Name</label><textarea id="hs"></textarea>` +
        `<label for="hy">Year of High School Graduation</label><select id="hy"><option value="">Select...</option><option>2020</option><option>2021</option><option>2027</option></select>` +
        `<label for="u">Which university are you currently attending or did you last attend?</label><input id="u" type="text">`
    );
    expect(f[0].proposedValue).toBeNull();
    expect(f[1].proposedValue).toBeNull();
    expect(f[2].proposedValue).toBe("University of Waterloo");
  });
});

describe("a demographic-data consent box (Robinhood, live 2026-10-03)", () => {
  it("is ticked and selected like every application consent, whatever its category score", () => {
    const f = scan(
      `<div class="checkbox__wrapper"><input type="checkbox" id="gdpr_demographic_data_consent_given_1" name="gdpr_demographic_data_consent_given" required>` +
        `<label for="gdpr_demographic_data_consent_given_1">By checking this box, I consent to Robinhood collecting, storing, and processing my responses to the demographic data surveys above.</label></div>`
    );
    expect(f[0].sensitive).toBe(true);
    expect(f[0].proposedValue).toBe("yes");
    expect(f[0].deterministic).toBe(true);
  });
});
