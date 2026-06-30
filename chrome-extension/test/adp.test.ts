import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountAdpForm } from "./fixtures/adp";
import { stubLayout } from "./helpers/layout";
import { runAutofill } from "./helpers/autofill";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ADP div-layout markup — detection", () => {
  it("classifies fields across mixed label sources + non-semantic names", () => {
    mountAdpForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountAdpForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("ADP div-layout markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountAdpForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("adp-firstname")).toBe("John");
    expect(val("adp-lastname")).toBe("Doe");
    expect(val("adp-email")).toBe("john@example.com");
    expect(val("adp-phone")).toBe("+1 555 555 5555");
    expect(val("adp-city")).toBe("Ottawa, ON, Canada");
    expect(val("adp-country")).toBe("Canada");
    expect(val("adp-resume")).toBe("");
    expect(val("adp-gender")).toBe("");
  });
});
