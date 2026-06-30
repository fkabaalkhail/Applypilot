import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mountAshbyForm,
  mountWorkableForm,
  mountSmartRecruitersForm,
  mountJobviteForm,
  mountRipplingForm,
  mountBullhornForm,
} from "./fixtures/medium";
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

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
const singleValue = (wrapId: string) =>
  document.getElementById(wrapId)!.querySelector(".select__single-value")!.textContent;
const cats = () => new Set(scanPage(MOCK_PROFILE, false).fields.map((f) => f.category));

describe("Ashby", () => {
  it("detects + fills text, react-select country; skips resume + EEO", async () => {
    mountAshbyForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("email") && c.has("location") && c.has("resumeUpload")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("ashby-firstname")).toBe("John");
    expect(val("ashby-email")).toBe("john@example.com");
    expect(singleValue("ashby-country")).toBe("Canada");
    expect(val("ashby-resume")).toBe("");
    expect(val("ashby-gender")).toBe("");
  });
});

describe("Workable", () => {
  it("detects + fills text and react-select country", async () => {
    mountWorkableForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("email") && c.has("phone")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("workable-firstname")).toBe("John");
    expect(val("workable-phone")).toBe("+1 555 555 5555");
    expect(singleValue("workable-country")).toBe("Canada");
  });
});

describe("SmartRecruiters", () => {
  it("fills standard fields and leaves a custom question unknown/unfilled", async () => {
    mountSmartRecruitersForm(document);
    const fields = scanPage(MOCK_PROFILE, false).fields;
    const custom = fields.find((f) => f.label.toLowerCase().includes("excites you"));
    expect(custom?.category).toBe("unknown");
    await runAutofill(MOCK_PROFILE, false);
    expect(val("sr-firstname")).toBe("John");
    expect(val("sr-lastname")).toBe("Doe");
    expect(val("sr-email")).toBe("john@example.com");
    expect(val("sr-custom")).toBe(""); // unknown → never auto-filled
  });
});

describe("Jobvite", () => {
  it("fills text and the ARIA radiogroup (sponsorship = No); skips EEO", async () => {
    mountJobviteForm(document);
    const c = cats();
    expect(c.has("firstName") && c.has("sponsorship")).toBe(true);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("jobvite-firstname")).toBe("John");
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-value")).toBe("No");
    expect(val("jobvite-gender")).toBe("");
  });
});

describe("Rippling", () => {
  it("fills clean React text fields", async () => {
    mountRipplingForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("rippling-firstname")).toBe("John");
    expect(val("rippling-lastname")).toBe("Doe");
    expect(val("rippling-email")).toBe("john@example.com");
    expect(val("rippling-phone")).toBe("+1 555 555 5555");
  });
});

describe("Bullhorn", () => {
  it("fills simple standard fields", async () => {
    mountBullhornForm(document);
    await runAutofill(MOCK_PROFILE, false);
    expect(val("bullhorn-firstname")).toBe("John");
    expect(val("bullhorn-lastname")).toBe("Doe");
    expect(val("bullhorn-email")).toBe("john@example.com");
    expect(val("bullhorn-phone")).toBe("+1 555 555 5555");
  });
});
