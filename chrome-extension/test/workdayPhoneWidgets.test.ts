// chrome-extension/test/workdayPhoneWidgets.test.ts
/**
 * Workday splits a phone number into THREE controls, all `formField-*`:
 * countryPhoneCode (dialing prompt), phoneNumber (text), phoneType (device
 * prompt). Both satellites are dropdowns — writing the phone NUMBER into either
 * can only fail, and leaving them unclassified sends a required field to the AI
 * on every fill.
 *
 * Selectors under test live in src/content/adapters/workdaySelectors.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { workdayAdapter } from "../src/content/adapters/workday";
import { LOCAL_FAST_PATH } from "../src/content/aiFillPlanner";
import { FIELD_RULES } from "../src/content/adapters/workdaySelectors";
import type { FieldContext } from "../src/content/adapters/types";
import type { UserApplicationProfile } from "../src/shared/types";

beforeEach(() => {
  document.body.innerHTML = "";
});

const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

function ctxWithAutomationId(aid: string): FieldContext {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-automation-id", aid);
  const el = document.createElement("input");
  wrap.append(el);
  document.body.append(wrap);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}

function classify(aid: string) {
  return workdayAdapter.classify!(ctxWithAutomationId(aid), generic);
}

function resolve(aid: string, category: Parameters<NonNullable<typeof workdayAdapter.resolveAnswer>>[0]["category"], profile: Partial<UserApplicationProfile>) {
  const ctx = ctxWithAutomationId(aid);
  return workdayAdapter.resolveAnswer!({
    category,
    profile: profile as UserApplicationProfile,
    control: { controlType: "combobox" },
    fillEEO: false,
    el: ctx.el,
  });
}

describe("Workday phone satellites are classified apart from the number", () => {
  it("countryPhoneCode is its own category, not the address country", () => {
    expect(classify("formField-countryPhoneCode")?.category).toBe("phoneCountryCode");
  });
  it("phoneType is its own category, not the phone number", () => {
    expect(classify("formField-phoneType")?.category).toBe("phoneDeviceType");
  });
  it("the plain number field still classifies as phone", () => {
    expect(classify("formField-phoneNumber")?.category).toBe("phone");
    expect(classify("phone-number")?.category).toBe("phone");
  });
  it("the address country field still classifies as country", () => {
    expect(classify("addressSection_countryRegion")?.category).toBe("country");
  });
});

describe("Workday phone satellites resolve without the AI", () => {
  it("the dialing prompt takes the country name — 'Canada' matches 'Canada (+1)'", () => {
    expect(resolve("formField-countryPhoneCode", "phoneCountryCode", { country: "Canada" })).toBe("Canada");
  });
  it("the dialing prompt falls back to the country parsed from location", () => {
    expect(
      resolve("formField-countryPhoneCode", "phoneCountryCode", { location: "Ottawa, ON, Canada" })
    ).toBe("Canada");
  });
  it("the device type answers Mobile", () => {
    expect(resolve("formField-phoneType", "phoneDeviceType", { phone: "+1 555 555 5555" })).toBe("Mobile");
  });
  it("both stay on the local fast path (no backend round-trip)", () => {
    expect(LOCAL_FAST_PATH.has("phoneCountryCode")).toBe(true);
    expect(LOCAL_FAST_PATH.has("phoneDeviceType")).toBe(true);
  });
});

describe("workdaySelectors FIELD_RULES ordering is load-bearing", () => {
  it("the narrow phone widgets are matched before the broad country/phone rules", () => {
    const idx = (cat: string) => FIELD_RULES.findIndex(([, c]) => c === cat);
    expect(idx("phoneCountryCode")).toBeLessThan(idx("country"));
    expect(idx("phoneDeviceType")).toBeLessThan(idx("phone"));
  });
});
