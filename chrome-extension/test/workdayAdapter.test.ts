// chrome-extension/test/workdayAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { workdayAdapter } from "../src/content/adapters/workday";
import type { FieldContext, FillContext } from "../src/content/adapters/types";
import type { RuntimeControl } from "../src/content/formScanner";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => { document.body.innerHTML = ""; });
const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

function ctxWithAutomationId(aid: string): FieldContext {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-automation-id", aid);
  const el = document.createElement("input");
  wrap.append(el);
  document.body.append(wrap);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}

describe("workdayAdapter.match", () => {
  it("matches Workday hosts", () => {
    expect(workdayAdapter.match("acme.wd5.myworkdayjobs.com", "")).toBe(true);
    expect(workdayAdapter.match("x.myworkdaysite.com", "")).toBe(true);
  });
  it("does not match other hosts", () => {
    expect(workdayAdapter.match("example.com", "")).toBe(false);
  });
});

describe("workdayAdapter.classify (by data-automation-id)", () => {
  it("maps first/last name, email, phone, and country", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_firstName"), generic)?.category).toBe("firstName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_lastName"), generic)?.category).toBe("lastName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("email"), generic)?.category).toBe("email");
    expect(workdayAdapter.classify!(ctxWithAutomationId("phone-number"), generic)?.category).toBe("phone");
    expect(workdayAdapter.classify!(ctxWithAutomationId("addressSection_countryRegion"), generic)?.category).toBe("location");
  });
  it("declines for an unknown automation id", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("someRandomWidget"), generic)).toBeUndefined();
  });
});

describe("workdayAdapter.resolveAnswer", () => {
  it("extracts the country from a comma location for a Workday country field", () => {
    const ctx = ctxWithAutomationId("addressSection_countryRegion");
    const profile = { location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "location", profile, control: { controlType: "combobox" }, fillEEO: false, el: ctx.el })).toBe("Canada");
  });
  it("declines for a non-country location field", () => {
    const ctx = ctxWithAutomationId("addressSection_city");
    const profile = { location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "location", profile, control: { controlType: "text" }, fillEEO: false, el: ctx.el })).toBeUndefined();
  });
});

describe("workdayAdapter.fillOperation (split date)", () => {
  function dateWidget(): { el: HTMLElement; month: HTMLInputElement; day: HTMLInputElement; year: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "formField-startDate");
    const month = document.createElement("input"); month.setAttribute("data-automation-id", "dateSectionMonth-input");
    const day = document.createElement("input"); day.setAttribute("data-automation-id", "dateSectionDay-input");
    const year = document.createElement("input"); year.setAttribute("data-automation-id", "dateSectionYear-input");
    wrap.append(month, day, year);
    document.body.append(wrap);
    return { el: wrap, month, day, year };
  }
  function fillCtx(el: HTMLElement, value: string): FillContext {
    const control: RuntimeControl = { id: "d", controlType: "text", el };
    return { control, value, el };
  }

  it("fills month/day/year from an ISO date and returns filled:true", async () => {
    const w = dateWidget();
    const op = workdayAdapter.fillOperation!(fillCtx(w.el, "2023-05-15"));
    expect(op).toBeInstanceOf(Promise);
    expect(await op!).toEqual({ filled: true });
    expect(w.month.value).toBe("5");
    expect(w.day.value).toBe("15");
    expect(w.year.value).toBe("2023");
  });

  it("declines (undefined) for a non-date Workday field", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-automation-id", "email");
    const el = document.createElement("input");
    wrap.append(el); document.body.append(wrap);
    expect(workdayAdapter.fillOperation!(fillCtx(el, "someone@example.com"))).toBeUndefined();
  });

  it("declines when the value is not a parseable date", () => {
    const w = dateWidget();
    expect(workdayAdapter.fillOperation!(fillCtx(w.el, "not a date"))).toBeUndefined();
  });
});
