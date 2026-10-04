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
  it("maps first/last name, email, phone, country, and city", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_firstName"), generic)?.category).toBe("firstName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("legalNameSection_lastName"), generic)?.category).toBe("lastName");
    expect(workdayAdapter.classify!(ctxWithAutomationId("email"), generic)?.category).toBe("email");
    expect(workdayAdapter.classify!(ctxWithAutomationId("phone-number"), generic)?.category).toBe("phone");
    expect(workdayAdapter.classify!(ctxWithAutomationId("countryDropdown"), generic)?.category).toBe("country");
    expect(workdayAdapter.classify!(ctxWithAutomationId("addressSection_city"), generic)?.category).toBe("addressCity");
  });
  /**
   * Found by the Workday replica (one click to Review, 2026-10-03): the State
   * dropdown read as the COUNTRY, Phone Device Type and Phone Extension as
   * the phone NUMBER, so the state and device type stayed empty (a required
   * pair that parked the flow) and the number was typed into the Extension.
   * Workday's own bundle names these countryRegion (filled from an address's
   * state, options from countries/{id}/regions), phoneType and extension.
   */
  it("reads countryRegion as the state, in either markup", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("addressSection_countryRegion"), generic)?.category).toBe("addressState");
    expect(workdayAdapter.classify!(ctxWithAutomationId("formField-countryRegion"), generic)?.category).toBe("addressState");
  });
  it("reads the phone widgets by what they are, hyphenated or not", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("phone-device-type"), generic)?.category).toBe("phoneDeviceType");
    expect(workdayAdapter.classify!(ctxWithAutomationId("formField-phoneType"), generic)?.category).toBe("phoneDeviceType");
    expect(workdayAdapter.classify!(ctxWithAutomationId("country-phone-code"), generic)?.category).toBe("phoneCountryCode");
    expect(workdayAdapter.classify!(ctxWithAutomationId("formField-phoneNumber"), generic)?.category).toBe("phone");
  });
  it("never reads an extension or an SMS opt-in as the phone number", () => {
    for (const aid of ["phone-extension", "formField-extension", "phone-sms-opt-in", "phone-whatsapp-opt-in"]) {
      expect(workdayAdapter.classify!(ctxWithAutomationId(aid), generic)?.category, aid).not.toBe("phone");
    }
  });
  it("declines for an unknown automation id", () => {
    expect(workdayAdapter.classify!(ctxWithAutomationId("someRandomWidget"), generic)).toBeUndefined();
  });
});

describe("workdayAdapter.resolveAnswer", () => {
  it("resolves the country from profile.country for a Workday country field", () => {
    const ctx = ctxWithAutomationId("countryDropdown");
    const profile = { country: "Canada", location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "country", profile, control: { controlType: "combobox" }, fillEEO: false, el: ctx.el })).toBe("Canada");
  });
  it("never answers the state's countryRegion widget with the country, whatever classified it", () => {
    const ctx = ctxWithAutomationId("addressSection_countryRegion");
    const profile = { country: "Canada", location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "country", profile, control: { controlType: "combobox" }, fillEEO: false, el: ctx.el })).toBeUndefined();
  });
  it("falls back to the country parsed from location when profile.country is empty", () => {
    const ctx = ctxWithAutomationId("countryDropdown");
    const profile = { location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "country", profile, control: { controlType: "combobox" }, fillEEO: false, el: ctx.el })).toBe("Canada");
  });
  it("declines a Workday city field, deferring to the generic addressCity resolver", () => {
    const ctx = ctxWithAutomationId("addressSection_city");
    const profile = { addressCity: "Ottawa", location: "Ottawa, ON, Canada" } as unknown as UserApplicationProfile;
    expect(workdayAdapter.resolveAnswer!({ category: "addressCity", profile, control: { controlType: "text" }, fillEEO: false, el: ctx.el })).toBeUndefined();
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

  it("refuses a value that is not a date, and types nothing into the parts", async () => {
    // Handed off, the generic writer typed the text into one spinbutton.
    const w = dateWidget();
    for (const v of ["not a date", "Present"]) {
      const op = workdayAdapter.fillOperation!(fillCtx(w.el, v));
      expect(op, v).toBeInstanceOf(Promise);
      expect((await op!).filled, v).toBe(false);
    }
    expect([w.month.value, w.day.value, w.year.value]).toEqual(["", "", ""]);
  });

  /**
   * Found by the Workday replica (2026-10-03): a résumé's "Jun 2012" was not a
   * date to this adapter, so every work-history date went in as text and the
   * Month box read "2012".
   */
  it("takes a month by name or number, as a résumé writes a job's dates", async () => {
    const cases: [string, string, string][] = [
      ["Jun 2012", "6", "2012"],
      ["June 2012", "6", "2012"],
      ["Sept. 2019", "9", "2019"],
      ["Dec 2022", "12", "2022"],
      ["06/2012", "6", "2012"],
    ];
    for (const [v, month, year] of cases) {
      document.body.innerHTML = "";
      const w = dateWidget();
      expect(await workdayAdapter.fillOperation!(fillCtx(w.el, v))!, v).toEqual({ filled: true });
      expect([w.month.value, w.year.value, w.day.value], v).toEqual([month, year, ""]);
    }
  });
});

describe("workdayAdapter.classify, ids that only LOOK like another field", () => {
  it("the ethnicity dropdown is never the city", () => {
    for (const aid of ["ethnicityDropdown", "formField-ethnicityMulti"]) {
      expect(workdayAdapter.classify!(ctxWithAutomationId(aid), generic)?.category, aid).not.toBe("addressCity");
    }
    expect(workdayAdapter.classify!(ctxWithAutomationId("formField-city"), generic)?.category).toBe("addressCity");
  });
  it("an education row's lastYearAttended is its graduation year", () => {
    const el = document.createElement("input");
    el.id = "education-31--lastYearAttended-dateSectionYear-input";
    el.setAttribute("data-automation-id", "dateSectionYear-input");
    document.body.append(el);
    const ctx = { el, signals: {} as FieldContext["signals"], controlType: "text" as const };
    expect(workdayAdapter.classify!(ctx, generic)?.category).toBe("graduationYear");
  });
});
