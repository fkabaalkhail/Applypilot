import { describe, it, expect, beforeEach } from "vitest";
import { formatForDateInput, writeControl, verifyControl } from "../src/content/writeEngine";
import type { RuntimeControl } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

function dateInput(type: "date" | "month" | "text"): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  document.body.append(el);
  return el;
}

describe("formatForDateInput", () => {
  it("reshapes flexible profile dates to ISO for a date input", () => {
    const el = dateInput("date");
    expect(formatForDateInput(el, "2020-01")).toBe("2020-01-01");
    expect(formatForDateInput(el, "Jan 2020")).toBe("2020-01-01");
    expect(formatForDateInput(el, "01/2020")).toBe("2020-01-01");
    expect(formatForDateInput(el, "3/15/2019")).toBe("2019-03-15");
    expect(formatForDateInput(el, "2018")).toBe("2018-01-01");
  });
  it("uses YYYY-MM for a month input", () => {
    expect(formatForDateInput(dateInput("month"), "March 2021")).toBe("2021-03");
  });
  it("leaves a plain text input and unparseable values untouched", () => {
    expect(formatForDateInput(dateInput("text"), "2020-01")).toBe("2020-01");
    expect(formatForDateInput(dateInput("date"), "sometime")).toBe("sometime");
  });
});

describe("write + verify round-trip on a date input", () => {
  it("writes ISO and verifies against the original flexible value (no reconciler loop)", () => {
    const el = dateInput("date");
    const control: RuntimeControl = { id: "d", controlType: "text", el };
    const res = writeControl(control, "Jan 2020");
    expect(res.written).toBe(true);
    expect(el.value).toBe("2020-01-01");
    expect(verifyControl(control, "Jan 2020")).toBe(true);
  });
});
