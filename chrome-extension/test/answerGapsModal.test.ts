/**
 * The modal must offer the SAME control the page offers. Rendering every
 * question as a <select> meant a radio group's answer was picked from a
 * dropdown, and a combobox with no harvested options became a free-text box
 * whose typed answer the widget then rejected.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { gapInputHTML, readGapAnswer } from "../src/content/overlay";
import type { AnswerGap } from "../src/content/answerGaps";

const gap = (extra: Partial<AnswerGap> = {}): AnswerGap => ({
  fieldId: "f1",
  question: "Are you legally authorized to work in Canada?",
  controlType: "text",
  category: "unknown",
  options: [],
  required: true,
  sensitive: false,
  ...extra,
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("gapInputHTML", () => {
  it("renders a radio group as real radios, one per option", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(2);
    expect([...radios].map((r) => r.value)).toEqual(["Yes", "No"]);
    expect(root.querySelector("select")).toBeNull();
  });

  it("renders an ARIA radio group the same way", () => {
    const root = mount(gapInputHTML(gap({ controlType: "ariaRadioGroup", options: ["A", "B"] }), 0));
    expect(root.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it("renders a checkbox group as checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    expect(root.querySelectorAll('input[type="checkbox"]').length).toBe(3);
  });

  it("renders a dropdown for a select and a combobox with known options", () => {
    for (const controlType of ["select", "combobox", "customDropdown"] as const) {
      const root = mount(gapInputHTML(gap({ controlType, options: ["One", "Two"] }), 0));
      const sel = root.querySelector("select");
      expect(sel, controlType).not.toBeNull();
      expect(sel!.options.length).toBe(3); // placeholder + 2
      root.remove();
    }
  });

  it("renders a bare checkbox as a Yes/No pair", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkbox" }), 0));
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect([...radios].map((r) => r.value)).toEqual(["Yes", "No"]);
  });

  it("honours a date / number input hint", () => {
    const root = mount(gapInputHTML(gap({ inputType: "date" }), 0));
    expect(root.querySelector("input")!.getAttribute("type")).toBe("date");
  });
});

describe("readGapAnswer", () => {
  it("reads the checked radio", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked = true;
    expect(readGapAnswer(root, 0)).toBe("No");
  });

  it("joins the ticked checkboxes", () => {
    const root = mount(gapInputHTML(gap({ controlType: "checkboxGroup", options: ["X", "Y", "Z"] }), 0));
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes[0].checked = true;
    boxes[2].checked = true;
    expect(readGapAnswer(root, 0)).toBe("X, Z");
  });

  it("returns empty when nothing is chosen", () => {
    const root = mount(gapInputHTML(gap({ controlType: "radioGroup", options: ["Yes", "No"] }), 0));
    expect(readGapAnswer(root, 0)).toBe("");
  });

  it("reads a select and a text input", () => {
    const sel = mount(gapInputHTML(gap({ controlType: "select", options: ["One", "Two"] }), 0));
    sel.querySelector("select")!.value = "Two";
    expect(readGapAnswer(sel, 0)).toBe("Two");

    const txt = mount(gapInputHTML(gap({ controlType: "text" }), 1));
    txt.querySelector("input")!.value = "  Ottawa  ";
    expect(readGapAnswer(txt, 1)).toBe("Ottawa");
  });
});
