import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { stubLayout } from "./helpers/layout";
import { scanPage } from "../src/content/formScanner";
import { MOCK_PROFILE } from "../src/api/mockProfile";
import { WD_REAL_DROPDOWNS } from "./fixtures/workdayReal";

let restore: () => void;
beforeAll(() => {
  restore = stubLayout();
});
afterAll(() => restore());
beforeEach(() => {
  document.body.innerHTML = "";
});

/** Real Workday "My Information" dropdowns — the exact widgets that fail in
 *  production autofill_reports. All three are choice controls; none must be
 *  treated as a free-text input (which silently "fills" without selecting). */
describe("Workday real dropdowns are detected as choice controls", () => {
  function fieldByLabel(label: string) {
    document.body.innerHTML = WD_REAL_DROPDOWNS;
    const { fields } = scanPage(MOCK_PROFILE, false);
    return fields.find((f) => f.label.toLowerCase().includes(label));
  }

  it("Country Phone Code (selectinput multiselect) is a combobox, not a text field", () => {
    const f = fieldByLabel("country phone code");
    expect(f, "country phone code field detected").toBeTruthy();
    expect(f!.controlType).toBe("combobox");
  });

  it("Phone Device Type (button[aria-haspopup=listbox]) is a combobox", () => {
    const f = fieldByLabel("phone device type");
    expect(f, "phone device type field detected").toBeTruthy();
    expect(f!.controlType).toBe("combobox");
  });

  it("How Did You Hear (button[aria-haspopup=listbox]) is a combobox", () => {
    const f = fieldByLabel("how did you hear");
    expect(f, "how did you hear field detected").toBeTruthy();
    expect(f!.controlType).toBe("combobox");
  });
});
