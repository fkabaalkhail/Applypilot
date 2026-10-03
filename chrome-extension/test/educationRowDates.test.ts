/**
 * Greenhouse's EDUCATION block carries its own "Start date month / year" and
 * "End date month / year" controls. They classify as experience dates, and the
 * Greenhouse adapter filled them with the first JOB's dates: Jan 2025 - Apr
 * 2025 (Shopify) as the applicant's university dates (Twitch, Astranis, live
 * 2026-10-03). Markup below is the live structure, trimmed: ids and the
 * `education--form` / `education--date-container` wrappers are verbatim; the
 * month react-selects are native selects here (same option list).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { isDefaultSelected } from "../src/shared/selection";
import { greenhouseAdapter } from "../src/content/adapters/greenhouse";
import { stubLayout } from "./helpers/layout";
import { SPARSE_CANADIAN } from "./fixtures/profiles";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthSelect = (id: string, label: string): string =>
  `<label for="${id}">${label}</label><select id="${id}"><option value=""></option>${MONTHS.map((m) => `<option>${m}</option>`).join("")}</select>`;
const yearInput = (id: string, label: string): string => `<label for="${id}">${label}</label><input id="${id}" type="number">`;

const PAGE = `<form>
  <div class="education--container"><div class="education--form">
    <label for="school--0">School</label><input id="school--0" type="text">
    <div class="education--date-container">
      ${monthSelect("start-month--0", "Start date month")}${yearInput("start-year--0", "Start date year")}
      ${monthSelect("end-month--0", "End date month")}${yearInput("end-year--0", "End date year")}
    </div>
  </div></div>
  <div class="employment--container"><div class="employment--form">
    <label for="company-name-0">Company name</label><input id="company-name-0" type="text">
    ${monthSelect("start-date-month-0", "Start date month")}${yearInput("start-date-year-0", "Start date year")}
  </div></div>
</form>`;

const scan = (profile = SPARSE_CANADIAN) => {
  document.body.innerHTML = PAGE;
  const fields = scanPage(profile, false, greenhouseAdapter).fields;
  const byId = (id: string) => fields.find((f) => document.querySelector(`[data-ap-field="${f.id}"]`)?.id === id);
  return byId;
};

describe("education-row dates are the school's, never a job's", () => {
  it("leaves the education START date blank (the profile has none)", () => {
    const f = scan();
    expect(f("start-month--0")?.proposedValue ?? null).toBeNull();
    expect(f("start-year--0")?.proposedValue ?? null).toBeNull();
  });

  it("fills the education END year from the graduation, and leaves the month blank for a bare year", () => {
    const f = scan();
    expect(f("end-year--0")?.proposedValue).toBe("2027");
    expect(f("end-month--0")?.proposedValue ?? null).toBeNull();
    expect(f("end-year--0")?.category).toBe("graduationYear");
  });

  it("uses the graduation month when the profile has one", () => {
    const f = scan({ ...SPARSE_CANADIAN, education: [{ ...SPARSE_CANADIAN.education![0], graduationYear: "2027-04" }] });
    expect(f("end-month--0")?.proposedValue).toBe("April");
    expect(f("end-year--0")?.proposedValue).toBe("2027");
  });

  it("the employment block still gets the job's dates", () => {
    const f = scan();
    expect(f("start-date-month-0")?.proposedValue).toBe("January");
    expect(f("start-date-year-0")?.proposedValue).toBe("2025");
  });
});

describe("the expected graduation MONTH fills split end-date controls (2026-10-03)", () => {
  it("Greenhouse: End date month from the profile's expected graduation (Robinhood requires it)", () => {
    const f = scan({ ...SPARSE_CANADIAN, expectedGraduation: "2027-04" });
    expect(f("end-month--0")?.proposedValue).toBe("April");
    expect(f("end-year--0")?.proposedValue).toBe("2027");
  });

  it("a month for another year is not this row's", () => {
    const f = scan({ ...SPARSE_CANADIAN, expectedGraduation: "2028-04" });
    expect(f("end-month--0")?.proposedValue ?? null).toBeNull();
    expect(f("end-year--0")?.proposedValue).toBe("2027");
  });
});

/**
 * Ashby's education block as rendered live (Ramp, 2026-10-03; classes trimmed,
 * structure and ids verbatim): each label points at a CONTAINER div holding a
 * month select and a year select, neither with an id; "Still Student?" is a
 * checkbox inside its own label.
 */
