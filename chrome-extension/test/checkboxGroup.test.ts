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

// Most real ATS ("select all that apply" on Greenhouse/Lever/custom React forms)
// render the same pattern with plain <div>s, not a <fieldset>/[role=group] — the
// dominant real-world shape this engine must also catch.
function divSelectAllThatApply(question: string, options: string[]): void {
  const wrap = document.createElement("div");
  wrap.className = "question";
  const heading = document.createElement("div");
  heading.className = "question-text";
  heading.textContent = question;
  wrap.append(heading);
  const list = document.createElement("div");
  list.className = "options";
  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "option";
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = opt;
    label.append(cb, document.createTextNode(opt));
    item.append(label);
    list.append(item);
  }
  wrap.append(list);
  document.body.append(wrap);
}

describe("checkbox group — detection (no fieldset)", () => {
  it("scans a div-wrapped 'select all that apply' group as ONE checkboxGroup classified by its question", () => {
    divSelectAllThatApply("How did you hear about this opportunity? (select all that apply)", [
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
    expect(f.label).toBe("How did you hear about this opportunity? (select all that apply)");
  });
});

describe("checkbox group — fill (no fieldset)", () => {
  it("checks the matching options without 'Ambiguous checkbox value'", () => {
    divSelectAllThatApply("How did you hear about this opportunity?", ["LinkedIn", "Glassdoor", "Notion Blog"]);
    const { fields, registry } = scanPage(MOCK_PROFILE, false);
    const control = registry.get(fields[0].id)!;

    const res = writeControl(control, "LinkedIn, Glassdoor");
    expect(res.written).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(verifyControl(control, "LinkedIn, Glassdoor")).toBe(true);
    expect(checkedValues().sort()).toEqual(["Glassdoor", "LinkedIn"]);
  });
});

describe("checkbox group — no false grouping without a shared container", () => {
  it("keeps unrelated standalone checkboxes separate even when the page has other fields", () => {
    const name = document.createElement("input");
    name.type = "text";
    name.id = "fullName";
    document.body.append(name);

    const consent = document.createElement("label");
    const cb1 = document.createElement("input");
    cb1.type = "checkbox";
    cb1.id = "agree";
    consent.append(cb1, document.createTextNode("I agree to the terms"));
    document.body.append(consent);

    const newsletter = document.createElement("label");
    const cb2 = document.createElement("input");
    cb2.type = "checkbox";
    cb2.id = "subscribe";
    newsletter.append(cb2, document.createTextNode("Subscribe to newsletter"));
    document.body.append(newsletter);

    const { fields } = scanPage(MOCK_PROFILE, false);
    const checkboxFields = fields.filter((f) => f.controlType === "checkbox" || f.controlType === "checkboxGroup");
    expect(checkboxFields).toHaveLength(2);
    expect(checkboxFields.every((f) => f.controlType === "checkbox")).toBe(true);
  });
});
