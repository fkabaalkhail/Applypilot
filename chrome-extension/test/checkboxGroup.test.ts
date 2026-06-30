import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import type { UserApplicationProfile } from "../src/shared/types";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

function selectAllThatApply(legend: string, options: string[]): void {
  const fs = document.createElement("fieldset");
  const lg = document.createElement("legend");
  lg.textContent = legend;
  fs.append(lg);
  for (const opt of options) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = opt;
    cb.name = "q[]";
    label.append(cb, document.createTextNode(opt));
    fs.append(label);
  }
  document.body.append(fs);
}

const checkedValues = () =>
  Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map((c) => (c as HTMLInputElement).value);

describe("checkbox group — detection", () => {
  it("scans a 'select all that apply' fieldset as ONE checkboxGroup classified by its question", () => {
    selectAllThatApply("How did you hear about this opportunity? (select all that apply)", [
      "LinkedIn",
      "Glassdoor",
      "Notion Blog",
      "Conference or Meetup",
    ]);
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields).toHaveLength(1);
    const f = fields[0];
    expect(f.controlType).toBe("checkboxGroup");
    expect(f.category).toBe("unknown"); // the question, not the option text
    expect(f.options).toEqual(["LinkedIn", "Glassdoor", "Notion Blog", "Conference or Meetup"]);
    expect(f.proposedValue).toBeNull(); // never writes a profile URL into it
  });
});

describe("checkbox group — fill", () => {
  it("checks the matching options without 'Ambiguous checkbox value'", () => {
    selectAllThatApply("How did you hear about this opportunity?", ["LinkedIn", "Glassdoor", "Notion Blog"]);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const control = registry.get(fields[0].id)!;

    const res = writeControl(control, "LinkedIn, Glassdoor");
    expect(res.written).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(verifyControl(control, "LinkedIn, Glassdoor")).toBe(true);
    expect(checkedValues().sort()).toEqual(["Glassdoor", "LinkedIn"]);
  });

  it("checks a single option for a single-value answer", () => {
    selectAllThatApply("How did you hear about us?", ["LinkedIn", "Glassdoor", "Notion Blog"]);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const control = registry.get(fields[0].id)!;
    expect(writeControl(control, "Notion Blog").written).toBe(true);
    expect(checkedValues()).toEqual(["Notion Blog"]);
  });
});

describe("standalone checkbox — unchanged", () => {
  it("a lone checkbox (no fieldset) stays a single boolean", () => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "relocate";
    label.append(cb, document.createTextNode("Willing to relocate"));
    document.body.append(label);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const f = fields[0];
    expect(f.controlType).toBe("checkbox");
    expect(writeControl(registry.get(f.id)!, "Yes").written).toBe(true);
    expect((document.getElementById("relocate") as HTMLInputElement).checked).toBe(true);
  });
});

describe("EEO checkbox group — gated", () => {
  it("is sensitive and skipped unless the EEO toggle is on", () => {
    selectAllThatApply("Race/Ethnicity (select all that apply)", ["Asian", "White", "Decline to self-identify"]);
    const off = scanPage(MOCK_PROFILE, false).fields[0];
    expect(off.category).toBe("eeoRace");
    expect(off.sensitive).toBe(true);
    expect(off.proposedValue).toBeNull();

    const withEeo: UserApplicationProfile = { ...MOCK_PROFILE, eeo: { race: "Asian" } };
    const on = scanPage(withEeo, true).fields[0];
    expect(on.proposedValue).toBe("Asian");
  });
});
