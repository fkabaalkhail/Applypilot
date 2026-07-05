import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

/** A Workday-style text field: a stable element `id`, wrapped in a data-automation-id. */
function workdayField(id: string, label: string, automationId: string): string {
  return `<div data-automation-id="formField-${automationId}">
    <label for="${id}">${label}</label>
    <input id="${id}" data-automation-id="${automationId}" type="text">
  </div>`;
}

const idOf = (label: string) => {
  const { fields } = scanPage(MOCK_PROFILE, false);
  return fields.find((f) => f.label.toLowerCase().includes(label))?.id;
};

describe("field ids survive a Workday-style re-render", () => {
  it("re-rendered element (new node, same id) keeps the SAME field id", () => {
    document.body.innerHTML = workdayField("wd-email", "Email", "email");
    const first = idOf("email");
    expect(first).toBeTruthy();

    // Workday replaces the whole field subtree on a step change: a brand-new
    // element with the same stable id/automation-id but WITHOUT our stamped attr.
    document.body.innerHTML = workdayField("wd-email", "Email", "email");
    const second = idOf("email");
    expect(second).toBe(first); // was previously a fresh counter id → "Field no longer found"
  });

  it("two distinct fields get distinct ids", () => {
    document.body.innerHTML =
      workdayField("wd-first", "First Name", "firstName") + workdayField("wd-last", "Last Name", "lastName");
    const { fields } = scanPage(MOCK_PROFILE, false);
    const ids = fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a field with no stable identifier still gets an id (counter fallback)", () => {
    document.body.innerHTML = `<label>Comments<textarea></textarea></label>`;
    const { fields } = scanPage(MOCK_PROFILE, false);
    expect(fields.length).toBe(1);
    expect(fields[0].id).toBeTruthy();
  });
});
