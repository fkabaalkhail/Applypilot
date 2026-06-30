import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mountWorkdayMyInfo } from "./fixtures/workday";
import { stubLayout } from "./helpers/layout";
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
