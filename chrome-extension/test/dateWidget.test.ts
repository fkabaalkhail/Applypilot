/**
 * Split-date <select> widgets — a Month/Day/Year trio that shares one visual
 * label ("Date of birth", "Graduation date"). The AI resolves the single date
 * value to each sub-select, so a full date answer ("1995-06-15") must reduce to
 * the right part for whichever select it lands in. Handled inside
 * matchSelectOption so write AND verify agree, with no scanner change.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import type { RuntimeControl } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

function select(options: string[], values?: string[]): HTMLSelectElement {
  const el = document.createElement("select");
  // A leading placeholder like real date selects.
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Select…";
  el.append(ph);
  options.forEach((text, i) => {
    const o = document.createElement("option");
    o.textContent = text;
    o.value = values ? values[i] : text;
    el.append(o);
  });
  document.body.append(el);
  return el;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const YEARS = Array.from({ length: 61 }, (_, i) => String(1950 + i));

describe("split-date select reduction (one ISO answer → each part)", () => {
  it("fills a month-NAME select from a full date", () => {
    const el = select(MONTH_NAMES);
    const control: RuntimeControl = { id: "m", controlType: "select", el };
    expect(writeControl(control, "1995-06-15").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("June");
    expect(verifyControl(control, "1995-06-15")).toBe(true);
  });

  it("fills a numeric MONTH select (1–12) from a full date", () => {
    const el = select(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    const control: RuntimeControl = { id: "m", controlType: "select", el };
    expect(writeControl(control, "1995-06-15").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("6");
  });

  it("fills a DAY select (1–31) from a full date", () => {
    const el = select(DAYS);
    const control: RuntimeControl = { id: "d", controlType: "select", el };
    expect(writeControl(control, "1995-06-15").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("15");
  });

  it("fills a YEAR select from a full date", () => {
    const el = select(YEARS);
    const control: RuntimeControl = { id: "y", controlType: "select", el };
    expect(writeControl(control, "1995-06-15").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("1995");
  });

  it("also reduces alternate date formats (MM/DD/YYYY, 'June 1995')", () => {
    const m1 = select(MONTH_NAMES);
    expect(writeControl({ id: "a", controlType: "select", el: m1 }, "06/15/1995").written).toBe(true);
    expect(m1.options[m1.selectedIndex].textContent).toBe("June");

    const y1 = select(YEARS);
    expect(writeControl({ id: "b", controlType: "select", el: y1 }, "June 1995").written).toBe(true);
    expect(y1.options[y1.selectedIndex].textContent).toBe("1995");
  });
});

describe("non-date selects are never touched by date reduction", () => {
  it("a country select with a plain answer matches normally", () => {
    const el = select(["United States", "Canada", "United Kingdom"]);
    const control: RuntimeControl = { id: "c", controlType: "select", el };
    expect(writeControl(control, "Canada").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("Canada");
  });

  it("a numeric-range select ('2-3 years') is unaffected by a non-date number answer", () => {
    const el = select(["0-1 years", "2-3 years", "4-5 years", "6+ years"]);
    const control: RuntimeControl = { id: "e", controlType: "select", el };
    // "3" is a plain number, not a date — must NOT be treated as a day/month.
    expect(writeControl(control, "3 years").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("2-3 years");
  });

  it("a year answer to a non-date select still works via normal matching", () => {
    const el = select(["Remote", "Hybrid", "On-site"]);
    const control: RuntimeControl = { id: "f", controlType: "select", el };
    expect(writeControl(control, "Remote").written).toBe(true);
    expect(el.options[el.selectedIndex].textContent).toBe("Remote");
  });
});
