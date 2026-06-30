import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mountGreenhouseForm,
  mountLeverForm,
  mountBambooHrForm,
  mountBreezyForm,
} from "./fixtures/easy";
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

const val = (id: string) =>
  (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

describe("Greenhouse", () => {
  it("detects + fills the full form; skips resume + EEO", async () => {
    mountGreenhouseForm(document);
    const fields = scanPage(MOCK_PROFILE, false).fields;
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);

    await runAutofill(MOCK_PROFILE, false);
    expect(val("gh-firstname")).toBe("John");
    expect(val("gh-lastname")).toBe("Doe");
    expect(val("gh-email")).toBe("john@example.com");
    expect(val("gh-phone")).toBe("+1 555 555 5555");
    expect(val("gh-country")).toBe("Canada");
    expect(val("gh-linkedin")).toBe("https://linkedin.com/in/johndoe");
    expect(val("gh-cover")).toBe("Please generate or insert the saved cover letter here.");
    expect((document.querySelector('input[name="gh-sponsor"]:checked') as HTMLInputElement | null)?.value).toBe("No");
    expect(val("gh-resume")).toBe("");
    expect(val("gh-gender")).toBe("");
  });
});

describe("Lever", () => {
  it("fills standard fields, country select, and the cover-letter textarea", async () => {
    mountLeverForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("lever-firstname")).toBe("John");
    expect(val("lever-email")).toBe("john@example.com");
    expect(val("lever-phone")).toBe("+1 555 555 5555");
    expect(val("lever-country")).toBe("Canada");
    expect(val("lever-cover")).toBe("Please generate or insert the saved cover letter here.");
  });
});

describe("BambooHR", () => {
  it("fills the short standard form", async () => {
    mountBambooHrForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("bamboo-firstname")).toBe("John");
    expect(val("bamboo-lastname")).toBe("Doe");
    expect(val("bamboo-email")).toBe("john@example.com");
    expect(val("bamboo-phone")).toBe("+1 555 555 5555");
  });
});

describe("Breezy HR", () => {
  it("fills the short standard form + country select", async () => {
    mountBreezyForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("breezy-firstname")).toBe("John");
    expect(val("breezy-email")).toBe("john@example.com");
    expect(val("breezy-country")).toBe("Canada");
  });
});
