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
