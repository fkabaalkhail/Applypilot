import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountSuccessFactorsForm } from "./fixtures/successfactors";
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

/** The real control inside a UI5 host's open shadow root. */
function inner(hostId: string): HTMLInputElement | HTMLSelectElement {
  return document
    .getElementById(hostId)!
    .shadowRoot!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
}

describe("SuccessFactors UI5 shadow DOM — detection", () => {
  it("classifies fields living inside open shadow roots", () => {
    mountSuccessFactorsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of ["firstName", "lastName", "email", "phone", "location"]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file non-fillable", () => {
    mountSuccessFactorsForm(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });
});

describe("SuccessFactors UI5 shadow DOM — autofill", () => {
  it("fills the inner shadow controls; skips resume + EEO", async () => {
    mountSuccessFactorsForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(inner("sf-firstname-host").value).toBe("John");
    expect(inner("sf-lastname-host").value).toBe("Doe");
    expect(inner("sf-email-host").value).toBe("john@example.com");
    expect(inner("sf-phone-host").value).toBe("+1 555 555 5555");
    expect(inner("sf-city-host").value).toBe("Ottawa, ON, Canada");
    expect(inner("sf-country-host").value).toBe("Canada");
    expect(inner("sf-resume-host").value).toBe("");
    expect(inner("sf-gender-host").value).toBe("");
  });
});

describe("SuccessFactors UI5 shadow DOM — rescan after a step change", () => {
  it("re-detects a field added inside an existing shadow root", () => {
    mountSuccessFactorsForm(document);
    const first = scanPage(MOCK_PROFILE, false);
    const before = first.fields.length;

    // UI5 multi-step: a new field appears inside a host's open shadow root.
    const sr = document.getElementById("sf-firstname-host")!.shadowRoot!;
    const extra = document.createElement("input");
    extra.setAttribute("aria-label", "LinkedIn Profile");
    sr.appendChild(extra);

    const second = scanPage(MOCK_PROFILE, false);
    expect(second.fields.length).toBe(before + 1);
    expect(second.fields.some((f) => f.category === "linkedin")).toBe(true);
  });
});
