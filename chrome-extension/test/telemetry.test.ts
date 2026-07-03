import { describe, it, expect } from "vitest";
import { buildAutofillTelemetry } from "../src/content/telemetry";
import type { DetectedField } from "../src/shared/types";
import type { FieldReport } from "../src/content/reconciler";

const f = (id: string, label: string, category = "unknown"): DetectedField =>
  ({ id, label, category } as unknown as DetectedField);

const rep = (fieldId: string, ok: boolean, reason?: string): FieldReport => ({
  fieldId,
  ok,
  status: ok ? "stable" : "drifted",
  reason,
  attempts: 1,
});

describe("buildAutofillTelemetry", () => {
  it("summarizes filled vs failed with labels + reasons", () => {
    const fields = [f("a", "First Name", "firstName"), f("b", "Work Authorization")];
    const reports = [rep("a", true), rep("b", false, "No option matches")];

    const t = buildAutofillTelemetry(
      fields,
      { host: "boards.greenhouse.io", url: "https://x/y", atsType: "greenhouse" },
      reports,
      []
    );

    expect(t.totalFields).toBe(2);
    expect(t.filled).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.failedFields).toEqual([
      { label: "Work Authorization", category: "unknown", reason: "No option matches" },
    ]);
    expect(t.host).toBe("boards.greenhouse.io");
    expect(t.atsType).toBe("greenhouse");
  });

  it("counts a field ok if ANY pass filled it (local miss, later hit)", () => {
    const fields = [f("a", "Country", "country")];
    const reports = [rep("a", false, "No option matches")]; // local pass missed
    const outcomes = [{ fieldId: "a", ok: true }]; // combobox/AI pass filled it

    const t = buildAutofillTelemetry(fields, { host: "h", url: "u", atsType: "" }, reports, outcomes);

    expect(t.filled).toBe(1);
    expect(t.failed).toBe(0);
    expect(t.failedFields).toEqual([]);
  });

  it("emits only label/category/reason — never user values", () => {
    const fields = [f("a", "Some Question")];
    const t = buildAutofillTelemetry(
      fields,
      { host: "h", url: "u", atsType: "" },
      [rep("a", false, "cannot be scripted")],
      []
    );
    expect(Object.keys(t.failedFields[0]).sort()).toEqual(["category", "label", "reason"]);
  });
});
