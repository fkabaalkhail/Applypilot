import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mountGreenhouseForm,
  mountLeverForm,
  mountBambooHrForm,
  mountBreezyForm,
} from "./fixtures/easy";
import { stubLayout } from "./helpers/layout";
import { runAutofill, PROFILE_NO_EEO } from "./helpers/autofill";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { setResolveContext } from "../src/content/fieldResolver";

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
  it("detects + fills the full form; skips resume, EEO declined", async () => {
    mountGreenhouseForm(document);
    const fields = scanPage(MOCK_PROFILE, false).fields;
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);

    await runAutofill(PROFILE_NO_EEO, false);
    expect(val("gh-firstname")).toBe("John");
    expect(val("gh-lastname")).toBe("Doe");
    expect(val("gh-email")).toBe("john@example.com");
    expect(val("gh-phone")).toBe("+1 555 555 5555");
    expect(val("gh-country")).toBe("Canada");
    expect(val("gh-linkedin")).toBe("https://linkedin.com/in/johndoe");
    expect(val("gh-cover")).toBe("Please generate or insert the saved cover letter here.");
    // MOCK_PROFILE is authorized in Canada but not the US, and this form names
    // no country: "require sponsorship?" could be about either, so it stays
    // blank (2026-10-03). With the job's country known it fills (next test).
    expect(document.querySelector('input[name="gh-sponsor"]:checked')).toBeNull();
    expect(val("gh-resume")).toBe("");
    // No EEO data: the form's own decline option (defaultAnswers policy, 2026-10-03), never a demographic value.
    expect(val("gh-gender")).toMatch(/decline|prefer not|not wish|wish to answer/i);
  });
});

describe("Greenhouse sponsorship follows the job's country", () => {
  it("No for a job in Canada, Yes for one in the US (the radio fills both ways)", async () => {
    try {
      mountGreenhouseForm(document);
      setResolveContext({ jobCountry: "CA" });
      await runAutofill(PROFILE_NO_EEO, false);
      expect((document.querySelector('input[name="gh-sponsor"]:checked') as HTMLInputElement | null)?.value).toBe("No");
      document.body.innerHTML = "";
      mountGreenhouseForm(document);
      setResolveContext({ jobCountry: "US" });
      await runAutofill(PROFILE_NO_EEO, false);
      expect((document.querySelector('input[name="gh-sponsor"]:checked') as HTMLInputElement | null)?.value).toBe("Yes");
    } finally {
      setResolveContext({ jobCountry: null });
    }
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
