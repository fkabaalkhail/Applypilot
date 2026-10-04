/**
 * Whether a control holds an answer decides whether a filled page turns by
 * itself or waits. Found by the Workday replica (one Autofill click to
 * Review, 2026-10-03): every radio group read as EMPTY, answered or not, so
 * the flow waited on every page with a required one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { holdsNoAnswer } from "../src/content/flowChecks";
import type { RuntimeControl } from "../src/content/formScanner";

beforeEach(() => { document.body.innerHTML = ""; });
const noCombobox = (): string | undefined => undefined;

function radios(checkedIx: number | null): RuntimeControl {
  document.body.innerHTML = `<fieldset><legend>Have you previously worked for Acme?</legend>
    <input type="radio" name="prev" value="Yes"><input type="radio" name="prev" value="No"></fieldset>`;
  const rs = [...document.querySelectorAll<HTMLInputElement>("input")];
  if (checkedIx !== null) rs[checkedIx].checked = true;
  return { id: "g", controlType: "radioGroup", radios: rs };
}

describe("holdsNoAnswer", () => {
  it("an answered radio group holds its answer", () => {
    expect(holdsNoAnswer(radios(1), noCombobox)).toBe(false);
  });
  it("an unanswered radio group is empty", () => {
    expect(holdsNoAnswer(radios(null), noCombobox)).toBe(true);
  });
  it("a checkbox group with a box ticked holds an answer", () => {
    document.body.innerHTML = `<input type="checkbox" value="a"><input type="checkbox" value="b">`;
    const boxes = [...document.querySelectorAll<HTMLInputElement>("input")];
    const group: RuntimeControl = { id: "c", controlType: "checkboxGroup", checkboxes: boxes };
    expect(holdsNoAnswer(group, noCombobox)).toBe(true);
    boxes[0].checked = true;
    expect(holdsNoAnswer(group, noCombobox)).toBe(false);
  });
  it("a combobox is judged by what the widget shows, not its empty input", () => {
    const el = document.createElement("input");
    const control: RuntimeControl = { id: "x", controlType: "combobox", el };
    expect(holdsNoAnswer(control, () => "Company Website")).toBe(false);
    expect(holdsNoAnswer(control, () => undefined)).toBe(true);
  });
  it("text and select controls by their value", () => {
    const input = document.createElement("input");
    expect(holdsNoAnswer({ id: "t", controlType: "text", el: input }, noCombobox)).toBe(true);
    input.value = "Marcus";
    expect(holdsNoAnswer({ id: "t", controlType: "text", el: input }, noCombobox)).toBe(false);
    document.body.innerHTML = `<select><option value="">Select One</option><option value="tx">Texas</option></select>`;
    const sel = document.querySelector("select")!;
    expect(holdsNoAnswer({ id: "s", controlType: "select", el: sel }, noCombobox)).toBe(true);
    sel.value = "tx";
    expect(holdsNoAnswer({ id: "s", controlType: "select", el: sel }, noCombobox)).toBe(false);
  });
});
