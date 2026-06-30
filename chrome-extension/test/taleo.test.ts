import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountTaleoForm } from "./fixtures/taleo";
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

describe("Taleo table-layout markup — detection", () => {
  it("classifies fields whose labels live in sibling table cells", () => {
    mountTaleoForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountTaleoForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("Taleo table-layout markup — autofill", () => {
  it("fills text fields and the country select; skips resume + EEO", async () => {
    mountTaleoForm(document);
    await runAutofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    expect(val("taleo-firstname")).toBe("John");
    expect(val("taleo-lastname")).toBe("Doe");
    expect(val("taleo-email")).toBe("john@example.com");
    expect(val("taleo-phone")).toBe("+1 555 555 5555");
    expect(val("taleo-city")).toBe("Ottawa, ON, Canada");
    expect(val("taleo-country")).toBe("Canada");
    expect(val("taleo-resume")).toBe("");
    expect(val("taleo-gender")).toBe("");
  });
});
