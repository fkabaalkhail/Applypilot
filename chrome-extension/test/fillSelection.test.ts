/**
 * A fill pass adds rows itself ("Add education" / "Add experience" for the
 * profile's entries). Those rows did not exist when the user clicked Autofill,
 * so they were never in the picked ids and stayed empty (Workable, live
 * 2026-10-03). They are now filled by default; fields the user SAW and
 * deselected stay unfilled.
 */
import { describe, expect, it } from "vitest";
import { fillSelection } from "../src/shared/selection";
import type { DetectedField } from "../src/shared/types";

const f = (id: string, over: Partial<DetectedField> = {}): DetectedField => ({
  id,
  category: "school",
  confidence: 0.95,
  label: id,
  controlType: "text",
  required: false,
  proposedValue: "University of Waterloo",
  fillable: true,
  sensitive: false,
  ...over,
});

describe("fillSelection", () => {
  it("adds rows created after the click, keeps the user's deselection", () => {
    const fields = [f("name"), f("deselected"), f("new-school-row")];
    const picked = ["name"];
    const known = new Set(["name", "deselected"]);
    expect([...fillSelection(fields, picked, known)].sort()).toEqual(["name", "new-school-row"]);
  });
  it("a new field with nothing to fill is not added", () => {
    const fields = [f("name"), f("new-empty", { proposedValue: null })];
    expect([...fillSelection(fields, ["name"], new Set(["name"]))]).toEqual(["name"]);
  });
  it("flow steps (no picked ids) use the default selection", () => {
    expect([...fillSelection([f("a"), f("b", { proposedValue: null })], null, null)]).toEqual(["a"]);
  });
});
