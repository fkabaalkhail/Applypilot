import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountWorkdayMyInfo } from "./fixtures/workday";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { AutofillReconciler } from "../src/content/reconciler";
import { fillAriaCombobox } from "../src/content/comboboxEngine";
import type { UserApplicationProfile } from "../src/shared/types";

const fastCombo = { sleep: async () => {}, openWaitMs: 200, commitWaitMs: 200, pollMs: 10 };

/**
 * Run the real two-phase fill the content script performs in onAutofill:
 * the reconciler drives text/select/radio; the combobox engine drives ARIA
 * dropdowns one-shot. Mirrors src/content/contentScript.ts.
 */
async function autofill(profile: UserApplicationProfile, fillEEO: boolean): Promise<void> {
  const { fields, registry } = scanPage(profile, fillEEO);
  const targets = fields.filter((f) => f.fillable && f.proposedValue !== null);

  const engine = new AutofillReconciler({ sleep: async () => {}, observe: false });
  await engine.run(
    targets
      .filter((f) => f.controlType !== "combobox")
      .map((f) => ({ fieldId: f.id, value: f.proposedValue as string })),
    registry
  );
  engine.dispose();

  for (const f of targets.filter((f) => f.controlType === "combobox")) {
    await fillAriaCombobox(registry.get(f.id)!.el!, f.proposedValue as string, fastCombo);
  }
}

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Workday My Information — detection", () => {
  it("classifies the core profile fields", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const cats = new Set(fields.map((f) => f.category));
    for (const c of [
      "firstName",
      "lastName",
      "email",
      "phone",
      "location",
      "linkedin",
      "workAuthorization",
      "sponsorship",
      "resumeUpload",
    ]) {
      expect(cats.has(c), `expected a ${c} field`).toBe(true);
    }
  });

  it("flags EEO selects sensitive and the resume file as non-fillable", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.find((f) => f.category === "eeoGender")?.sensitive).toBe(true);
    const resume = fields.find((f) => f.category === "resumeUpload");
    expect(resume?.controlType).toBe("file");
    expect(resume?.fillable).toBe(false);
  });

  it("leaves the unmapped Source dropdown classified unknown", () => {
    mountWorkdayMyInfo(document);
    const { fields } = scanPage(MOCK_PROFILE, false);
    const source = fields.find((f) => f.label.toLowerCase().includes("hear about"));
    expect(source).toBeDefined();
    expect(source!.category).toBe("unknown");
  });
});

describe("Workday My Information — autofill", () => {
  it("fills text fields, the country & work-auth dropdowns, and the sponsorship radio", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(val("wd-first")).toBe("John");
    expect(val("wd-last")).toBe("Doe");
    expect(val("wd-email")).toBe("john@example.com");
    expect(val("wd-phone")).toBe("+1 555 555 5555");
    expect(val("wd-city")).toBe("Ottawa, ON, Canada");
    expect(val("wd-linkedin")).toBe("https://linkedin.com/in/johndoe");
    expect(document.getElementById("wd-country")!.textContent).toBe("Canada");
    expect(document.getElementById("wd-workauth")!.textContent).toBe("Yes");
    expect((document.querySelector('input[name="sponsorship"]:checked') as HTMLInputElement | null)?.value).toBe("No");
  });

  it("never writes into the resume file input", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    expect((document.getElementById("wd-resume") as HTMLInputElement).value).toBe("");
  });

  it("leaves EEO selects untouched when the toggle is off", async () => {
    mountWorkdayMyInfo(document);
    await autofill(MOCK_PROFILE, false);
    expect((document.getElementById("wd-gender") as HTMLSelectElement).value).toBe("");
    expect((document.getElementById("wd-ethnicity") as HTMLSelectElement).value).toBe("");
    expect((document.getElementById("wd-veteran") as HTMLSelectElement).value).toBe("");
  });
});

describe("Workday — EEO only when explicitly enabled", () => {
  it("fills an EEO select when the toggle is on AND the profile has the answer", async () => {
    mountWorkdayMyInfo(document);
    const withEeo: UserApplicationProfile = {
      ...MOCK_PROFILE,
      eeo: {
        gender: "Female",
        race: "Asian",
        hispanicLatino: "No",
        veteranStatus: "I am not a veteran",
        disabilityStatus: "No",
      },
    };
    await autofill(withEeo, true);
    expect((document.getElementById("wd-gender") as HTMLSelectElement).value).toBe("Female");
    expect((document.getElementById("wd-veteran") as HTMLSelectElement).value).toBe("I am not a veteran");
  });
});

describe("Workday — multi-step rescan", () => {
  it("re-detects fields after a step transition replaces the form", () => {
    mountWorkdayMyInfo(document);
    const first = scanPage(MOCK_PROFILE, false);
    expect(first.fields.some((f) => f.category === "firstName")).toBe(true);

    // Workday SPA navigation: the next step replaces the form subtree.
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.id = "cl-label";
    label.setAttribute("for", "cl");
    label.textContent = "Cover Letter";
    const ta = document.createElement("textarea");
    ta.id = "cl";
    ta.setAttribute("aria-labelledby", "cl-label");
    wrap.append(label, ta);
    document.body.append(wrap);

    const second = scanPage(MOCK_PROFILE, false);
    expect(second.fields.some((f) => f.category === "coverLetter")).toBe(true);
    expect(second.fields.some((f) => f.category === "firstName")).toBe(false);
  });
});
