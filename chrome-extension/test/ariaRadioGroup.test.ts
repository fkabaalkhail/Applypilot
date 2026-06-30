import { describe, it, expect, beforeEach } from "vitest";
import { scanPage } from "../src/content/formScanner";
import { writeControl, verifyControl } from "../src/content/writeEngine";

beforeEach(() => {
  document.body.innerHTML = "";
  (window.HTMLElement.prototype as unknown as { getClientRects: () => unknown }).getClientRects =
    () => [{ width: 10, height: 10 }];
});

/** An interactive ARIA radio group (react-aria / Radix style): role=radio divs
 *  that set aria-checked on themselves (and clear siblings) when clicked. */
function radioGroup(label: string, options: string[]): HTMLElement {
  const group = document.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const opt of options) {
    const radio = document.createElement("div");
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", "false");
    radio.setAttribute("data-value", opt);
    radio.textContent = opt;
    radio.addEventListener("click", () => {
      group.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute("aria-checked", "false"));
      radio.setAttribute("aria-checked", "true");
    });
    group.append(radio);
  }
  document.body.append(group);
  return group;
}

describe("ARIA radiogroup support", () => {
  it("detects a role=radiogroup as ariaRadioGroup with its options", () => {
    radioGroup("Will you require sponsorship?", ["Yes", "No"]);
    const { fields } = scanPage(null, false);
    const f = fields.find((x) => x.controlType === "ariaRadioGroup");
    expect(f).toBeDefined();
    expect(f!.options).toEqual(["Yes", "No"]);
  });

  it("fills the matching radio and verifies via aria-checked", () => {
    const group = radioGroup("Will you require sponsorship?", ["Yes", "No"]);
    const { registry } = scanPage(null, false);
    const id = group.getAttribute("data-ap-field")!;
    const control = registry.get(id)!;

    const res = writeControl(control, "No");
    expect(res.written).toBe(true);
    expect(verifyControl(control, "No")).toBe(true);
    expect(group.querySelector('[role="radio"][data-value="No"]')!.getAttribute("aria-checked")).toBe("true");
  });
});
