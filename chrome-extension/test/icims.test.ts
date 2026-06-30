import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountIcimsForm } from "./fixtures/icims";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { runAutofill } from "./helpers/autofill";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

describe("iCIMS field markup — detection", () => {
  it("classifies the core fields", () => {
    mountIcimsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountIcimsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("iCIMS field markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountIcimsForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("icims-firstname")).toBe("John");
    expect(val("icims-lastname")).toBe("Doe");
    expect(val("icims-email")).toBe("john@example.com");
    expect(val("icims-phone")).toBe("+1 555 555 5555");
    expect(val("icims-city")).toBe("Ottawa, ON, Canada");
    expect(val("icims-country")).toBe("Canada");
    expect(val("icims-resume")).toBe("");
    expect(val("icims-gender")).toBe("");
  });
});
