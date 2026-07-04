// chrome-extension/test/leverAdapter.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { leverAdapter } from "../src/content/adapters/lever";
import type { FieldContext, FillContext } from "../src/content/adapters/types";
import type { RuntimeControl } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

function fieldCtx(attrs: Record<string, string>): FieldContext {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return { el, signals: {} as FieldContext["signals"], controlType: "text" };
}

const generic = { category: "unknown" as const, confidence: 0, sensitive: false };

describe("leverAdapter.match", () => {
  it("matches lever.co hosts (incl. EU) but not look-alikes", () => {
    expect(leverAdapter.match("jobs.lever.co", "https://jobs.lever.co/acme/x/apply")).toBe(true);
    expect(leverAdapter.match("jobs.eu.lever.co", "")).toBe(true);
    expect(leverAdapter.match("lever.co.evil.com", "")).toBe(false);
    expect(leverAdapter.match("example.com", "")).toBe(false);
  });
});

describe("leverAdapter.classify", () => {
  it("maps a current-company / org field", () => {
    expect(leverAdapter.classify!(fieldCtx({ name: "org" }), generic)?.category).toBe("currentCompany");
    expect(leverAdapter.classify!(fieldCtx({ name: "current-company" }), generic)?.category).toBe("currentCompany");
  });
  it("declines unrelated fields", () => {
    expect(leverAdapter.classify!(fieldCtx({ name: "cards[abc][field0]" }), generic)).toBeUndefined();
  });
});

describe("leverAdapter location typeahead", () => {
  function mountLocation(): { input: HTMLInputElement; hidden: HTMLInputElement } {
    const wrap = document.createElement("div");
    wrap.className = "application-question";
    wrap.innerHTML =
      '<input type="text" name="location" data-qa="location-input" autocomplete="off">' +
      '<input type="hidden" name="selectedLocation" value="">';
    document.body.append(wrap);
    return {
      input: wrap.querySelector('[data-qa="location-input"]') as HTMLInputElement,
      hidden: wrap.querySelector('input[name="selectedLocation"]') as HTMLInputElement,
    };
  }
  const fill = (el: HTMLInputElement, value: string): FillContext => ({
    control: { id: "x", controlType: "text", el } as RuntimeControl,
    value,
    el,
  });

  it("fills the visible input AND the hidden selectedLocation Lever reads", async () => {
    const { input, hidden } = mountLocation();
    const op = leverAdapter.fillOperation!(fill(input, "Ottawa, ON, Canada"));
    expect(op).toBeInstanceOf(Promise); // adapter claims the field
    const result = await op!;
    expect(result.filled).toBe(true);
    expect(input.value).toBe("Ottawa, ON, Canada");
    expect(hidden.value).toBe(JSON.stringify({ name: "Ottawa, ON, Canada" }));
  });

  it("declines (undefined) a plain text field so the generic writer handles it", () => {
    const el = document.createElement("input");
    el.type = "text";
    el.name = "cards[abc][field0]";
    document.body.append(el);
    expect(leverAdapter.fillOperation!(fill(el, "hello"))).toBeUndefined();
  });
});