const ashbyDate = (id: string, label: string): string => {
  const months = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  const years = Array.from({ length: 11 }, (_, i) => 2030 - i).map((y) => `<option value="${y}">${y}</option>`).join("");
  return `<div class="_educationFlexField"><label class="ashby-application-form-question-title" for="${id}">${label}</label>
    <div class="_stack _horizontal" id="${id}">
      <div class="ashby-application-form-input-dropdown"><select class="ashby-application-form-input-dropdown-select"><option disabled="" hidden="" value="">Month...</option>${months}</select></div>
      <div class="ashby-application-form-input-dropdown"><select class="ashby-application-form-input-dropdown-select"><option disabled="" hidden="" value="">Year...</option>${years}</select></div>
    </div></div>`;
};
const ASHBY_EDU = `<form><div class="_educationEntry">
  ${ashbyDate("_systemfield_education_history-startDate", "Start Date")}
  ${ashbyDate("_systemfield_education_history-endDate", "End Date")}
  <label class="ashby-application-form-question-title" for="_systemfield_education_history-isCurrent"><div><span><input type="checkbox" id="_systemfield_education_history-isCurrent"></span>Still Student?</div></label>
</div></form>`;

describe("Ashby's education dates and 'Still Student?' (Ramp / Superhuman, live 2026-10-03)", () => {
  const scanAshby = (profile = { ...SPARSE_CANADIAN, expectedGraduation: "2027-04" }) => {
    document.body.innerHTML = ASHBY_EDU;
    const fields = scanPage(profile, false).fields;
    const selects = Array.from(document.querySelectorAll("select"));
    const at = (el: Element) => fields.find((x) => el.getAttribute("data-ap-field") === x.id);
    return { selects: selects.map((s) => at(s)), still: at(document.getElementById("_systemfield_education_history-isCurrent")!) };
  };

  it("the year selects are named by their container's label, not the month list beside them", () => {
    const { selects } = scanAshby();
    expect(selects.map((f) => f?.label.replace(/\*$/, ""))).toEqual(["Start Date", "Start Date", "End Date", "End Date"]);
  });

  it("End Date takes the graduation month and year; Start Date stays blank", () => {
    const { selects } = scanAshby();
    expect(selects.map((f) => f?.proposedValue ?? null)).toEqual([null, null, "April", "2027"]);
  });

  it("'Still Student?' is ticked while the degree is in progress", () => {
    expect(scanAshby().still?.proposedValue).toBe("yes");
    // Selected on its own evidence (its label classifies weakly): proposed but never filled live.
    expect(isDefaultSelected(scanAshby().still!)).toBe(true);
    const grad = { ...SPARSE_CANADIAN, education: [{ school: "University of Toronto", degree: "BSc", graduationYear: "2022" }] };
    expect(scanAshby(grad).still?.proposedValue).toBe("no");
  });
});

describe("an Ashby radio group is never a row's graduation year (Superhuman, live 2026-10-03)", () => {
  it("'When is your expected graduation date?' reaches the question resolver: the month-range option", () => {
    const opts = ["2026", "January - June 2027", "December 2027", "May/June 2028", "December 2028", "2029"];
    const uuid = "539c8672-218c-40a3-a472-12def86fba63";
    const radios = opts
      .map((o, i) => `<div><input type="radio" id="${uuid}-labeled-radio-${i}" name="${uuid}" value="${o}"><label for="${uuid}-labeled-radio-${i}">${o}</label></div>`)
      .join("");
    document.body.innerHTML = `<form><fieldset class="ashby-application-form-field-entry"><legend>When is your expected graduation date?</legend>${radios}</fieldset></form>`;
    const f = scanPage({ ...SPARSE_CANADIAN, expectedGraduation: "2027-04" }, false).fields;
    expect(f[0].proposedValue).toBe("January - June 2027");
  });
});
