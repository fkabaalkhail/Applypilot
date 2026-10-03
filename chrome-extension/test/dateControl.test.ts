/**
 * Date controls take a whole value in their own format (dateControl.ts).
 *
 * Bug pinned (live, Ashby, 2026-10-03): "What is your graduation date?" is a
 * react-datepicker. The profile's graduation YEAR "2027" was typed into it,
 * the picker parsed it as new Date("2027") (UTC midnight, the previous evening
 * in Toronto) and the form ended up holding 12/31/2026.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { dateFormatFor, fitDate } from "../src/content/dateControl";

beforeEach(() => {
  document.body.innerHTML = "";
});

const input = (html: string): HTMLInputElement => {
  document.body.innerHTML = html;
  return document.querySelector("input")!;
};

describe("dateFormatFor", () => {
  it("reads Ashby's react-datepicker (the live markup) as a day-precise MM/DD/YYYY picker", () => {
    const el = input(
      `<div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" placeholder="Pick date..." class="_input_gc9ve_28 ashby-application-form-input-date"></div></div>`
    );
    expect(dateFormatFor(el, "text", "Pick date...")).toBe("MM/DD/YYYY");
  });

  it("reads the format from native types and from the placeholder", () => {
    expect(dateFormatFor(null, "date", "")).toBe("YYYY-MM-DD");
    expect(dateFormatFor(null, "month", "")).toBe("YYYY-MM");
    expect(dateFormatFor(null, "text", "MM/DD/YYYY")).toBe("MM/DD/YYYY");
    expect(dateFormatFor(null, "text", "dd/mm/yyyy")).toBe("DD/MM/YYYY");
    expect(dateFormatFor(null, "text", "YYYY-MM-DD")).toBe("YYYY-MM-DD");
    expect(dateFormatFor(null, "text", "MM/YYYY")).toBe("MM/YYYY");
  });

  it("knows the common picker libraries by class", () => {
    expect(dateFormatFor(input(`<input class="form-control flatpickr-input">`), "text", "")).toBe("MM/DD/YYYY");
    expect(dateFormatFor(input(`<input class="hasDatepicker">`), "text", "")).toBe("MM/DD/YYYY");
    expect(dateFormatFor(input(`<input data-provide="datepicker">`), "text", "")).toBe("MM/DD/YYYY");
  });

  it("a plain text box is not a date control, even when it asks for a date", () => {
    expect(dateFormatFor(input(`<label>Graduation date <input></label>`), "text", "")).toBeNull();
    expect(dateFormatFor(input(`<div class="update-datepickers-later"><input></div>`), "text", "e.g. 2027")).toBeNull();
  });
});

describe("fitDate", () => {
  it("never turns a partial date into a whole one", () => {
    expect(fitDate("2027", "MM/DD/YYYY")).toBeNull();
    expect(fitDate("2027", "YYYY-MM-DD")).toBeNull();
    expect(fitDate("2027-04", "MM/DD/YYYY")).toBeNull();
    expect(fitDate("2027", "MM/YYYY")).toBeNull();
    expect(fitDate("April 2027", "DD/MM/YYYY")).toBeNull();
  });

  it("re-emits a whole date in the control's own format", () => {
    expect(fitDate("1999-05-12", "MM/DD/YYYY")).toBe("05/12/1999");
    expect(fitDate("1999-05-12", "DD/MM/YYYY")).toBe("12/05/1999");
    expect(fitDate("1999-05-12", "YYYY-MM-DD")).toBe("1999-05-12");
    expect(fitDate("May 12, 1999", "MM/DD/YYYY")).toBe("05/12/1999");
    expect(fitDate("12 May 1999", "YYYY-MM-DD")).toBe("1999-05-12");
    expect(fitDate("2027-04", "MM/YYYY")).toBe("04/2027");
    expect(fitDate("April 2027", "YYYY-MM")).toBe("2027-04");
  });

  it("reads a slash date in the control's own day/month order, and rejects impossible ones", () => {
    expect(fitDate("10/17/2026", "MM/DD/YYYY")).toBe("10/17/2026");
    expect(fitDate("17/10/2026", "DD/MM/YYYY")).toBe("17/10/2026");
    expect(fitDate("17/10/2026", "MM/DD/YYYY")).toBeNull(); // no 17th month
    expect(fitDate("02/30/2027", "MM/DD/YYYY")).toBeNull();
  });

  it("is not fooled by text that only contains a date", () => {
    expect(fitDate("Expected May 2027", "MM/YYYY")).toBeNull();
    expect(fitDate("ASAP", "MM/DD/YYYY")).toBeNull();
    expect(fitDate("2 weeks", "MM/DD/YYYY")).toBeNull();
  });
});
