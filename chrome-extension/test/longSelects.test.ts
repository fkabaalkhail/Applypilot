/**
 * selectOptions() caps a select's options at 60 to keep panel messages small,
 * and the scan-time option gate used to check proposals against THAT capped
 * list: a value past option 60 was dropped as "not offered". On a full
 * country list "United States" sits near position 235, so a US applicant's
 * Country select was never filled; Lever's university picker lost "University
 * of Waterloo" the same way (live, 2026-10-03). Resolution now sees every
 * option; only the copy shown in the panel is capped.
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

describe("long selects", () => {
  it("proposes an option that sits past the 60th", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `<option>Country ${String(i).padStart(3, "0")}</option>`).join("");
    document.body.innerHTML = `<form><label for="c">Country</label><select id="c"><option value="">Select...</option>${filler}<option>United States</option></select></form>`;
    const us = { ...SPARSE_CANADIAN, location: "Boston, MA, United States", workAuthorization: "US citizen" };
    const f = scanPage(us, false, null).fields.find((x) => x.label === "Country")!;
    expect(f.proposedValue).toBe("United States");
    expect(f.options!.length).toBeLessThanOrEqual(60); // the panel's copy stays capped
  });
});
