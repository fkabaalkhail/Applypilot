import { describe, it, expect, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";

beforeEach(() => {
  document.body.innerHTML = "";
});

/** A combobox with a mounted listbox and an aria-label (so the scanner's
 *  relaxed-visibility path accepts it under jsdom, which reports zero rects). */
function labeledCombobox(
  options: string[],
  opts: { label: string; value?: string }
): void {
  const wrap = document.createElement("div");
  wrap.className = "select";
  const input = document.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", opts.label);
  const lbId = `lb-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("aria-controls", lbId);
  if (opts.value) {
    const sv = document.createElement("div");
    sv.className = "select__single-value";
    sv.textContent = opts.value;
    wrap.append(sv);
  }
  const lb = document.createElement("div");
  lb.id = lbId;
  lb.setAttribute("role", "listbox");
  for (const label of options) {
    const o = document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = label;
    lb.append(o);
  }
  wrap.append(input, lb);
  document.body.append(wrap);
}

describe("scanPage — custom dropdowns", () => {
  it("surfaces a combobox's options and committed value", () => {
    labeledCombobox(["United States", "Canada"], { label: "Country", value: "Canada" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.options).toEqual(["United States", "Canada"]);
    expect(combo!.currentValue).toBe("Canada");
  });

  it("reads options for an empty combobox and leaves currentValue undefined", () => {
    labeledCombobox(["Yes", "No"], { label: "Authorized to work?" });
    const { fields } = scanPage(null, false);
    const combo = fields.find((f) => f.controlType === "combobox");
    expect(combo).toBeDefined();
    expect(combo!.options).toEqual(["Yes", "No"]);
    expect(combo!.currentValue).toBeUndefined();
  });
});

describe("driver tagging", () => {
  it("tags a react-select control and marks it fillable", () => {
    document.body.innerHTML = `
      <label for="react-select-2-input">Country</label>
      <div class="rs__container"><div class="rs__control">
        <input id="react-select-2-input" role="combobox" aria-controls="lb" aria-expanded="false" />
      </div></div>`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    expect(field).toBeTruthy();
    const control = registry.get(field!.id);
    expect(control?.driver).toBe("react-select");
    expect(field!.fillable).toBe(true);
  });

  it("leaves a plain ARIA combobox untagged", () => {
    document.body.innerHTML = `
      <label for="c">City</label>
      <input id="c" role="combobox" aria-controls="lb2" aria-expanded="false" />`;
    const { fields, registry } = scanPage(null, false);
    const field = fields.find((f) => f.controlType === "combobox");
    const control = field ? registry.get(field.id) : undefined;
    expect(control?.driver).toBeUndefined();
  });
});
